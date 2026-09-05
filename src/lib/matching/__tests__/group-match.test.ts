import { describe, expect, it } from "vitest";
import type { EngagementProfile, Gig, GroupConfig, Needs, Profile, RoleAreaConfig } from "../../types.js";
import { matchGroups } from "../group-match.js";

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    sourceId: "test-source",
    externalId: "1",
    title: "Fractional CTO",
    url: "https://example.test/1",
    ...overrides,
  };
}

const EMPTY_PROFILE: Profile = { name: "Test User", roles: [], skills: [], timezone: "UTC" };

const PASSING_ENGAGEMENT_PROFILE: EngagementProfile = {
  id: "any-hourly",
  label: "Any (hourly)",
  types: ["contract", "fractional"],
  minRate: 0,
  highRate: 999_999,
  maxHours: 999,
  maxHoursAtHighRate: 999,
  rateUnit: "hour",
};

// A Needs with NO configured engagementProfiles at all -- gate.ts's
// matchProfiles() then has zero applicable profiles for any gig, so it
// always fails deterministically regardless of the gig's own fields (unlike
// an unpublished-rate gig, which gate.ts treats as a lenient pass).
const IMPOSSIBLE_NEEDS: Needs = { engagementProfiles: [], freshStageOnly: false, remoteOnly: false };
const PASSING_NEEDS: Needs = { engagementProfiles: [PASSING_ENGAGEMENT_PROFILE], freshStageOnly: false, remoteOnly: false };

const GREEN_ROLE_AREA: RoleAreaConfig = { coreTitles: ["Fractional CTO"], keywords: [], redKeywords: [] };
const YELLOW_ROLE_AREA: RoleAreaConfig = { coreTitles: [], keywords: [], redKeywords: [] };

function makeGroup(overrides: Partial<GroupConfig> & { id: string }): GroupConfig {
  return { label: overrides.id, needs: PASSING_NEEDS, ...overrides };
}

describe("matchGroups", () => {
  it("returns an empty matchedGroupIds and empty groupTiers for zero groups", () => {
    const result = matchGroups(makeGig(), [], EMPTY_PROFILE);
    expect(result.matchedGroupIds).toEqual([]);
    expect(result.groupTiers).toEqual({});
  });

  it("includes a group's id in matchedGroupIds when the gig clears that group's gate", () => {
    const group = makeGroup({ id: "a", needs: PASSING_NEEDS, roleArea: GREEN_ROLE_AREA });

    const result = matchGroups(makeGig(), [group], EMPTY_PROFILE);

    expect(result.matchedGroupIds).toEqual(["a"]);
    expect(result.groupTiers).toEqual({ a: "green" });
  });

  it("omits a group's id from matchedGroupIds when the gig fails that group's gate, but STILL records that group's tier (informational, independent of gate pass/fail)", () => {
    const group = makeGroup({ id: "a", needs: IMPOSSIBLE_NEEDS, roleArea: GREEN_ROLE_AREA });

    const result = matchGroups(makeGig(), [group], EMPTY_PROFILE);

    expect(result.matchedGroupIds).toEqual([]);
    expect(result.groupTiers).toEqual({ a: "green" }); // tier computed regardless
  });

  it("evaluates a gig against every group independently — clears one, fails another, tiers differ per group", () => {
    const groupA = makeGroup({ id: "a", needs: PASSING_NEEDS, roleArea: GREEN_ROLE_AREA });
    const groupB = makeGroup({ id: "b", needs: IMPOSSIBLE_NEEDS, roleArea: YELLOW_ROLE_AREA });

    const result = matchGroups(makeGig(), [groupA, groupB], EMPTY_PROFILE);

    expect(result.matchedGroupIds).toEqual(["a"]); // only cleared group A's gate
    expect(result.groupTiers).toEqual({ a: "green", b: "yellow" }); // both tiers recorded
  });

  it("defaults a group's tier to yellow (EMPTY_ROLE_AREA_CONFIG) when roleArea is omitted", () => {
    const group = makeGroup({ id: "a", needs: PASSING_NEEDS }); // no roleArea

    const result = matchGroups(makeGig(), [group], EMPTY_PROFILE);

    expect(result.matchedGroupIds).toEqual(["a"]);
    expect(result.groupTiers).toEqual({ a: "yellow" });
  });

  it("returns groupScores for every evaluated group, independent of gate pass/fail — same 'recorded regardless' convention as groupTiers", () => {
    const passing = makeGroup({ id: "a", needs: PASSING_NEEDS });
    const failing = makeGroup({ id: "b", needs: IMPOSSIBLE_NEEDS });

    const result = matchGroups(makeGig(), [passing, failing], EMPTY_PROFILE);

    expect(typeof result.groupScores.a).toBe("number");
    expect(typeof result.groupScores.b).toBe("number");
  });

  it("returns groupBands for every evaluated group -- in-band for a passing group, out-of-band for an impossible one", () => {
    const passing = makeGroup({ id: "a", needs: PASSING_NEEDS });
    const failing = makeGroup({ id: "b", needs: IMPOSSIBLE_NEEDS });

    const result = matchGroups(makeGig(), [passing, failing], EMPTY_PROFILE);

    expect(result.groupBands).toEqual({ a: "in-band", b: "out-of-band" });
  });

  it("returns near-band when the rate is close to but under a group's floor", () => {
    const nearFloorProfile: EngagementProfile = { id: "p", label: "Fractional", types: ["contract"], minRate: 150, highRate: 285, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" };
    const group = makeGroup({ id: "a", needs: { engagementProfiles: [nearFloorProfile], freshStageOnly: false, remoteOnly: false } });
    const gig = makeGig({ rate: { min: 130, unit: "hour" } }); // ~13.3% under $150 floor, within default 15% tolerance

    const result = matchGroups(gig, [group], EMPTY_PROFILE);

    expect(result.groupBands.a).toBe("near-band");
  });
});

describe("matchGroups: customizable-tier-scoring", () => {
  // makeGig() (no rate, no weeklyHours, no stage) + PASSING_NEEDS +
  // EMPTY_PROFILE (no roles/skills => fit=1) is a deterministic score of
  // 0.41 via gate.ts's scoreOf() (rateScore=0, fit=1, hoursScore=0.5,
  // freshScore=0.6 => 0.45*0 + 0.25*1 + 0.2*0.5 + 0.1*0.6 = 0.41) --
  // verified once here, then relied on as a known fixture value below.
  it("sanity check: the shared gig fixture's score is the known 0.41 value the tests below rely on", () => {
    const group = makeGroup({ id: "a", needs: PASSING_NEEDS });
    const result = matchGroups(makeGig(), [group], EMPTY_PROFILE);
    expect(result.groupScores.a).toBeCloseTo(0.41, 5);
  });

  it("a group with tierScoring:score-threshold uses the SCORE, never the keyword classifier — a roleArea that would keyword-tier red is overridden", () => {
    const RED_ROLE_AREA: RoleAreaConfig = { coreTitles: [], keywords: [], redKeywords: ["Fractional CTO"] };
    const group = makeGroup({
      id: "a",
      needs: PASSING_NEEDS,
      roleArea: RED_ROLE_AREA, // would keyword-tier this gig RED
      tierScoring: { kind: "score-threshold", green: 0.3, yellow: 0.1 }, // 0.41 clears green
    });

    const result = matchGroups(makeGig(), [group], EMPTY_PROFILE);

    expect(result.groupTiers.a).toBe("green");
  });

  it("a group with tierScoring:percentile uses the caller-supplied population, ignoring roleArea entirely", () => {
    const group = makeGroup({
      id: "a",
      needs: PASSING_NEEDS,
      roleArea: { coreTitles: [], keywords: [], redKeywords: ["Fractional CTO"] }, // would keyword-tier RED
      tierScoring: { kind: "percentile", greenPercentile: 80, yellowPercentile: 40 },
    });
    // 0.41 is greater than all 4 population values -> rank 100% -> green
    const scorePopulations = { a: [0.05, 0.1, 0.2, 0.3] };

    const result = matchGroups(makeGig(), [group], EMPTY_PROFILE, scorePopulations);

    expect(result.groupTiers.a).toBe("green");
  });

  it("percentile mode with no population entry for a group ranks at the middle (0.5) rather than crashing", () => {
    const group = makeGroup({
      id: "a",
      needs: PASSING_NEEDS,
      tierScoring: { kind: "percentile", greenPercentile: 80, yellowPercentile: 30 },
    });

    const result = matchGroups(makeGig(), [group], EMPTY_PROFILE, {}); // no "a" entry

    expect(result.groupTiers.a).toBe("yellow"); // rank 0.5 is between 30th and 80th percentile
  });

  it("two groups in the same call can use different tierScoring modes independently", () => {
    const keywordGroup = makeGroup({ id: "a", needs: PASSING_NEEDS, roleArea: GREEN_ROLE_AREA });
    const scoreGroup = makeGroup({
      id: "b",
      needs: PASSING_NEEDS,
      roleArea: { coreTitles: [], keywords: [], redKeywords: ["Fractional CTO"] }, // would keyword-tier RED
      tierScoring: { kind: "score-threshold", green: 0.3, yellow: 0.1 },
    });

    const result = matchGroups(makeGig(), [keywordGroup, scoreGroup], EMPTY_PROFILE);

    expect(result.groupTiers).toEqual({ a: "green", b: "green" }); // "a" via keywords, "b" via score -- same outcome, different reasoning
  });
});
