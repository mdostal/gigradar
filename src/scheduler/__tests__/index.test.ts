import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Cron } from "croner";

// raiseIssue() (notifications-epic) fires a real desktop notification --
// mocked here so the new describe block below never actually shells out to
// osascript/notify-send, same reasoning as issues.test.ts/auto-fire.test.ts.
vi.mock("../../lib/notify/desktop.js", () => ({ sendDesktopNotification: vi.fn(async () => undefined) }));
import type { ApplicationDraft } from "../../lib/apply/runner.js";
import { setEnvVar } from "../../lib/config/env-store.js";
import { gigKey } from "../../lib/store/index.js";
import type { Config, Gig, MatchResult, Tier } from "../../lib/types.js";
import {
  AUTO_DRAFT_CAP,
  DEFAULT_IDLE_RECHECK_MS,
  type SchedulerHandle,
  buildCycleConfig,
  deriveBaseIntervalMs,
  startScheduler,
} from "../index.js";
import { BackoffTracker } from "../backoff.js";

type RunRadarResult = {
  results: MatchResult[];
  passed: MatchResult[];
  errors: { sourceId: string; message: string; needsVerification?: boolean; blockedUrl?: string }[];
  newlyInsertedKeys: string[];
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    needs: {
      engagementProfiles: [
        {
          id: "any-hourly",
          label: "Any (hourly)",
          types: ["contract", "fractional", "contract-to-hire"],
          minRate: 0,
          highRate: 999_999,
          maxHours: 999,
          maxHoursAtHighRate: 999,
          rateUnit: "hour",
        },
        {
          id: "any-salaried",
          label: "Any (salaried)",
          types: ["full-time"],
          minRate: 0,
          highRate: 999_999_999,
          rateUnit: "year",
        },
      ],
      freshStageOnly: false,
      remoteOnly: false,
    },
    sources: [{ id: "braintrust", enabled: true }],
    ...overrides,
  };
}

function emptyResult(): RunRadarResult {
  return { results: [], passed: [], errors: [], newlyInsertedKeys: [] };
}

function makeGig(externalId: string, sourceId = "braintrust"): Gig {
  return { sourceId, externalId, title: `Gig ${externalId}`, url: `https://example.test/${sourceId}/${externalId}` };
}

function makeMatchResult(externalId: string, tier: Tier, sourceId = "braintrust"): MatchResult {
  return { gig: makeGig(externalId, sourceId), pass: true, reasons: [], score: 1, tier, matchedProfiles: [] };
}

let activeHandles: SchedulerHandle[] = [];

afterEach(() => {
  for (const handle of activeHandles) handle.stop();
  activeHandles = [];
  vi.restoreAllMocks();
});

/** Starts a scheduler and registers it for automatic stop() in afterEach — every test in this file uses this instead of calling startScheduler() directly, so no test ever leaks a live timer or Cron job into the next one. */
function start(options: Parameters<typeof startScheduler>[0]): SchedulerHandle {
  const handle = startScheduler(options);
  activeHandles.push(handle);
  return handle;
}

describe("deriveBaseIntervalMs", () => {
  it("derives the gap between a pattern's next two runs", () => {
    // Every second, 6-field (seconds-precision) pattern.
    const ms = deriveBaseIntervalMs("*/1 * * * * *", "UTC");
    expect(ms).toBe(1000);
  });

  it("derives an hourly cadence as 1 hour", () => {
    const ms = deriveBaseIntervalMs("0 * * * *", "UTC");
    expect(ms).toBe(60 * 60 * 1000);
  });
});

describe("buildCycleConfig", () => {
  it("replaces sources with the backoff-filtered set and leaves every other field + the original config untouched", () => {
    const config = makeConfig({ sources: [{ id: "a", enabled: true }, { id: "b", enabled: true }] });
    const tracker = new BackoffTracker({ baseIntervalMs: 1000, now: () => 0 });
    tracker.recordFailure("a");

    const cycleConfig = buildCycleConfig(config, tracker);

    expect(cycleConfig.sources).toEqual([{ id: "b", enabled: true }]);
    expect(cycleConfig).not.toBe(config);
    expect(config.sources).toHaveLength(2); // the original Config object is never mutated
    expect(cycleConfig.profile).toBe(config.profile);
  });
});

describe("startScheduler: idle behavior when Config.schedule is unset", () => {
  it("logs clearly, never calls exitFn, and keeps rechecking on idleRecheckMs — the default matches DEFAULT_IDLE_RECHECK_MS (1 hour)", async () => {
    expect(DEFAULT_IDLE_RECHECK_MS).toBe(60 * 60 * 1000);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitFn = vi.fn();
    const loadConfigFn = vi.fn(() => makeConfig({ schedule: undefined }));
    let capturedDelayMs: number | undefined;
    const scheduledFns: (() => void)[] = [];

    // Fires "instantly" (no real wait) while still recording the delay the
    // production code requested — proves the idle loop is wired to
    // idleRecheckMs without ever waiting on it for real.
    const setTimeoutFn = vi.fn((fn: () => void, ms: number) => {
      capturedDelayMs = ms;
      scheduledFns.push(fn);
      return {} as ReturnType<typeof setTimeout>;
    });

    start({ loadConfigFn, exitFn, setTimeoutFn, clearTimeoutFn: vi.fn() });

    expect(loadConfigFn).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Config.schedule is unset"));
    expect(capturedDelayMs).toBe(DEFAULT_IDLE_RECHECK_MS);

    // Manually fire the "hourly" recheck a few times (never real time) — each
    // recheck reloads Config and, since it's still unset, idles again.
    for (let i = 0; i < 3; i++) {
      const fn = scheduledFns.pop();
      fn?.();
    }
    expect(loadConfigFn).toHaveBeenCalledTimes(4);
    expect(exitFn).not.toHaveBeenCalled(); // never exits, no matter how many idle rechecks pass
  });

  it("transitions from idling to scheduled once a later recheck finds Config.schedule set", () => {
    let schedule: string | undefined;
    const loadConfigFn = vi.fn(() => makeConfig({ schedule }));
    const scheduledFns: (() => void)[] = [];
    const setTimeoutFn = vi.fn((fn: () => void) => {
      scheduledFns.push(fn);
      return {} as ReturnType<typeof setTimeout>;
    });
    const onScheduled = vi.fn();

    const handle = start({ loadConfigFn, setTimeoutFn, clearTimeoutFn: vi.fn(), onScheduled, exitFn: vi.fn() });
    expect(handle.getJob()).toBeUndefined(); // idling, nothing scheduled yet

    schedule = "*/1 * * * * *";
    const recheck = scheduledFns.pop();
    recheck?.();

    expect(handle.getJob()).toBeDefined();
    expect(onScheduled).toHaveBeenCalledTimes(1);
  });
});

describe("startScheduler: a valid Config.schedule fires runRadar at the scheduled cadence, in Profile.timezone", () => {
  it("creates the Cron job with the exact pattern and timezone from Config", () => {
    const config = makeConfig({ schedule: "*/2 * * * * *", profile: { name: "T", roles: [], skills: [], timezone: "America/Chicago" } });
    const handle = start({ loadConfigFn: () => config, runRadarFn: async () => emptyResult(), exitFn: vi.fn() });

    const job = handle.getJob() as Cron;
    expect(job).toBeDefined();
    expect(job.getPattern()).toBe("*/2 * * * * *");
    expect(job.options.timezone).toBe("America/Chicago");
  });

  it("fires a real scan at a short real-time interval without any manual trigger (proves genuine croner wiring, not just our own test hooks)", async () => {
    const config = makeConfig({ schedule: "*/1 * * * * *" });
    const runRadarFn = vi.fn(async () => emptyResult());

    start({ loadConfigFn: () => config, runRadarFn, exitFn: vi.fn() });

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(runRadarFn.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 5000);

  it("job.trigger() fires runRadarFn immediately with the (backoff-filtered) cycle Config — used by the rest of this suite to avoid real scheduling delays", async () => {
    const config = makeConfig({ sources: [{ id: "braintrust", enabled: true }] });
    const runRadarFn = vi.fn(async (_config: Config): Promise<RunRadarResult> => emptyResult());
    const handle = start({
      loadConfigFn: () => ({ ...config, schedule: "*/1 * * * * *" }),
      runRadarFn,
      exitFn: vi.fn(),
    });

    await (handle.getJob() as Cron).trigger();

    expect(runRadarFn).toHaveBeenCalledTimes(1);
    expect(runRadarFn.mock.calls[0]?.[0]?.sources).toEqual([{ id: "braintrust", enabled: true }]);
  });
});

describe("startScheduler: per-source backoff filtering across cycles", () => {
  it("excludes a failing source from the Config passed to runRadar() while it's in its backoff window, and retries it once the window elapses", async () => {
    const config = makeConfig({
      schedule: "*/1 * * * * *",
      sources: [{ id: "flaky", enabled: true }, { id: "healthy", enabled: true }],
    });

    let clock = 0;
    let call = 0;
    const runRadarFn = vi.fn(async (_config: Config): Promise<RunRadarResult> => {
      call += 1;
      if (call === 1) return { results: [], passed: [], errors: [{ sourceId: "flaky", message: "boom" }], newlyInsertedKeys: [] };
      return emptyResult();
    });

    const handle = start({ loadConfigFn: () => config, runRadarFn, now: () => clock, exitFn: vi.fn() });
    const job = handle.getJob() as Cron;
    // Base interval for "*/1 * * * * *" is 1000ms (see deriveBaseIntervalMs tests above).

    await job.trigger(); // cycle 1: flaky fails -> backs off for 1000ms
    expect(runRadarFn.mock.calls[0]?.[0]?.sources.map((s) => s.id)).toEqual(["flaky", "healthy"]);

    clock += 500; // still inside the 1000ms backoff window
    await job.trigger(); // cycle 2: flaky must be excluded
    expect(runRadarFn.mock.calls[1]?.[0]?.sources.map((s) => s.id)).toEqual(["healthy"]);

    clock += 501; // now past the backoff window (500 + 501 > 1000)
    await job.trigger(); // cycle 3: flaky is retried
    expect(runRadarFn.mock.calls[2]?.[0]?.sources.map((s) => s.id)).toEqual(["flaky", "healthy"]);
  });

  it("resets a source's backoff to the base interval once it succeeds again", async () => {
    const config = makeConfig({ schedule: "*/1 * * * * *", sources: [{ id: "flaky", enabled: true }] });
    let clock = 0;
    let call = 0;
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => {
      call += 1;
      if (call <= 2) return { results: [], passed: [], errors: [{ sourceId: "flaky", message: "boom" }], newlyInsertedKeys: [] };
      return emptyResult();
    });

    const handle = start({ loadConfigFn: () => config, runRadarFn, now: () => clock, exitFn: vi.fn() });
    const job = handle.getJob() as Cron;

    await job.trigger(); // fail 1: backs off 1000ms
    clock += 1001;
    await job.trigger(); // fail 2: backs off 2000ms
    expect(handle.getTracker()?.getState("flaky")?.intervalMs).toBe(2000);

    clock += 2001;
    await job.trigger(); // success: resets to base (1000ms), not staying at 2000ms
    const state = handle.getTracker()?.getState("flaky");
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.intervalMs).toBe(1000);
    expect(state?.backoffUntil).toBeNull();
  });
});

describe("startScheduler: never writes to config.json", () => {
  let tmpDataDir: string;
  let originalXdgDataHome: string | undefined;

  afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it("config.json on disk is byte-for-byte unchanged after several scan cycles, including cycles that filter a backed-off source", async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scheduler-test-"));
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpDataDir;
    const configPath = path.join(tmpDataDir, "gigradar", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const doc = JSON.stringify(makeConfig({ sources: [{ id: "flaky", enabled: true }] }));
    fs.writeFileSync(configPath, doc, { mode: 0o600 });
    const bytesBefore = fs.readFileSync(configPath);

    let clock = 0;
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: [],
      passed: [],
      errors: [{ sourceId: "flaky", message: "boom" }],
      newlyInsertedKeys: [],
    }));
    // loadConfigFn here reads the exact same doc a real loadConfig() would
    // parse, but bypasses the vault/encryption layer (irrelevant to this
    // regression) — the point under test is what the SCHEDULER does with the
    // Config afterward, never that config.json is re-serialized.
    const config: Config = JSON.parse(doc);
    const handle = start({ loadConfigFn: () => config, runRadarFn, now: () => clock, exitFn: vi.fn() });
    const job = handle.getJob();
    expect(job).toBeUndefined(); // no schedule set in this fixture -> idling, not scheduled

    // Drive a few idle rechecks too, for good measure — still never writes.
    for (let i = 0; i < 3; i++) {
      clock += 1;
    }

    const bytesAfter = fs.readFileSync(configPath);
    expect(bytesAfter).toEqual(bytesBefore);
  });
});

describe("startScheduler: top-level fatal error boundary", () => {
  it("an exception outside runRadar()'s own per-source handling logs fatally and calls exitFn(1)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = makeConfig({ schedule: "*/1 * * * * *" });
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => {
      throw new Error("simulated top-level fault (not a per-source error)");
    });
    const exitFn = vi.fn();

    const handle = start({ loadConfigFn: () => config, runRadarFn, exitFn });
    const job = handle.getJob() as Cron;

    await job.trigger();

    expect(exitFn).toHaveBeenCalledWith(1);
  });

  it("a malformed cron expression is a fatal, actionable error at activation time, not a silent no-op", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = makeConfig({ schedule: "not a valid cron expression" });
    const exitFn = vi.fn();

    start({ loadConfigFn: () => config, runRadarFn: async () => emptyResult(), exitFn });

    expect(exitFn).toHaveBeenCalledWith(1);
  });

  it("loadConfigFn throwing (e.g. a corrupt config.json) is fatal, not swallowed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitFn = vi.fn();
    const loadConfigFn = vi.fn(() => {
      throw new Error("gigradar config: corrupt");
    });

    start({ loadConfigFn, runRadarFn: async () => emptyResult(), exitFn });

    expect(exitFn).toHaveBeenCalledWith(1);
  });
});

describe("startScheduler: auto-draft-on-scan (Config.autoDraftOnScan)", () => {
  const REAL_APPLY_PROFILE = { email: "jane@example.com" };

  // llm-credential-modes epic: runAutoDraft() resolves its credential via
  // resolveLlmCredential() -- a fresh disk read of the encrypted .env store
  // under XDG_DATA_HOME -- not process.env directly, so tests that need a
  // credential present write one via setEnvVar(). Deliberately does NOT
  // override XDG_DATA_HOME itself: this describe block's tests share the
  // SAME real getDb() singleton/connection across the whole file (no
  // closeDb() between tests here, unlike auto-fire.test.ts), relying on
  // vitest.setup.ts's single process-wide XDG_DATA_HOME temp dir staying
  // constant -- giving each test its own XDG_DATA_HOME would make the
  // shared connection's already-open db path mismatch the new test's
  // resolved path and throw ("already holds a connection open").
  //
  // XDG_CONFIG_HOME (the vault key's separate location) is likewise left
  // untouched here -- vitest.setup.ts now sets a single, process-wide
  // default for the WHOLE test run (llm-provider-harness epic,
  // custom-llm-source-credential-migration story), the SAME "constant for
  // the file's lifetime" property XDG_DATA_HOME's own shared default
  // already has. This describe block used to stub its OWN temp
  // XDG_CONFIG_HOME (deleted in its own afterAll) before that global
  // default existed -- found live, the hard way: once runCycle() itself
  // started calling resolveLlmCredential(), that per-describe-block stub
  // meant the encrypted .env file setEnvVar() writes into the SHARED
  // XDG_DATA_HOME here got encrypted under THIS block's own (since-deleted)
  // key, so every LATER test in this file that also resolves a credential
  // failed decrypting that same .env file under a DIFFERENT key ("the
  // authentication tag did not verify") -- a real key/data lifetime
  // mismatch, not a leaked-stub bug. One consistent key location for the
  // whole file, matching the data dir's own lifetime, is the actual fix.

  /** A stageApplicationFn stand-in that never makes a real Anthropic call — always resolves. Mirrors ApplicationDraft's real shape. */
  function fakeStageApplicationFn() {
    return vi.fn(async (r: MatchResult): Promise<ApplicationDraft> => ({
      gig: r.gig,
      content: { coverText: "Dear team...", answers: {} },
      status: "draft",
    }));
  }

  function autoDraftConfig(overrides: Partial<Config> = {}): Config {
    return makeConfig({
      schedule: "*/1 * * * * *",
      autoDraftOnScan: true,
      applyProfile: REAL_APPLY_PROFILE,
      ...overrides,
    });
  }

  it("Config.autoDraftOnScan unset or false: zero stageApplication() calls -- no behavior change from before this story", async () => {
    // No credential needed -- config.autoDraftOnScan is falsy in both cases
    // below, so runAutoDraft() returns before ever resolving one.
    const passed = [makeMatchResult("1", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));

    for (const overrides of [{}, { autoDraftOnScan: false }] as const) {
      const stageApplicationFn = fakeStageApplicationFn();
      const config = makeConfig({ schedule: "*/1 * * * * *", applyProfile: REAL_APPLY_PROFILE, ...overrides });
      const handle = start({ loadConfigFn: () => config, runRadarFn, stageApplicationFn, exitFn: vi.fn() });

      await (handle.getJob() as Cron).trigger();

      expect(stageApplicationFn).not.toHaveBeenCalled();
    }
  });

  it("autoDraftOnScan=true and no LLM credential set: exactly ONE log line naming the missing key, and zero stageApplication() calls -- no per-gig repetition", async () => {
    // No setEnvVar() call here -- the isolated XDG_DATA_HOME from this
    // describe block's beforeEach starts with no .env file at all, so
    // resolveLlmCredential() resolves undefined, same as a fresh install.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Three eligible green gigs -- proves the missing-key skip happens ONCE
    // for the whole cycle, not once per eligible gig.
    const passed = [makeMatchResult("1", "green"), makeMatchResult("2", "green"), makeMatchResult("3", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));
    const stageApplicationFn = fakeStageApplicationFn();
    const config = autoDraftConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, stageApplicationFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    const missingKeyLines = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("ANTHROPIC_API_KEY"),
    );
    expect(missingKeyLines).toHaveLength(1);
    expect(stageApplicationFn).not.toHaveBeenCalled();
  });

  it("autoDraftOnScan=true, ANTHROPIC_API_KEY set, and Config.applyProfile unset: exactly ONE log line naming the missing apply profile, and zero stageApplication() calls", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-api-key");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const passed = [makeMatchResult("1", "green"), makeMatchResult("2", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));
    const stageApplicationFn = fakeStageApplicationFn();
    const config = autoDraftConfig({ applyProfile: undefined });

    const handle = start({ loadConfigFn: () => config, runRadarFn, stageApplicationFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    const missingProfileLines = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && /apply profile/i.test(call[0]),
    );
    expect(missingProfileLines).toHaveLength(1);
    expect(stageApplicationFn).not.toHaveBeenCalled();
  });

  it("a gig that already has a draft (any status, e.g. 'rejected') is NOT re-drafted when found again as a green-tier match", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-api-key");
    const passed = [makeMatchResult("already-drafted", "green"), makeMatchResult("new", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));
    const stageApplicationFn = fakeStageApplicationFn();
    const draftedKey = gigKey("braintrust", "already-drafted");
    const getDraftFn = vi.fn((key: string) =>
      key === draftedKey
        ? {
            gigKey: key,
            content: { coverText: "", answers: {} },
            status: "rejected" as const,
            generatedAt: "2026-01-01T00:00:00.000Z",
            approvedAt: null,
            submittedAt: null,
          }
        : undefined,
    );
    const config = autoDraftConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, stageApplicationFn, getDraftFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    expect(stageApplicationFn).toHaveBeenCalledTimes(1);
    expect((stageApplicationFn.mock.calls[0]?.[0] as MatchResult).gig.externalId).toBe("new");
  });

  it("more than 5 eligible new green-tier gigs in one cycle: exactly 5 are drafted, not more", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-api-key");
    expect(AUTO_DRAFT_CAP).toBe(5);
    const passed = Array.from({ length: 8 }, (_, i) => makeMatchResult(`g${i}`, "green"));
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));
    const stageApplicationFn = fakeStageApplicationFn();
    const config = autoDraftConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, stageApplicationFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    expect(stageApplicationFn).toHaveBeenCalledTimes(5);
  });

  it("a yellow-tier or red-tier match in result.passed is never passed to stageApplication() by the auto-draft path", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-api-key");
    const passed = [makeMatchResult("yellow-gig", "yellow"), makeMatchResult("red-gig", "red"), makeMatchResult("green-gig", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));
    const stageApplicationFn = fakeStageApplicationFn();
    const config = autoDraftConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, stageApplicationFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    expect(stageApplicationFn).toHaveBeenCalledTimes(1);
    expect((stageApplicationFn.mock.calls[0]?.[0] as MatchResult).gig.externalId).toBe("green-gig");
  });

  it("one eligible gig's stageApplication() call fails (mocked): the OTHER eligible gigs in that same cycle still get drafted", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-api-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const passed = [makeMatchResult("fails", "green"), makeMatchResult("ok-1", "green"), makeMatchResult("ok-2", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));
    const stageApplicationFn = vi.fn(async (r: MatchResult): Promise<ApplicationDraft> => {
      if (r.gig.externalId === "fails") throw new Error("simulated per-gig draft failure");
      return { gig: r.gig, content: { coverText: "Dear team...", answers: {} }, status: "draft" };
    });
    const config = autoDraftConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, stageApplicationFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    // All 3 were attempted (the failure doesn't stop the loop)...
    expect(stageApplicationFn).toHaveBeenCalledTimes(3);
    const attemptedIds = stageApplicationFn.mock.calls.map((call) => (call[0] as MatchResult).gig.externalId);
    expect(attemptedIds).toEqual(["fails", "ok-1", "ok-2"]);
  });

  it("a successful auto-draft cycle's log output includes a one-line summary of how many gigs were auto-drafted", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-api-key");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const passed = [makeMatchResult("1", "green"), makeMatchResult("2", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));
    const stageApplicationFn = fakeStageApplicationFn();
    const config = autoDraftConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, stageApplicationFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^gigradar scheduler: 2 gig\(s\) auto-drafted this cycle\.$/));
  });
});

describe("startScheduler: notify-on-green-match (Config.notifyOnGreenMatch)", () => {
  function notifyConfig(overrides: Partial<Config> = {}): Config {
    return makeConfig({ schedule: "*/1 * * * * *", notifyOnGreenMatch: true, ...overrides });
  }

  function fakeNotifyFn() {
    return vi.fn(async (_n: { title: string; body: string }) => undefined);
  }

  it("Config.notifyOnGreenMatch unset or false: zero notify calls -- no behavior change from before this story", async () => {
    const passed = [makeMatchResult("1", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: passed,
      passed,
      errors: [],
      newlyInsertedKeys: [gigKey("braintrust", "1")],
    }));

    for (const overrides of [{}, { notifyOnGreenMatch: false }] as const) {
      const notifyFn = fakeNotifyFn();
      const config = makeConfig({ schedule: "*/1 * * * * *", ...overrides });
      const handle = start({ loadConfigFn: () => config, runRadarFn, notifyFn, exitFn: vi.fn() });

      await (handle.getJob() as Cron).trigger();

      expect(notifyFn).not.toHaveBeenCalled();
    }
  });

  it("a brand-new green-tier match fires exactly one notification naming the gig", async () => {
    const passed = [makeMatchResult("1", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: passed,
      passed,
      errors: [],
      newlyInsertedKeys: [gigKey("braintrust", "1")],
    }));
    const notifyFn = fakeNotifyFn();
    const config = notifyConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, notifyFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    expect(notifyFn).toHaveBeenCalledTimes(1);
    const [notification] = notifyFn.mock.calls[0] as [{ title: string; body: string }];
    expect(notification.body).toContain("Gig 1");
  });

  it("a green-tier match that ALREADY existed (not in newlyInsertedKeys) does NOT fire a notification, even though it's green", async () => {
    const passed = [makeMatchResult("1", "green")];
    // Empty newlyInsertedKeys -- this gig was seen before, just re-matched this cycle.
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({ results: passed, passed, errors: [], newlyInsertedKeys: [] }));
    const notifyFn = fakeNotifyFn();
    const config = notifyConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, notifyFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("a brand-new yellow-tier or red-tier match never fires a notification, even though it's newly inserted", async () => {
    const passed = [makeMatchResult("1", "yellow")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: passed,
      passed,
      errors: [],
      newlyInsertedKeys: [gigKey("braintrust", "1")],
    }));
    const notifyFn = fakeNotifyFn();
    const config = notifyConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, notifyFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    expect(notifyFn).not.toHaveBeenCalled();
  });

  it("multiple new green-tier matches in one cycle fire exactly ONE summarizing notification, not one per gig", async () => {
    const passed = [makeMatchResult("1", "green"), makeMatchResult("2", "green"), makeMatchResult("3", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: passed,
      passed,
      errors: [],
      newlyInsertedKeys: [gigKey("braintrust", "1"), gigKey("braintrust", "2"), gigKey("braintrust", "3")],
    }));
    const notifyFn = fakeNotifyFn();
    const config = notifyConfig();

    const handle = start({ loadConfigFn: () => config, runRadarFn, notifyFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    expect(notifyFn).toHaveBeenCalledTimes(1);
    const [notification] = notifyFn.mock.calls[0] as [{ title: string; body: string }];
    expect(notification.body).toContain("3 new matches");
  });

  it("a notifyFn rejection is logged and swallowed -- never fails the cycle", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const passed = [makeMatchResult("1", "green")];
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: passed,
      passed,
      errors: [],
      newlyInsertedKeys: [gigKey("braintrust", "1")],
    }));
    const notifyFn = vi.fn(async () => {
      throw new Error("simulated notification failure");
    });
    const config = notifyConfig();
    const exitFn = vi.fn();

    const handle = start({ loadConfigFn: () => config, runRadarFn, notifyFn, exitFn });
    await (handle.getJob() as Cron).trigger();

    expect(exitFn).not.toHaveBeenCalled(); // the cycle's fatal error boundary never fires
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("notify-on-green-match failed"));
  });
});

describe("startScheduler: runCycle raises an issue per source error (notifications-epic)", () => {
  // Own isolated db setup, unlike every other describe block above (which
  // never touch the store) -- mirrors src/scheduler/__tests__/auto-fire.test.ts's
  // own reasoning: raiseIssue() hits the real store via a bare getDb() call.
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scheduler-issues-test-"));
    vi.stubEnv("GIGRADAR_DB_PATH", path.join(tmpDir, "gigs.db"));
    const { closeDb } = await import("../../lib/store/db.js");
    closeDb(); // any earlier describe block's connection (if any) must not leak into this one's path
  });

  afterEach(async () => {
    const { closeDb } = await import("../../lib/store/db.js");
    closeDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a source fetch error raises exactly one open, severity=warning issue", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: [],
      passed: [],
      errors: [{ sourceId: "gofractional", message: "Cloudflare interstitial" }],
      newlyInsertedKeys: [],
    }));
    const config = makeConfig({ schedule: "*/1 * * * * *" });

    const handle = start({ loadConfigFn: () => config, runRadarFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    const { listIssues } = await import("../../lib/notify/issues.js");
    const open = listIssues({ open: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      severity: "warning",
      source: "runRadar:gofractional",
      title: "Source fetch failed",
      message: "Cloudflare interstitial",
    });
  });

  it("the same source erroring across multiple cycles raises only ONE issue (deduped), not one per cycle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: [],
      passed: [],
      errors: [{ sourceId: "gofractional", message: "Cloudflare interstitial" }],
      newlyInsertedKeys: [],
    }));
    const config = makeConfig({ schedule: "*/1 * * * * *" });

    const handle = start({ loadConfigFn: () => config, runRadarFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();
    await (handle.getJob() as Cron).trigger();
    await (handle.getJob() as Cron).trigger();

    const { listIssues } = await import("../../lib/notify/issues.js");
    expect(listIssues({ open: true })).toHaveLength(1);
  });

  it("a VerificationChallengeError-flagged error (needsVerification:true) raises a DISTINCT \"Needs human verification\" issue, not \"Source fetch failed\" (verification-copilot epic)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => ({
      results: [],
      passed: [],
      errors: [{
        sourceId: "gofractional",
        message: 'gigradar: source "gofractional" hit a verification challenge at "https://www.gofractional.com/job/123" — a human needs to clear it before this source can be scanned again.',
        needsVerification: true,
        blockedUrl: "https://www.gofractional.com/job/123",
      }],
      newlyInsertedKeys: [],
    }));
    const config = makeConfig({ schedule: "*/1 * * * * *" });

    const handle = start({ loadConfigFn: () => config, runRadarFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();

    const { listIssues } = await import("../../lib/notify/issues.js");
    const open = listIssues({ open: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      severity: "warning",
      source: "runRadar:gofractional",
      title: "Needs human verification",
      context: { sourceId: "gofractional", blockedUrl: "https://www.gofractional.com/job/123" },
    });
  });

  it("a verification-challenge issue and a generic fetch-failure issue for the SAME source never collide -- both can be open at once (distinct dedupe keys)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let call = 0;
    const runRadarFn = vi.fn(async (): Promise<RunRadarResult> => {
      call += 1;
      return {
        results: [],
        passed: [],
        errors:
          call === 1
            ? [{ sourceId: "gofractional", message: "some generic network failure", needsVerification: undefined, blockedUrl: undefined }]
            : [{ sourceId: "gofractional", message: "blocked", needsVerification: true, blockedUrl: "https://www.gofractional.com/job/123" }],
        newlyInsertedKeys: [],
      };
    });
    const config = makeConfig({ schedule: "*/1 * * * * *" });

    const handle = start({ loadConfigFn: () => config, runRadarFn, exitFn: vi.fn() });
    await (handle.getJob() as Cron).trigger();
    await (handle.getJob() as Cron).trigger();

    const { listIssues } = await import("../../lib/notify/issues.js");
    const open = listIssues({ open: true });
    expect(open.map((i) => i.title).sort()).toEqual(["Needs human verification", "Source fetch failed"]);
  });
});
