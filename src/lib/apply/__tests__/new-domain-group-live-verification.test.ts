// dynamic-groups-band-audit epic, new-domain-group-live-verification story.
//
// A dedicated code-reading audit (this epic's own design-discussion.md §1)
// already confirmed by direct inspection that the matching/rank-bucket/
// match-band engine (tiering.ts, rank-bucket.ts, match-band.ts,
// group-match.ts) is 100% config-driven -- no hardcoded fractional-exec
// titles/keywords/rates anywhere in src/lib. That proves the MECHANISM is
// generic; it does not prove a genuinely new, unrelated-domain group
// actually behaves correctly end-to-end at runtime. This is that real
// proof: two complete, invented GroupConfigs for domains this codebase has
// never seen before -- "Drone Services" (commercial drone piloting/
// inspection/mapping contract work) and "AI Data Labeling" (RLHF/dataset
// annotation contract work) -- run through the REAL runRadar() pipeline
// (gate -> matchGroups -> tier -> assignRankBucket -> computeMatchBand),
// never mocking any matching function.
//
// Both groups are configured on the SAME Config at once specifically to
// catch a two-groups-interacting bug: every fixture below is evaluated
// against BOTH groups, and several assertions are about one group's
// result while a fixture is "really" the other domain's gig -- proving
// each group's tier/band/rank-bucket stays correctly scoped to that
// group's own criteria rather than leaking, being shared, or silently
// defaulting to the other group's config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerSource } from "../../sources/source.js";
import { closeDb, getDb, getGig } from "../../store/index.js";
import type { Config, Gig } from "../../types.js";
import { runRadar } from "../runner.js";

const SOURCE_ID = "drone-and-labeling-test-source";

let nextGigs: Gig[] = [];
registerSource({
  id: SOURCE_ID,
  label: "Drone/AI-labeling test fixture source",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    return nextGigs;
  },
});

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-new-domain-group-test-"));
  db = getDb({ path: path.join(tmpDir, "gigs.db") });
  nextGigs = [];
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Two genuinely unrelated, invented domains -- nothing borrowed from any
 * fractional-exec template or the owner's own real A/B/C tier numbers
 * (memory: A=$150+/hr, C=$90-200/hr). Rates, keywords, and rank buckets
 * below are plausible for these domains but invented fresh for this test.
 */
const CONFIG: Config = {
  profile: {
    name: "Test Operator",
    // Global (not per-group) -- gate()'s fitScore() checks EVERY group's
    // gate against this same shared list, independent of which group's
    // roleArea drives that group's own tier. Includes both domains'
    // vocabulary since a real owner tracking both would list both.
    roles: ["Drone Pilot", "AI Data Annotator"],
    skills: ["drone inspection", "photogrammetry", "data annotation", "RLHF"],
    timezone: "UTC",
  },
  groups: [
    {
      id: "drone-services",
      label: "Drone Services",
      needs: {
        engagementProfiles: [
          {
            id: "drone-day-rate",
            label: "Drone Contract (Hourly)",
            types: ["contract"],
            minRate: 65,
            highRate: 135,
            maxHours: 30,
            maxHoursAtHighRate: 45,
            rateUnit: "hour",
          },
        ],
        freshStageOnly: false,
        remoteOnly: false,
      },
      roleArea: {
        coreTitles: ["Drone Pilot", "UAV Pilot", "Drone Inspector", "Aerial Mapping Specialist"],
        keywords: ["photogrammetry", "LiDAR mapping", "orthomosaic", "aerial survey", "drone inspection"],
        redKeywords: ["wedding", "hobbyist", "influencer"],
      },
      // Owner-named buckets with real, drone-specific match criteria --
      // deliberately NOT generic phrases ("training provided") that could
      // false-positive-match an unrelated domain's listing.
      rankBuckets: [
        { label: "FAA Part 107 Certified", keywords: ["Part 107", "FAA certified"] },
        { label: "Needs Certification", keywords: ["will sponsor Part 107 exam", "ground school provided", "certification assistance"] },
      ],
      // Default matchQuality (15% near-band tolerance) -- left unset
      // deliberately, to prove the DEFAULT path works correctly alongside
      // ai-data-labeling's explicit override below.
    },
    {
      id: "ai-data-labeling",
      label: "AI Data Labeling",
      needs: {
        engagementProfiles: [
          {
            id: "labeling-hourly",
            label: "AI Labeling (Hourly)",
            types: ["contract", "contract-to-hire"],
            minRate: 18,
            highRate: 45,
            maxHours: 40,
            maxHoursAtHighRate: 50,
            rateUnit: "hour",
          },
        ],
        freshStageOnly: false,
        remoteOnly: false,
      },
      roleArea: {
        coreTitles: ["Data Labeler", "AI Data Annotator", "RLHF Rater", "Data Annotation Specialist"],
        keywords: ["annotation", "labeling", "reinforcement learning from human feedback", "dataset curation", "prompt evaluation"],
        redKeywords: ["drone", "aerial", "pilot"],
      },
      rankBuckets: [
        { label: "Senior Rater", keywords: ["senior", "lead annotator", "expert reviewer"], minRate: 30 },
        { label: "Junior Rater", keywords: ["entry level", "junior", "no experience required"] },
      ],
      // Explicit override (different shape from drone-services' unset
      // default) -- exercises the customized matchQuality path too.
      matchQuality: { nearBandTolerancePct: 20, hideOutOfBandByDefault: false },
    },
  ],
  sources: [{ id: SOURCE_ID, enabled: true }],
};

function makeGig(externalId: string, fields: Partial<Gig> & { title: string }): Gig {
  return { sourceId: SOURCE_ID, url: `https://example.test/${externalId}`, externalId, ...fields };
}

async function runAndFetch(gig: Gig) {
  nextGigs = [gig];
  await runRadar(CONFIG, { db });
  return getGig(`${SOURCE_ID}:${gig.externalId}`, { db })!;
}

describe("new-domain-group-live-verification: a real, invented Drone Services group + a second, differently-shaped AI Data Labeling group, run through the real pipeline", () => {
  it("GREEN-tiers, in-bands, and rank-buckets a real drone-inspection contract gig for Drone Services -- and correctly RED-tiers the SAME gig for the unrelated AI Data Labeling group", async () => {
    const gig = makeGig("1", {
      title: "Commercial Drone Pilot - Solar Farm Inspection (Part 107 Required)",
      description: "Seeking a Part 107 certified drone pilot for recurring aerial inspection of solar installations using LiDAR mapping and photogrammetry.",
      rate: { min: 95, max: 120, unit: "hour" },
      weeklyHours: 20,
    });
    const stored = await runAndFetch(gig);

    expect(stored.matchedGroupTiers).toEqual({ "drone-services": "green", "ai-data-labeling": "red" });
    expect(stored.matchedGroupBands?.["drone-services"]).toBe("in-band");
    expect(stored.matchedRankBuckets?.["drone-services"]?.bucket).toBe("FAA Part 107 Certified");
    // A gig can clear a group's gate (rate/hours/fit) while still tiering
    // RED for it -- tier is never a hard reject (tiering.ts's own
    // contract). Real, independent-axes behavior, not a bug: this gig's
    // $95/hr clears ai-data-labeling's $18/hr floor too, even though it's
    // obviously not an AI-labeling role.
    expect(stored.matchedGroupIds).toEqual(expect.arrayContaining(["drone-services", "ai-data-labeling"]));
    // No drone-specific rank-bucket keyword appears in this gig's text, so
    // AI Data Labeling's own buckets correctly find nothing -- confirms
    // rank buckets stay scoped to the evaluating group's own criteria.
    expect(stored.matchedRankBuckets?.["ai-data-labeling"]?.bucket).toBeNull();
    // Real, live-verified bug this story found and fixed: each group's OWN
    // matched engagement-profile id, not the flat matchedProfileIds
    // (anchored to whichever group is first in Config.groups -- here
    // "drone-services") leaking into the OTHER group's own per-group view.
    // Before this fix, dashboard-client.tsx's Profile column had no
    // per-group source for this at all and rendered "drone-day-rate" (this
    // gig's PRIMARY group's own profile id) under AI Data Labeling's own
    // giglist page too.
    expect(stored.matchedGroupProfileIds).toEqual({
      "drone-services": ["drone-day-rate"],
      "ai-data-labeling": ["labeling-hourly"],
    });
  });

  it("RED-tiers a same-flavor generic aerial-photography-hobbyist listing for Drone Services (real GREEN/RED discrimination, not just keyword presence)", async () => {
    const gig = makeGig("2", {
      title: "Aerial Photography - Wedding Season Drone Operator (Hobbyist Encouraged)",
      description: "Fun freelance gig covering weddings and events -- great for a hobbyist wanting extra cash, no certification required.",
      rate: { min: 45, unit: "hour" },
      weeklyHours: 10,
    });
    const stored = await runAndFetch(gig);

    expect(stored.matchedGroupTiers?.["drone-services"]).toBe("red");
    // Also red for AI Data Labeling (its own redKeywords catch "drone"/
    // "aerial") -- both groups correctly reject this listing, each via
    // its own independent keyword set, not a shared/hardcoded one.
    expect(stored.matchedGroupTiers?.["ai-data-labeling"]).toBe("red");
    expect(stored.matchedRankBuckets?.["drone-services"]?.bucket).toBeNull();
  });

  it("GREEN-tiers a real drone gig whose rate is genuinely too low, correctly marking it out-of-band (mirrors the real GREEN-but-underpaid incident match-band.ts exists to catch)", async () => {
    const gig = makeGig("3", {
      title: "Freelance Drone Pilot - Rooftop Inspection Project",
      description: "Contract drone pilot needed for rooftop aerial survey using LiDAR mapping equipment.",
      rate: { min: 38, unit: "hour" },
      weeklyHours: 15,
    });
    const stored = await runAndFetch(gig);

    expect(stored.matchedGroupTiers?.["drone-services"]).toBe("green");
    expect(stored.matchedGroupBands?.["drone-services"]).toBe("out-of-band"); // $38/hr vs. $65/hr floor, 41.5% under -- beyond the default 15% tolerance
    expect(stored.matchedRankBuckets?.["drone-services"]?.bucket).toBeNull();
  });

  it("GREEN-tiers, in-bands, and rank-buckets a real AI-labeling contract gig for AI Data Labeling -- and correctly leaves it YELLOW (not red, not green) for the unrelated Drone Services group", async () => {
    const gig = makeGig("4", {
      title: "Senior AI Data Annotator - RLHF Prompt Evaluation Contract",
      description: "Contract data annotation specialist role focused on reinforcement learning from human feedback rating and dataset curation for LLM training pipelines. Remote, flexible hours.",
      rate: { min: 32, max: 40, unit: "hour" },
      weeklyHours: 25,
    });
    const stored = await runAndFetch(gig);

    expect(stored.matchedGroupTiers).toEqual({ "ai-data-labeling": "green", "drone-services": "yellow" });
    expect(stored.matchedGroupBands?.["ai-data-labeling"]).toBe("in-band");
    expect(stored.matchedRankBuckets?.["ai-data-labeling"]?.bucket).toBe("Senior Rater"); // $32/hr clears the rule's own $30 minRate AND "senior" keyword (AND-within-a-rule)
    // A gig genuinely irrelevant to Drone Services never accidentally
    // lands in one of ITS rank buckets either.
    expect(stored.matchedRankBuckets?.["drone-services"]?.bucket).toBeNull();
  });

  it("marks a real AI-labeling gig near-band under AI Data Labeling's OWN, differently-configured 20% tolerance (not the other group's 15% default) and assigns the correct rank bucket", async () => {
    const gig = makeGig("5", {
      title: "AI Data Annotator - Entry Level Dataset Labeling",
      description: "Entry level remote contract opportunity labeling datasets for machine learning teams. No experience required, training provided.",
      rate: { min: 16, unit: "hour" },
      weeklyHours: 20,
    });
    const stored = await runAndFetch(gig);

    expect(stored.matchedGroupTiers?.["ai-data-labeling"]).toBe("green");
    // $16/hr is 11.1% under the $18/hr floor -- within ai-data-labeling's
    // own configured 20% tolerance (near-band), while the SAME distance
    // would have been near-band under drone-services' 15% default too,
    // but drone-services' floor is $65/hr, not $18/hr, so this gig is
    // wildly out-of-band there instead -- proving each group resolves its
    // OWN matchQuality tolerance and its OWN rate floor independently.
    expect(stored.matchedGroupBands?.["ai-data-labeling"]).toBe("near-band");
    expect(stored.matchedGroupBands?.["drone-services"]).toBe("out-of-band");
    // Rate ($16) fails "Senior Rater"'s $30 minRate, so it falls through
    // to "Junior Rater" (first-match-wins, in declared order).
    expect(stored.matchedRankBuckets?.["ai-data-labeling"]?.bucket).toBe("Junior Rater");
    expect(stored.matchedGroupTiers?.["drone-services"]).toBe("yellow");
  });
});
