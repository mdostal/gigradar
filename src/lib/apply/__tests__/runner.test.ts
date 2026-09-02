import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config, EngagementProfile, Gig, RoleAreaConfig } from "../../types.js";
import { registerSource } from "../../sources/source.js";
import { VerificationChallengeError } from "../../sources/verification-challenge.js";
import { closeDb, getDb, getGig, listGigs } from "../../store/index.js";
import { runRadar } from "../runner.js";

// Exercises the REAL runner path (runRadar -> gate -> recordScan/store), not
// just the store's own prior unit tests (see src/lib/store/__tests__). The
// registered source below has id "braintrust" and implements the real
// `Source` contract, but its `fetch` is a controllable, network-free test
// double (set via `nextGigs` before each call) — this file never imports the
// real src/lib/sources/braintrust.ts, so there's no duplicate-id collision
// and no live network call.
let nextGigs: Gig[] = [];
registerSource({
  id: "braintrust",
  label: "Braintrust (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    return nextGigs;
  },
});

// A second registered double that can be told to throw, standing in for a
// source whose session/API key expired (auth: "browser-session" | "api-key"
// in real life) — proves the runner surfaces the throw in errors[] and never
// silently treats it as a zero-result scan for delisting purposes.
let flakyShouldThrow = false;
let flakyGigs: Gig[] = [];
registerSource({
  id: "flaky",
  label: "Flaky (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    if (flakyShouldThrow) throw new Error("flaky: simulated auth failure (expired session)");
    return flakyGigs;
  },
});

// A third registered double that throws VerificationChallengeError
// (verification-copilot epic) -- proves runner.ts's errors[] entry
// carries needsVerification/blockedUrl, distinct from a generic thrown
// Error (the "flaky" double above), without needing a real
// withBrowserSession() call or a real bot-detection page.
let verificationBlockedShouldThrow = false;
registerSource({
  id: "verification-blocked",
  label: "Verification-blocked (test double)",
  auth: "browser-session",
  async fetch(): Promise<Gig[]> {
    if (verificationBlockedShouldThrow) {
      throw new VerificationChallengeError("verification-blocked", "https://example.com/blocked-page");
    }
    return [];
  },
});

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  nextGigs = [];
  flakyShouldThrow = false;
  flakyGigs = [];
  verificationBlockedShouldThrow = false;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(roleArea?: RoleAreaConfig): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
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
        roleArea,
      },
    ],
    sources: [{ id: "braintrust", enabled: true }],
  };
}

function makeGig(externalId: string, title = "Senior Backend Engineer", sourceId = "braintrust"): Gig {
  return {
    sourceId,
    externalId,
    title,
    url: `https://app.usebraintrust.com/jobs/${externalId}/`,
  };
}

describe("runRadar + store integration", () => {
  it("run 1 persists every gig the source returns into the store", async () => {
    nextGigs = [makeGig("1", "Senior Backend Engineer"), makeGig("2", "Staff Platform Engineer")];

    const result = await runRadar(makeConfig(), { db });

    expect(result.errors).toEqual([]);
    expect(result.results).toHaveLength(2);
    // gate() applied to every gig (no filters set => everything passes).
    expect(result.passed).toHaveLength(2);

    const stored = listGigs({ sourceId: "braintrust" }, { db });
    expect(stored.map((g) => g.key).sort()).toEqual(["braintrust:1", "braintrust:2"]);
    expect(stored.every((g) => g.status === "new")).toBe(true);
    expect(stored.every((g) => g.unavailableSince === null)).toBe(true);
  });

  it("run 2 with the same data preserves status and firstSeen (not re-flagged new)", async () => {
    nextGigs = [makeGig("1"), makeGig("2")];
    await runRadar(makeConfig(), { db, now: "2026-01-01T00:00:00.000Z" });

    // A real product action between scans — the store must never undo this.
    db.prepare("UPDATE gigs SET status = 'applied' WHERE key = 'braintrust:1'").run();
    const firstSeenBefore = getGig("braintrust:1", { db })?.firstSeen;
    expect(firstSeenBefore).toBe("2026-01-01T00:00:00.000Z");

    // Second scan, same two gigs come back again.
    nextGigs = [makeGig("1"), makeGig("2")];
    const result = await runRadar(makeConfig(), { db, now: "2026-01-08T00:00:00.000Z" });

    expect(result.errors).toEqual([]);
    const after = getGig("braintrust:1", { db });
    expect(after?.status).toBe("applied"); // preserved, not reset to "new"
    expect(after?.firstSeen).toBe("2026-01-01T00:00:00.000Z"); // never moves
    expect(after?.lastSeen).toBe("2026-01-08T00:00:00.000Z"); // bumped
    expect(after?.unavailableSince).toBeNull(); // still available
  });

  it("flags a gig unavailable when Braintrust stops returning it while other Braintrust gigs persist", async () => {
    nextGigs = [makeGig("1", "Will Be Delisted"), makeGig("2", "Still Open")];
    await runRadar(makeConfig(), { db, now: "2026-01-01T00:00:00.000Z" });

    // Next scan: gig 1 is gone from Braintrust, but the source itself is
    // healthy — it still returns gig 2. This is the real-delisting case,
    // distinct from a source outage (which must never flag anything).
    nextGigs = [makeGig("2", "Still Open")];
    const result = await runRadar(makeConfig(), { db, now: "2026-01-02T00:00:00.000Z" });

    expect(result.errors).toEqual([]);
    expect(getGig("braintrust:1", { db })?.unavailableSince).toBe("2026-01-02T00:00:00.000Z");
    expect(getGig("braintrust:2", { db })?.unavailableSince).toBeNull(); // present this scan, untouched
  });

  it("surfaces a fetch throw (auth failure) in errors[] and never flags that source's gigs unavailable", async () => {
    const config = makeConfig();
    config.sources = [{ id: "flaky", enabled: true }];

    flakyGigs = [makeGig("1", "Flaky Gig One", "flaky"), makeGig("2", "Flaky Gig Two", "flaky")];
    await runRadar(config, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(getGig("flaky:1", { db })).toBeDefined();

    // Second scan: the session expired — fetch throws instead of returning [].
    flakyShouldThrow = true;
    const result = await runRadar(config, { db, now: "2026-01-02T00:00:00.000Z" });

    expect(result.errors).toEqual([
      { sourceId: "flaky", message: "flaky: simulated auth failure (expired session)" },
    ]);
    expect(result.results).toEqual([]);
    // Not silently zero: the previously-stored gigs must NOT be flagged
    // unavailable just because this scan's fetch failed.
    expect(getGig("flaky:1", { db })?.unavailableSince).toBeNull();
    expect(getGig("flaky:2", { db })?.unavailableSince).toBeNull();
  });

  it("a VerificationChallengeError throw surfaces in errors[] with needsVerification:true and blockedUrl set (verification-copilot epic)", async () => {
    const config = makeConfig();
    config.sources = [{ id: "verification-blocked", enabled: true }];
    verificationBlockedShouldThrow = true;

    const result = await runRadar(config, { db });

    expect(result.errors).toEqual([
      {
        sourceId: "verification-blocked",
        message: 'gigradar: source "verification-blocked" hit a verification challenge at "https://example.com/blocked-page" — a human needs to clear it before this source can be scanned again.',
        needsVerification: true,
        blockedUrl: "https://example.com/blocked-page",
      },
    ]);
  });

  it("a plain thrown Error (not a VerificationChallengeError) never sets needsVerification/blockedUrl", async () => {
    const config = makeConfig();
    config.sources = [{ id: "flaky", enabled: true }];
    flakyShouldThrow = true;

    const result = await runRadar(config, { db });

    expect(result.errors[0]?.needsVerification).toBeUndefined();
    expect(result.errors[0]?.blockedUrl).toBeUndefined();
  });

  it("an unregistered source id surfaces in errors[] without touching the store", async () => {
    nextGigs = [makeGig("1"), makeGig("2")];
    await runRadar(makeConfig(), { db, now: "2026-01-01T00:00:00.000Z" });

    const config = makeConfig();
    config.sources = [{ id: "does-not-exist", enabled: true }];
    const result = await runRadar(config, { db, now: "2026-01-02T00:00:00.000Z" });

    expect(result.errors).toEqual([{ sourceId: "does-not-exist", message: "no such registered source" }]);
    expect(result.results).toEqual([]);
    expect(getGig("braintrust:1", { db })?.unavailableSince).toBeNull();
    expect(getGig("braintrust:2", { db })?.unavailableSince).toBeNull();
  });
});

describe("runRadar: tiering integration", () => {
  const roleArea: RoleAreaConfig = {
    coreTitles: ["fractional cto"],
    keywords: ["kubernetes"],
    redKeywords: ["recruiter"],
  };

  it("computes a gig's tier via tier() and persists it through the full pipeline (gate -> tier -> store)", async () => {
    nextGigs = [
      makeGig("1", "Fractional CTO for a Seed-Stage Startup"), // core title -> green
      makeGig("2", "Technical Recruiter"), // red keyword, no core title -> red
      makeGig("3", "Marketing Copywriter"), // nothing matches -> yellow
    ];

    const result = await runRadar(makeConfig(roleArea), { db });

    expect(result.errors).toEqual([]);

    // In-memory MatchResult carries the tier.
    const byExternalId = new Map(result.results.map((r) => [r.gig.externalId, r]));
    expect(byExternalId.get("1")?.tier).toBe("green");
    expect(byExternalId.get("2")?.tier).toBe("red");
    expect(byExternalId.get("3")?.tier).toBe("yellow");

    // Persisted through the store's recordScan()/upsert path.
    expect(getGig("braintrust:1", { db })?.tier).toBe("green");
    expect(getGig("braintrust:2", { db })?.tier).toBe("red");
    expect(getGig("braintrust:3", { db })?.tier).toBe("yellow");
  });

  it("without a configured roleArea, every persisted gig tiers yellow (do-nothing default, not an error)", async () => {
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")];

    const result = await runRadar(makeConfig(undefined), { db });

    expect(result.errors).toEqual([]);
    expect(result.results[0]?.tier).toBe("yellow");
    expect(getGig("braintrust:1", { db })?.tier).toBe("yellow");
  });
});

describe("runRadar: engagement-profiles integration", () => {
  it("stamps gate()'s matchedProfiles onto both the in-memory MatchResult.gig and the persisted store row (same pattern as tier)", async () => {
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")];

    const result = await runRadar(makeConfig(), { db });

    expect(result.errors).toEqual([]);
    // makeConfig()'s Needs fixture (top of this file) has an "any-hourly"
    // profile that any unpriced/hourly gig matches.
    expect(result.results[0]?.gig.matchedProfileIds).toEqual(["any-hourly"]);
    expect(result.results[0]?.matchedProfiles).toEqual(["any-hourly"]);
    expect(getGig("braintrust:1", { db })?.matchedProfileIds).toEqual(["any-hourly"]);
  });
});

describe("runRadar: group-aware matching (multi-group-architecture epic, mga-3)", () => {
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

  /** Group A always clears its gate and tiers green on "Fractional CTO" titles; group B's gate can never pass (no configured engagementProfiles) and always tiers yellow (no roleArea keywords configured). */
  function makeTwoGroupConfig(sourceGroupIds?: string[]): Config {
    return {
      profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
      groups: [
        {
          id: "A",
          label: "Group A",
          needs: { engagementProfiles: [PASSING_PROFILE], freshStageOnly: false, remoteOnly: false },
          roleArea: { coreTitles: ["fractional cto"], keywords: [], redKeywords: [] },
        },
        {
          id: "B",
          label: "Group B",
          needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false },
          roleArea: { coreTitles: [], keywords: [], redKeywords: [] },
        },
      ],
      sources: [{ id: "braintrust", enabled: true, ...(sourceGroupIds ? { groupIds: sourceGroupIds } : {}) }],
    };
  }

  it("single-group config (the common case immediately after Slice 1 ships): matchedGroupIds is exactly [that group's id] and matchedGroupTiers is {that group: same value as the flat tier column} — byte-identical to pre-multi-group behavior", async () => {
    const roleArea: RoleAreaConfig = { coreTitles: ["fractional cto"], keywords: [], redKeywords: [] };
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")];

    await runRadar(makeConfig(roleArea), { db });

    const stored = getGig("braintrust:1", { db });
    expect(stored?.tier).toBe("green");
    expect(stored?.matchedGroupIds).toEqual(["g1"]);
    expect(stored?.matchedGroupTiers).toEqual({ g1: stored?.tier });
  });

  it("two-group config, source unscoped (evaluated against every group): a gig that clears group A's gate but not group B's has matchedGroupIds ['A'], but matchedGroupTiers still records BOTH groups' tier results (informational, independent of pass/fail)", async () => {
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")];

    await runRadar(makeTwoGroupConfig(), { db });

    const stored = getGig("braintrust:1", { db });
    expect(stored?.matchedGroupIds).toEqual(["A"]); // B's gate can never pass (no engagementProfiles)
    expect(stored?.matchedGroupTiers).toEqual({ A: "green", B: "yellow" });
    // The flat/legacy columns stay anchored to the first in-scope group ("primary group").
    expect(stored?.tier).toBe("green");
  });

  it("a source scoped to groupIds: ['A'] is ONLY evaluated against group A, never group B, regardless of how many groups exist in config.groups", async () => {
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")];

    await runRadar(makeTwoGroupConfig(["A"]), { db });

    const stored = getGig("braintrust:1", { db });
    expect(stored?.matchedGroupIds).toEqual(["A"]);
    expect(stored?.matchedGroupTiers).toEqual({ A: "green" }); // B never evaluated -- no key for it at all
  });
});

describe("runRadar: customizable-tier-scoring", () => {
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

  function makeScoreConfig(tierScoring: Config["groups"][number]["tierScoring"]): Config {
    return {
      profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
      groups: [
        {
          id: "g1",
          label: "Group 1",
          needs: { engagementProfiles: [PASSING_PROFILE], freshStageOnly: false, remoteOnly: false },
          roleArea: { coreTitles: [], keywords: [], redKeywords: ["Fractional CTO"] }, // would keyword-tier RED
          tierScoring,
        },
      ],
      sources: [{ id: "braintrust", enabled: true }],
    };
  }

  it("persists matchScore/matchedGroupScores on every gig, regardless of tierScoring mode", async () => {
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")];

    await runRadar(makeScoreConfig(undefined), { db }); // default keyword mode

    const stored = getGig("braintrust:1", { db });
    expect(typeof stored?.matchScore).toBe("number");
    expect(stored?.matchedGroupScores).toEqual({ g1: stored?.matchScore });
  });

  it("score-threshold mode overrides the keyword classifier for the flat Gig.tier, not just the per-group tier", async () => {
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")]; // unpriced -> a real, computable score

    await runRadar(makeScoreConfig({ kind: "score-threshold", green: 0.1, yellow: 0.05 }), { db });

    const stored = getGig("braintrust:1", { db });
    // roleArea's redKeywords would have kept this RED under keyword tiering --
    // score-threshold mode overrides that for this group.
    expect(stored?.tier).toBe("green");
    expect(stored?.matchedGroupTiers).toEqual({ g1: "green" });
  });

  it("percentile mode ranks a new gig against the population of ALREADY-stored 'new' gigs for that group, fetched fresh each scan", async () => {
    // Cycle 1: seed two lower-scoring gigs (high weeklyHours -> low hoursScore -> low total score).
    nextGigs = [
      { sourceId: "braintrust", externalId: "low1", title: "Fractional CTO A", url: "https://example.test/low1", weeklyHours: 950 },
      { sourceId: "braintrust", externalId: "low2", title: "Fractional CTO B", url: "https://example.test/low2", weeklyHours: 900 },
    ];
    await runRadar(makeScoreConfig({ kind: "percentile", greenPercentile: 80, yellowPercentile: 40 }), { db });

    // Cycle 2: a NEW gig with a much better weeklyHours figure -> a real, higher score than both seeded gigs.
    nextGigs = [
      { sourceId: "braintrust", externalId: "high1", title: "Fractional CTO C", url: "https://example.test/high1", weeklyHours: 5 },
    ];
    await runRadar(makeScoreConfig({ kind: "percentile", greenPercentile: 80, yellowPercentile: 40 }), { db });

    const high = getGig("braintrust:high1", { db });
    // Ranks above both pre-existing scores -> 100th percentile -> green.
    expect(high?.tier).toBe("green");

    // Re-scanning one of the ORIGINAL low gigs now ranks it against the
    // (now 3-gig) population, including the newly-inserted high scorer --
    // proves the population is genuinely re-fetched each scan, not cached
    // from cycle 1.
    nextGigs = [
      { sourceId: "braintrust", externalId: "low1", title: "Fractional CTO A", url: "https://example.test/low1", weeklyHours: 950 },
    ];
    await runRadar(makeScoreConfig({ kind: "percentile", greenPercentile: 80, yellowPercentile: 40 }), { db });
    const low1 = getGig("braintrust:low1", { db });
    expect(low1?.tier).not.toBe("green"); // still the lowest (or tied-lowest) of the population
  });
});
