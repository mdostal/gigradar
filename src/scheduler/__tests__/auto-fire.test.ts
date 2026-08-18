// Scheduler-level integration tests for the graduated-auto-fire-trust
// epic's wiring into runAutoDraft() (story: autofire-scheduler-wiring).
// Uses a REAL temp SQLite db (mirrors src/lib/apply/__tests__/autofire.test.ts's
// own setup) since evaluateAutoFire()/getDraft()/getGig() all hit the real
// store -- unlike the notify-on-green-match tests in index.test.ts, which
// never touch the store at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// raiseIssue() (notifications-epic) fires a real desktop notification --
// mocked here so these tests never actually shell out to osascript/
// notify-send, same reasoning as src/lib/notify/__tests__/issues.test.ts.
vi.mock("../../lib/notify/desktop.js", () => ({ sendDesktopNotification: vi.fn(async () => undefined) }));

import type { ApplicationDraft } from "../../lib/apply/runner.js";
import { closeDb, getDb } from "../../lib/store/db.js";
import { recordScan } from "../../lib/store/gigs.js";
import { getDraft, saveDraft, setDraftStatus } from "../../lib/store/drafts.js";
import { listIssues } from "../../lib/notify/issues.js";
import { registerSubmitAdapter } from "../../lib/submit/adapter.js";
import { setEnvVar } from "../../lib/config/env-store.js";
import type { ApplyProfileConfig, Config, DraftContent, Gig, MatchResult } from "../../lib/types.js";
import { runAutoDraft } from "../index.js";

let tmpDir: string;
let keyTmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scheduler-autofire-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scheduler-autofire-test-key-"));
  // attemptAutoFire() (src/scheduler/index.ts) calls getGig()/getDraft()/
  // markDraftSubmitting()/evaluateAutoFire() etc. with NO explicit db
  // override -- unlike src/lib/apply/__tests__/autofire.test.ts, which
  // threads {db} through every call directly. GIGRADAR_DB_PATH is what
  // makes every one of those bare getDb() calls resolve to THIS test's temp
  // file instead of the real default path, so they all share one connection.
  const dbPath = path.join(tmpDir, "gigs.db");
  vi.stubEnv("GIGRADAR_DB_PATH", dbPath);
  // llm-credential-modes epic: runAutoDraft() now resolves its credential
  // via resolveLlmCredential() (a fresh disk read of the encrypted .env
  // store), not process.env directly -- so the test credential has to be
  // written the same way, via setEnvVar(), with XDG_DATA_HOME/XDG_CONFIG_HOME
  // pointed at isolated temp dirs (same pattern as env-store.test.ts) rather
  // than vi.stubEnv("ANTHROPIC_API_KEY", ...), which only sets process.env.
  vi.stubEnv("XDG_DATA_HOME", tmpDir);
  vi.stubEnv("XDG_CONFIG_HOME", keyTmpDir);
  setEnvVar("ANTHROPIC_API_KEY", "test-key");
  db = getDb();
});

afterEach(() => {
  vi.unstubAllEnvs();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

const APPLY_PROFILE: ApplyProfileConfig = { email: "me@example.test" };
const GOOD_CONTENT: DraftContent = {
  coverText: "Dear hiring team, I'm excited to apply for this fractional CTO role given my background.",
  answers: {},
};

function makeGig(sourceId: string, externalId: string, tier: Gig["tier"]): Gig {
  return { sourceId, externalId, tier, title: `Gig ${externalId}`, url: `https://example.test/${sourceId}/${externalId}` };
}

function seedGraduatingHistory(sourceId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const externalId = `history-${i}`;
    recordScan([{ sourceId, gigs: [makeGig(sourceId, externalId, "green")] }], { db, now: "2026-01-01T00:00:00.000Z" });
    const key = `${sourceId}:${externalId}`;
    saveDraft(key, GOOD_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    setDraftStatus(key, "approved", { db, now: "2026-01-01T00:00:00.000Z" });
  }
}

/** A fake stageApplicationFn that mimics the real stageApplication()'s only externally-visible effect this story cares about: a real saveDraft() row. */
function fakeStageApplicationFn() {
  return vi.fn(async (r: MatchResult): Promise<ApplicationDraft> => {
    const key = `${r.gig.sourceId}:${r.gig.externalId}`;
    saveDraft(key, GOOD_CONTENT, { db, now: "2026-01-02T00:00:00.000Z" });
    return { gig: r.gig, content: GOOD_CONTENT, status: "draft" };
  });
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    profile: { name: "t", roles: [], skills: [], timezone: "UTC" },
    needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false },
    sources: [],
    autoDraftOnScan: true,
    applyProfile: APPLY_PROFILE,
    ...overrides,
  };
}

function matchResultFor(gig: Gig): MatchResult {
  return { gig, pass: true, score: 1, reasons: [], tier: "green", matchedProfiles: [] };
}

describe("runAutoDraft: graduated-auto-fire-trust wiring", () => {
  it("config.autoFire unset -- complete no-op, draft stays 'draft', no adapter ever called", async () => {
    const sourceId = "src-no-autofire";
    recordScan([{ sourceId, gigs: [makeGig(sourceId, "1", "green")] }], { db, now: "2026-01-02T00:00:00.000Z" });
    const key = `${sourceId}:1`;
    const gig = makeGig(sourceId, "1", "green");
    const stageApplicationFn = fakeStageApplicationFn();
    const adapterSubmit = vi.fn(async () => ({ ok: true as const, confirmation: "n/a" }));
    registerSubmitAdapter({ id: sourceId, submit: adapterSubmit });

    const config = makeConfig(); // no autoFire section at all

    await runAutoDraft(config, [matchResultFor(gig)], stageApplicationFn, (k) => getDraft(k, { db }));

    expect(stageApplicationFn).toHaveBeenCalledTimes(1);
    expect(adapterSubmit).not.toHaveBeenCalled();
    expect(getDraft(key, { db })?.status).toBe("draft");
  });

  it("a stageApplicationFn failure raises a severity=warning issue (notifications-epic)", async () => {
    const sourceId = "src-draft-fails";
    recordScan([{ sourceId, gigs: [makeGig(sourceId, "1", "green")] }], { db, now: "2026-01-02T00:00:00.000Z" });
    const key = `${sourceId}:1`;
    const gig = makeGig(sourceId, "1", "green");
    const stageApplicationFn = vi.fn(async () => {
      throw new Error("Anthropic API rate limited");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runAutoDraft(makeConfig(), [matchResultFor(gig)], stageApplicationFn, (k) => getDraft(k, { db }));

    const openIssues = listIssues({ open: true }, { db });
    expect(openIssues).toHaveLength(1);
    expect(openIssues[0]).toMatchObject({
      severity: "warning",
      source: `autoDraft:${key}`,
      title: "Auto-draft failed",
      message: expect.stringContaining("Anthropic API rate limited"),
    });
  });

  it("a graduated, enabled pair with a registered adapter and a passing draft: draft -> submitting -> submitted, gig -> applied", async () => {
    const sourceId = "src-fires";
    seedGraduatingHistory(sourceId, 3); // reaches minApprovals: 3
    recordScan([{ sourceId, gigs: [makeGig(sourceId, "new-1", "green")] }], { db, now: "2026-01-02T00:00:00.000Z" });
    const key = `${sourceId}:new-1`;
    const gig = makeGig(sourceId, "new-1", "green");
    const stageApplicationFn = fakeStageApplicationFn();
    const adapterSubmit = vi.fn(async () => ({ ok: true as const, confirmation: "confirmed-abc" }));
    registerSubmitAdapter({ id: sourceId, submit: adapterSubmit });

    const config = makeConfig({
      autoFire: { rules: [{ sourceId, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    });

    await runAutoDraft(config, [matchResultFor(gig)], stageApplicationFn, (k) => getDraft(k, { db }));

    expect(adapterSubmit).toHaveBeenCalledTimes(1);
    expect(getDraft(key, { db })?.status).toBe("submitted");
    const storedGig = db.prepare("SELECT status FROM gigs WHERE key = ?").get(key) as { status: string };
    expect(storedGig.status).toBe("applied");
  });

  it("a SubmitAdapter throwing is caught, logged, never crashes the cycle, and leaves the draft safely 'approved' (not stuck 'submitting')", async () => {
    const sourceId = "src-adapter-throws";
    seedGraduatingHistory(sourceId, 3);
    recordScan([{ sourceId, gigs: [makeGig(sourceId, "new-1", "green")] }], { db, now: "2026-01-02T00:00:00.000Z" });
    const key = `${sourceId}:new-1`;
    const gig = makeGig(sourceId, "new-1", "green");
    const stageApplicationFn = fakeStageApplicationFn();
    const adapterSubmit = vi.fn(async () => {
      throw new Error("gofractional: Cloudflare interstitial blocked the form");
    });
    registerSubmitAdapter({ id: sourceId, submit: adapterSubmit });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const config = makeConfig({
      autoFire: { rules: [{ sourceId, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    });

    await expect(
      runAutoDraft(config, [matchResultFor(gig)], stageApplicationFn, (k) => getDraft(k, { db })),
    ).resolves.toBeUndefined(); // never throws/crashes the cycle

    expect(getDraft(key, { db })?.status).toBe("approved"); // NOT stuck 'submitting', NOT falsely 'submitted'
    const storedGig = db.prepare("SELECT status FROM gigs WHERE key = ?").get(key) as { status: string };
    expect(storedGig.status).toBe("new"); // markDraftSubmitted() never ran
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Cloudflare interstitial blocked the form"));

    // notifications-epic: a real submit failure raises a severity="error" issue.
    const openIssues = listIssues({ open: true }, { db });
    expect(openIssues).toHaveLength(1);
    expect(openIssues[0]).toMatchObject({
      severity: "error",
      source: `autofire-submit:${key}`,
      title: "Auto-fire submit failed",
      message: expect.stringContaining("Cloudflare interstitial blocked the form"),
    });

    consoleErrorSpy.mockRestore();
  });

  it("multiple eligible gigs in one cycle: one auto-fire failure never blocks another gig's own successful auto-fire", async () => {
    const sourceId = "src-mixed";
    seedGraduatingHistory(sourceId, 3);
    recordScan(
      [
        {
          sourceId,
          gigs: [makeGig(sourceId, "fail-1", "green"), makeGig(sourceId, "ok-1", "green")],
        },
      ],
      { db, now: "2026-01-02T00:00:00.000Z" },
    );
    const failGig = makeGig(sourceId, "fail-1", "green");
    const okGig = makeGig(sourceId, "ok-1", "green");
    const stageApplicationFn = fakeStageApplicationFn();
    let callCount = 0;
    registerSubmitAdapter({
      id: sourceId,
      submit: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("first one fails");
        return { ok: true, confirmation: "ok" };
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const config = makeConfig({
      autoFire: { rules: [{ sourceId, tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }] },
    });

    await runAutoDraft(config, [matchResultFor(failGig), matchResultFor(okGig)], stageApplicationFn, (k) => getDraft(k, { db }));

    expect(getDraft(`${sourceId}:fail-1`, { db })?.status).toBe("approved");
    expect(getDraft(`${sourceId}:ok-1`, { db })?.status).toBe("submitted");
  });
});
