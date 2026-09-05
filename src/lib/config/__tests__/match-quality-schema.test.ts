import { describe, expect, it } from "vitest";
import { GroupConfigSchema } from "../schema.js";

// rate-band-match-quality epic, match-quality-settings-page story.
function baseGroup(matchQuality?: unknown) {
  return {
    id: "g1",
    label: "Group 1",
    needs: {
      engagementProfiles: [{ id: "p1", label: "Hourly", types: ["contract"], minRate: 100, highRate: 150, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" }],
      freshStageOnly: false,
      remoteOnly: false,
    },
    ...(matchQuality !== undefined ? { matchQuality } : {}),
  };
}

describe("GroupConfig.matchQuality schema", () => {
  it("is fully optional -- a group with no matchQuality field at all validates fine", () => {
    const result = GroupConfigSchema.safeParse(baseGroup());
    expect(result.success).toBe(true);
  });

  it("accepts both fields set to real values", () => {
    const result = GroupConfigSchema.safeParse(baseGroup({ nearBandTolerancePct: 20, hideOutOfBandByDefault: false }));
    expect(result.success).toBe(true);
  });

  it("accepts either field set alone -- both are independently optional", () => {
    expect(GroupConfigSchema.safeParse(baseGroup({ nearBandTolerancePct: 10 })).success).toBe(true);
    expect(GroupConfigSchema.safeParse(baseGroup({ hideOutOfBandByDefault: true })).success).toBe(true);
    expect(GroupConfigSchema.safeParse(baseGroup({})).success).toBe(true);
  });

  it("rejects a tolerance outside 0-100", () => {
    expect(GroupConfigSchema.safeParse(baseGroup({ nearBandTolerancePct: -1 })).success).toBe(false);
    expect(GroupConfigSchema.safeParse(baseGroup({ nearBandTolerancePct: 101 })).success).toBe(false);
  });

  it("accepts the boundary values 0 and 100", () => {
    expect(GroupConfigSchema.safeParse(baseGroup({ nearBandTolerancePct: 0 })).success).toBe(true);
    expect(GroupConfigSchema.safeParse(baseGroup({ nearBandTolerancePct: 100 })).success).toBe(true);
  });

  it("rejects a non-numeric tolerance or non-boolean hide flag", () => {
    expect(GroupConfigSchema.safeParse(baseGroup({ nearBandTolerancePct: "20" })).success).toBe(false);
    expect(GroupConfigSchema.safeParse(baseGroup({ hideOutOfBandByDefault: "yes" })).success).toBe(false);
  });
});
