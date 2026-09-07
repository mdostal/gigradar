// Proves runRadar() actually wires up assignRankBucket()/
// applyRankBucketAiOverlay() (rank-buckets epic) -- NOT re-testing either
// function's own logic (see matching/__tests__/rank-bucket.test.ts and
// rank-bucket-ai-overlay.test.ts for that), only that runRadar() calls the
// overlay with the right rule-based result and correctly persists whatever
// it returns. matching/rank-bucket-ai-overlay.js is mocked wholesale --
// same "mock the LLM-calling module entirely, test the call site's own
// wiring" pattern runner-ai-verify.test.ts already established.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Gig, RankBucketAssignment } from "../../types.js";

const { mockApplyRankBucketAiOverlay } = vi.hoisted(() => ({ mockApplyRankBucketAiOverlay: vi.fn() }));
// ruleOnlyRankBucketAssignment is NOT mocked -- runner.ts's own per-cycle
// cap enforcement (rank-bucket-ai-overlay-timeout-and-cap story) calls the
// REAL one directly (never applyRankBucketAiOverlay()) for a gig beyond
// the cap, so this test file needs the real implementation, not a mock.
vi.mock("../../matching/rank-bucket-ai-overlay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../matching/rank-bucket-ai-overlay.js")>();
  return { ...actual, applyRankBucketAiOverlay: mockApplyRankBucketAiOverlay };
});

import { registerSource } from "../../sources/source.js";
import { closeDb, getDb, getGig } from "../../store/index.js";
import { RANK_BUCKET_AI_OVERLAY_CAP, runRadar } from "../runner.js";

let nextGigs: Gig[] = [];
registerSource({
  id: "braintrust",
  label: "Braintrust (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    return nextGigs;
  },
});

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-rank-bucket-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  nextGigs = [];
  mockApplyRankBucketAiOverlay.mockReset();
  // Default: pass the rule-based result straight through unchanged
  // (source: "rule", confirmed: true), exactly like the real function
  // does when the group's overlay is off.
  mockApplyRankBucketAiOverlay.mockImplementation(async (_gig: unknown, _group: unknown, ruleResult: { bucket: string | null }): Promise<RankBucketAssignment> => ({
    bucket: ruleResult.bucket,
    source: "rule",
    confirmed: true,
  }));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config["groups"][number]> = {}): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: { engagementProfiles: [{ id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: false },
        rankBuckets: [{ label: "Tier 1", minRate: 200 }, { label: "Tier 2", minRate: 100 }],
        ...overrides,
      },
    ],
    sources: [{ id: "braintrust", enabled: true }],
  };
}

function makeGig(externalId: string, rate?: { min: number }): Gig {
  return { sourceId: "braintrust", externalId, title: "Fractional CTO", url: `https://example.test/${externalId}`, ...(rate ? { rate: { min: rate.min, unit: "hour" } } : {}) };
}

describe("runRadar: rank-bucket wiring (rank-buckets epic)", () => {
  it("calls applyRankBucketAiOverlay with the gig, the group, and the REAL rule-based result computed from that group's own rankBuckets", async () => {
    nextGigs = [makeGig("1", { min: 250 })];

    await runRadar(makeConfig(), { db });

    expect(mockApplyRankBucketAiOverlay).toHaveBeenCalledTimes(1);
    const [gigArg, groupArg, ruleResultArg] = mockApplyRankBucketAiOverlay.mock.calls[0] as [Gig, { id: string }, { bucket: string | null }];
    expect(gigArg.externalId).toBe("1");
    expect(groupArg.id).toBe("g1");
    expect(ruleResultArg.bucket).toBe("Tier 1"); // $250/hr clears Tier 1's $200 floor
  });

  it("persists the overlay's returned assignment on both matchedRankBuckets and the flat, primary-group-anchored rankBucket", async () => {
    nextGigs = [makeGig("1", { min: 250 })];

    await runRadar(makeConfig(), { db });

    const stored = getGig("braintrust:1", { db });
    expect(stored?.matchedRankBuckets).toEqual({ g1: { bucket: "Tier 1", source: "rule", confirmed: true } });
    expect(stored?.rankBucket).toEqual({ bucket: "Tier 1", source: "rule", confirmed: true });
  });

  it("persists an unconfirmed AI suggestion exactly as the overlay returns it", async () => {
    mockApplyRankBucketAiOverlay.mockResolvedValueOnce({ bucket: "Tier 2", source: "ai", confirmed: false, reason: "Actually Tier 2." });
    nextGigs = [makeGig("1", { min: 250 })];

    await runRadar(makeConfig(), { db });

    const stored = getGig("braintrust:1", { db });
    expect(stored?.rankBucket).toEqual({ bucket: "Tier 2", source: "ai", confirmed: false, reason: "Actually Tier 2." });
  });

  it("never calls the overlay, and never persists matchedRankBuckets/rankBucket at all, for a group with no rankBuckets configured", async () => {
    nextGigs = [makeGig("1", { min: 250 })];

    await runRadar(makeConfig({ rankBuckets: undefined }), { db });

    expect(mockApplyRankBucketAiOverlay).not.toHaveBeenCalled();
    const stored = getGig("braintrust:1", { db });
    expect(stored?.matchedRankBuckets).toBeUndefined();
    expect(stored?.rankBucket).toBeUndefined();
  });

  it("survives a re-scan (upsert path, not just the initial insert)", async () => {
    nextGigs = [makeGig("1", { min: 50 })]; // fails both rules -> null
    await runRadar(makeConfig(), { db });
    expect(getGig("braintrust:1", { db })?.rankBucket).toEqual({ bucket: null, source: "rule", confirmed: true });

    nextGigs = [makeGig("1", { min: 250 })]; // re-scan at a real rate
    await runRadar(makeConfig(), { db });
    expect(getGig("braintrust:1", { db })?.rankBucket).toEqual({ bucket: "Tier 1", source: "rule", confirmed: true });
  });
});

// rank-bucket-ai-overlay-timeout-and-cap story (triage t-002): proves the
// real, exported RANK_BUCKET_AI_OVERLAY_CAP is actually enforced by
// runRadar() itself -- more AI-overlay-eligible gigs exist in one cycle
// than the cap, only the capped number get a real applyRankBucketAiOverlay()
// call, the rest keep their rule-based result for this cycle (self-heals on
// a later scan, no data loss).
describe("runRadar: RANK_BUCKET_AI_OVERLAY_CAP enforcement (rank-bucket-ai-overlay-timeout-and-cap, triage t-002)", () => {
  const CREDENTIAL = { kind: "api-key" as const, provider: "anthropic" as const, value: "fake-api-key" };

  it("calls applyRankBucketAiOverlay at most RANK_BUCKET_AI_OVERLAY_CAP times in one cycle, even with more eligible gigs than the cap", async () => {
    const total = RANK_BUCKET_AI_OVERLAY_CAP + 5;
    nextGigs = Array.from({ length: total }, (_, i) => makeGig(String(i), { min: 250 }));

    await runRadar(makeConfig({ rankBucketAiOverlay: true }), { db }, { credential: CREDENTIAL });

    expect(mockApplyRankBucketAiOverlay).toHaveBeenCalledTimes(RANK_BUCKET_AI_OVERLAY_CAP);
  });

  it("gigs beyond the cap keep the real rule-based rankBucket result this cycle -- never left undefined/broken", async () => {
    const total = RANK_BUCKET_AI_OVERLAY_CAP + 5;
    nextGigs = Array.from({ length: total }, (_, i) => makeGig(String(i), { min: 250 }));

    await runRadar(makeConfig({ rankBucketAiOverlay: true }), { db }, { credential: CREDENTIAL });

    // Every gig, capped or not, ends up with a real, non-broken rankBucket
    // assignment -- the ones beyond the cap never called the (mocked) AI
    // overlay at all, so they must have gotten there via the direct
    // rule-based fallback this story adds in runner.ts.
    for (let i = 0; i < total; i++) {
      const stored = getGig(`braintrust:${i}`, { db });
      expect(stored?.rankBucket).toEqual({ bucket: "Tier 1", source: "rule", confirmed: true });
    }
  });

  it("does NOT count a call that would be a no-op anyway (no credential resolved) against the cap", async () => {
    const total = RANK_BUCKET_AI_OVERLAY_CAP + 5;
    nextGigs = Array.from({ length: total }, (_, i) => makeGig(String(i), { min: 250 }));

    // rankBucketAiOverlay is on, but no credential resolves this cycle --
    // every call is a free no-op (applyRankBucketAiOverlay's own early
    // return), so none of them should burn cap budget, and the mock
    // (standing in for the real function) is still called once per gig.
    await runRadar(makeConfig({ rankBucketAiOverlay: true }), { db });

    expect(mockApplyRankBucketAiOverlay).toHaveBeenCalledTimes(total);
  });
});
