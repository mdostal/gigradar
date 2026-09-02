// End-to-end proof that Config.autoDraftOnScan's eligibility gate (a bare
// `r.tier === "green"` filter in runAutoDraft(), src/scheduler/index.ts)
// ALREADY respects a group's customizable tierScoring mode
// (customizable-tier-scoring epic, PR #94) rather than always the keyword
// classifier -- runner.ts's runRadar() computes the flat MatchResult.tier
// via computeTier() whenever the primary group's tierScoring.kind isn't
// "keyword" (see runner.ts's own "score-threshold mode overrides the
// keyword classifier for the flat Gig.tier" test), and runAutoDraft() just
// consumes that field. Both halves were unit-tested in isolation before
// this file existed (runner.test.ts's own customizable-tier-scoring
// describe block; index.test.ts's runAutoDraft tests, which construct
// MatchResult.tier literally rather than deriving it) -- this test drives
// the REAL runRadar() -> REAL runAutoDraft() pipeline together, closing
// the "auto-draft's own gate is tier-only, not score-based" gap flagged
// during the chat-copilot-self-tuning epic's planning (see
// project_gigradar_customizable_tier_scoring memory): it was never
// actually a code gap once PR #94 shipped, just never proven end-to-end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setEnvVar } from "../../lib/config/env-store.js";
import { registerSource } from "../../lib/sources/source.js";
import { closeDb, getDb, getDraft } from "../../lib/store/index.js";
import type { ApplicationDraft } from "../../lib/apply/runner.js";
import { runRadar } from "../../lib/apply/runner.js";
import type { ApplyProfileConfig, Config, EngagementProfile, Gig, MatchResult } from "../../lib/types.js";
import { runAutoDraft } from "../index.js";

let nextGigs: Gig[] = [];
registerSource({
  id: "score-src",
  label: "Score source (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    return nextGigs;
  },
});

let tmpDir: string;
let keyTmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scheduler-autodraft-tierscoring-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scheduler-autodraft-tierscoring-test-key-"));
  vi.stubEnv("GIGRADAR_DB_PATH", path.join(tmpDir, "gigs.db"));
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
const PASSING_PROFILE: EngagementProfile = {
  id: "any-hourly",
  label: "Any (hourly)",
  types: ["contract", "fractional", "contract-to-hire"],
  minRate: 0,
  highRate: 999_999,
  maxHours: 999,
  maxHoursAtHighRate: 999,
  rateUnit: "hour",
};

function makeGig(externalId: string, title: string, weeklyHours?: number): Gig {
  return { sourceId: "score-src", externalId, title, url: `https://example.test/${externalId}`, weeklyHours };
}

function scoreConfig(tierScoring: Config["groups"][number]["tierScoring"]): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: { engagementProfiles: [PASSING_PROFILE], freshStageOnly: false, remoteOnly: false },
        // Every one of these titles would classify RED under keyword tiering --
        // score-threshold mode is what has to override that for this test to
        // prove anything real.
        roleArea: { coreTitles: [], keywords: [], redKeywords: ["Fractional CTO"] },
        tierScoring,
      },
    ],
    sources: [{ id: "score-src", enabled: true }],
    schedule: "*/1 * * * * *",
    autoDraftOnScan: true,
    applyProfile: APPLY_PROFILE,
  };
}

function fakeStageApplicationFn() {
  return vi.fn(async (r: MatchResult): Promise<ApplicationDraft> => ({
    gig: r.gig,
    content: { coverText: "Dear team...", answers: {} },
    status: "draft",
  }));
}

describe("runAutoDraft honors score-threshold tierScoring end-to-end (customizable-tier-scoring epic)", () => {
  it("drafts a gig the keyword classifier would call RED, once a real runRadar() pass scores it green under score-threshold mode", async () => {
    // Unpriced (no rate fields at all) -- gate.ts scores this as a real,
    // computable, high fit score regardless of the redKeywords match.
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")];
    const config = scoreConfig({ kind: "score-threshold", green: 0.1, yellow: 0.05 });

    const { passed } = await runRadar(config, { db });
    expect(passed[0]?.tier).toBe("green"); // sanity: runner.ts's own half of this pipeline

    const stageApplicationFn = fakeStageApplicationFn();
    await runAutoDraft(config, passed, stageApplicationFn, (key) => getDraft(key, { db }));

    expect(stageApplicationFn).toHaveBeenCalledTimes(1);
    expect(stageApplicationFn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ tier: "green" }));
  });

  it("does NOT draft a gig scored below the green threshold, even one the keyword classifier alone would not have flagged red", async () => {
    // A very high weeklyHours figure drags gate.ts's hoursScore (and so the
    // overall score) down -- a real, low-but-still-computable score, not a
    // hardcoded literal.
    nextGigs = [makeGig("2", "Fractional CTO for a Seed-Stage Startup", 990)];
    const config = scoreConfig({ kind: "score-threshold", green: 0.95, yellow: 0.9 });

    const { passed } = await runRadar(config, { db });
    expect(passed[0]?.tier).not.toBe("green"); // sanity: the real score genuinely misses this threshold

    const stageApplicationFn = fakeStageApplicationFn();
    await runAutoDraft(config, passed, stageApplicationFn, (key) => getDraft(key, { db }));

    expect(stageApplicationFn).not.toHaveBeenCalled();
  });
});
