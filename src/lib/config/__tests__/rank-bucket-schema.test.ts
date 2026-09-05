import { describe, expect, it } from "vitest";
import { GroupConfigSchema } from "../schema.js";

// rank-buckets epic, rank-bucket-core story.
function baseGroup(rankBuckets?: unknown, rankBucketAiOverlay?: unknown) {
  return {
    id: "g1",
    label: "Group 1",
    needs: {
      engagementProfiles: [{ id: "p1", label: "Hourly", types: ["contract"], minRate: 100, highRate: 150, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" }],
      freshStageOnly: false,
      remoteOnly: false,
    },
    ...(rankBuckets !== undefined ? { rankBuckets } : {}),
    ...(rankBucketAiOverlay !== undefined ? { rankBucketAiOverlay } : {}),
  };
}

describe("GroupConfig.rankBuckets schema", () => {
  it("is fully optional -- a group with neither field validates fine", () => {
    expect(GroupConfigSchema.safeParse(baseGroup()).success).toBe(true);
  });

  it("accepts a full ordered list with every optional criterion set", () => {
    const result = GroupConfigSchema.safeParse(
      baseGroup([
        { label: "Tier 1", description: "Series B+, remote-first", minRate: 200, maxRate: 300, keywords: ["CTO"] },
        { label: "Tier 2", minRate: 100 },
      ]),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a rule with only a label -- 'not yet configured' is a valid state at the schema level", () => {
    expect(GroupConfigSchema.safeParse(baseGroup([{ label: "Tier 1" }])).success).toBe(true);
  });

  it("rejects a rule with an empty label", () => {
    expect(GroupConfigSchema.safeParse(baseGroup([{ label: "" }])).success).toBe(false);
  });

  it("rejects a negative minRate/maxRate", () => {
    expect(GroupConfigSchema.safeParse(baseGroup([{ label: "Tier 1", minRate: -5 }])).success).toBe(false);
    expect(GroupConfigSchema.safeParse(baseGroup([{ label: "Tier 1", maxRate: -5 }])).success).toBe(false);
  });

  it("accepts rankBucketAiOverlay as a plain boolean, independent of rankBuckets", () => {
    expect(GroupConfigSchema.safeParse(baseGroup(undefined, true)).success).toBe(true);
    expect(GroupConfigSchema.safeParse(baseGroup(undefined, false)).success).toBe(true);
  });

  it("rejects a non-boolean rankBucketAiOverlay", () => {
    expect(GroupConfigSchema.safeParse(baseGroup(undefined, "yes")).success).toBe(false);
  });
});
