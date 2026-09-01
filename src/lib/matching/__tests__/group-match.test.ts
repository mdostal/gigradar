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
});
