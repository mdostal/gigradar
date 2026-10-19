// pantheon-adapter story (PANT-1207). Drives the adapter against the REAL
// runRadar() -> gate() -> recordScan() path with a network-free test-double
// source, so every reason asserted below is one the real gate produced —
// the point being that the explanation survives the API boundary unchanged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Gig } from "../../types.js";
import { gate } from "../../matching/gate.js";
import { registerSource } from "../../sources/source.js";
import { closeDb, createAdapterRun, getDb, getDraft, listDrafts, saveDraft } from "../../store/index.js";
import { AdapterError, getRunStatus, getShortlist, inFlightRun, stageDraft, startRun, type AdapterDeps } from "../adapter.js";

let nextGigs: Gig[] = [];
let fetchGate: Promise<void> | undefined;
registerSource({
  id: "pantheon-adapter-test-source",
  label: "Pantheon adapter (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    await fetchGate;
    return nextGigs;
  },
});

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-pantheon-adapter-test-"));
  // The adapter (like every Server Action) calls the store with no explicit
  // db, so point the default path at this test's own throwaway file.
  process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
  db = getDb();
  nextGigs = [];
  fetchGate = undefined;
});

afterEach(async () => {
  await inFlightRun();
  closeDb();
  delete process.env.GIGRADAR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    profile: { name: "Test User", roles: ["Fractional CTO"], skills: ["platform engineering"], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: {
          engagementProfiles: [
            {
              id: "fractional",
              label: "Fractional",
              types: ["contract", "fractional"],
              minRate: 200,
              highRate: 300,
              maxHours: 20,
              maxHoursAtHighRate: 30,
              rateUnit: "hour",
            },
          ],
          freshStageOnly: false,
          remoteOnly: true,
        },
      },
    ],
    sources: [{ id: "pantheon-adapter-test-source", enabled: true }],
  };
}

function makeGig(externalId: string, overrides: Partial<Gig> = {}): Gig {
  return {
    sourceId: "pantheon-adapter-test-source",
    externalId,
    title: "Fractional CTO",
    url: `https://example.com/jobs/${externalId}`,
    description: "platform engineering leadership",
    rate: { min: 250, max: 250, unit: "hour" },
    weeklyHours: 15,
    remote: true,
    raw: { secretish: "never returned" },
    ...overrides,
  };
}

const deps: AdapterDeps = {
  loadConfigFn: makeConfig,
  registerSourcesFn: async () => {},
  resolveSecretsFn: async () => ({}),
};

async function runToCompletion(d: AdapterDeps = deps) {
  const { run } = startRun(d);
  await inFlightRun();
  return getRunStatus(run.id);
}

describe("startRun / getRunStatus", () => {
  it("runs the real pipeline in the background and reports a succeeded run with counts", async () => {
    nextGigs = [makeGig("ok"), makeGig("onsite", { remote: false })];
    const { run, started } = startRun(deps);
    expect(started).toBe(true);
    expect(run.status).toBe("running");

    await inFlightRun();
    const done = getRunStatus(run.id);
    expect(done).toMatchObject({ status: "succeeded", sourcesTotal: 1, passedCount: 1, rejectedCount: 1, newCount: 2, errors: [] });
    expect(done.finishedAt).not.toBeNull();
    expect(getRunStatus().id).toBe(run.id);
  });

  it("refuses a second run while one is in flight, returning the running one", async () => {
    let release!: () => void;
    fetchGate = new Promise((r) => (release = r));
    const first = startRun(deps);
    const second = startRun(deps);
    expect(second.started).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    release();
    await inFlightRun();
    expect(startRun(deps).started).toBe(true);
  });

  it("settles as failed with the loader's own message when config can't load", async () => {
    const run = await runToCompletion({
      ...deps,
      loadConfigFn: () => {
        throw new Error('gigradar config: no config.json found at "/x/config.json".');
      },
    });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no config.json found");
  });

  it("settles as failed when the secrets facade can't resolve a mapped credential", async () => {
    const run = await runToCompletion({
      ...deps,
      resolveSecretsFn: async () => {
        throw new Error('pantheon secrets: inject for tags "provider=x" failed (HTTP 502)');
      },
    });
    expect(run).toMatchObject({ status: "failed", error: 'pantheon secrets: inject for tags "provider=x" failed (HTTP 502)' });
  });

  it("reports per-source errors on a succeeded run rather than hiding them as zero results", async () => {
    const run = await runToCompletion({
      ...deps,
      loadConfigFn: () => ({ ...makeConfig(), sources: [{ id: "pantheon-adapter-test-source", enabled: true }, { id: "not-registered", enabled: true }] }),
    });
    expect(run.status).toBe("succeeded");
    expect(run.errors).toEqual([{ sourceId: "not-registered", message: "no such registered source" }]);
  });

  it("settles a running row left by a dead process as interrupted on read", () => {
    createAdapterRun("orphan", { db });
    expect(getRunStatus("orphan")).toMatchObject({ status: "interrupted", error: expect.stringContaining("restarted") });
  });

  it("404s an unknown run id", () => {
    expect(() => getRunStatus("nope")).toThrow(AdapterError);
  });
});

describe("getShortlist", () => {
  it("returns passed AND rejected gigs, each with the real gate's reasons verbatim", async () => {
    const ok = makeGig("ok");
    const onsite = makeGig("onsite", { remote: false });
    nextGigs = [ok, onsite];
    await runToCompletion();

    const { passed, rejected, run } = getShortlist();
    expect(run.status).toBe("succeeded");
    expect(passed.map((g) => g.key)).toEqual(["pantheon-adapter-test-source:ok"]);
    expect(rejected.map((g) => g.key)).toEqual(["pantheon-adapter-test-source:onsite"]);

    // Same reasons gate() itself returns for this gig/config — first, in order, unaltered.
    const cfg = makeConfig();
    const direct = gate(ok, cfg.groups[0]!.needs, cfg.profile, cfg.groups[0]!.roleArea);
    expect(passed[0]!.reasons.slice(0, direct.reasons.length)).toEqual(direct.reasons);
    expect(passed[0]!.checks.filter((c) => c.result === "pass").length).toBeGreaterThan(0);
    expect(passed[0]!.checks.some((c) => c.result === "fail")).toBe(false);

    expect(rejected[0]!.pass).toBe(false);
    expect(rejected[0]!.reasons).toContain("✗ not remote");
    expect(rejected[0]!.checks).toContainEqual({ result: "fail", text: "✗ not remote" });
    expect(rejected[0]!.status).toBe("new");
  });

  it("carries the listing's rate, hours and freshness, and the store's first/last seen", async () => {
    nextGigs = [makeGig("ok", { postedAt: "2026-10-01", stage: "fresh" }), makeGig("bare", { rate: undefined, weeklyHours: undefined })];
    await runToCompletion();
    const { passed, rejected } = getShortlist();
    const ok = passed.find((g) => g.externalId === "ok")!;
    expect(ok.rate).toEqual({ min: 250, max: 250, unit: "hour" });
    expect(ok.weeklyHours).toBe(15);
    expect(ok.remote).toBe(true);
    expect(ok.postedAt).toBe("2026-10-01");
    expect(ok.stage).toBe("fresh");
    expect(typeof ok.firstSeen).toBe("string");
    expect(typeof ok.lastSeen).toBe("string");
    // Not stated by the source → absent, never a made-up zero.
    const bare = [...passed, ...rejected].find((g) => g.externalId === "bare")!;
    expect("rate" in bare).toBe(false);
    expect("weeklyHours" in bare).toBe(false);
  });

  it("shows a staged draft read-only, and leaves it exactly as it was", async () => {
    nextGigs = [makeGig("ok"), makeGig("other")];
    await runToCompletion();
    saveDraft("pantheon-adapter-test-source:ok", { coverText: "Hello there", answers: { "Why you?": "Because." } });
    const before = getDraft("pantheon-adapter-test-source:ok");

    const { passed } = getShortlist();
    const ok = passed.find((g) => g.externalId === "ok")!;
    expect(ok.draft).toMatchObject({ status: "draft", coverText: "Hello there", answers: { "Why you?": "Because." }, submittedAt: null });
    expect(passed.find((g) => g.externalId === "other")!.draft).toBeUndefined();
    expect(getDraft("pantheon-adapter-test-source:ok")).toEqual(before);
  });

  it("never returns the source's raw payload", async () => {
    nextGigs = [makeGig("ok")];
    await runToCompletion();
    expect(JSON.stringify(getShortlist())).not.toContain("never returned");
  });

  it("serves a specific earlier run by id, unaffected by a later one", async () => {
    nextGigs = [makeGig("first")];
    const first = await runToCompletion();
    nextGigs = [makeGig("second")];
    await runToCompletion();
    expect(getShortlist(first.id).passed.map((g) => g.externalId)).toEqual(["first"]);
    expect(getShortlist().passed.map((g) => g.externalId)).toEqual(["second"]);
  });

  it("404s before any run has succeeded, and 409s a run that failed", async () => {
    expect(() => getShortlist()).toThrow(expect.objectContaining({ status: 404 }));
    const failed = await runToCompletion({ ...deps, loadConfigFn: () => { throw new Error("boom"); } });
    expect(() => getShortlist(failed.id)).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe("stageDraft", () => {
  it("refuses a gig that did not make the shortlist, without calling stageApplication", async () => {
    nextGigs = [makeGig("onsite", { remote: false })];
    await runToCompletion();
    const stageApplicationFn = vi.fn();
    await expect(stageDraft({ key: "pantheon-adapter-test-source:onsite" }, { ...deps, stageApplicationFn })).rejects.toMatchObject({ status: 422 });
    expect(stageApplicationFn).not.toHaveBeenCalled();
  });

  it("refuses when no LLM credential resolves, without calling stageApplication", async () => {
    nextGigs = [makeGig("ok")];
    await runToCompletion();
    const stageApplicationFn = vi.fn();
    await expect(stageDraft({ key: "pantheon-adapter-test-source:ok" }, { ...deps, stageApplicationFn })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("no LLM credential"),
    });
    expect(stageApplicationFn).not.toHaveBeenCalled();
  });

  it("404s a gig that is not in the run", async () => {
    nextGigs = [makeGig("ok")];
    await runToCompletion();
    await expect(stageDraft({ key: "pantheon-adapter-test-source:missing" }, deps)).rejects.toMatchObject({ status: 404 });
    expect(listDrafts({}, { db })).toEqual([]);
  });
});
