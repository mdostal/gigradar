import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, recordScan } from "@/lib/store";
import { saveConfig } from "@/lib/config/save";
import { extractEngagementProfiles, extractEngagementProfileSummaries, extractRankBucketLabels, loadDashboardData, loadSonarSweepStatus, resolveGroupLabel, resolveHideOutOfBandDefault } from "../dashboard-data";

// Same isolation pattern as actions.test.ts: a fresh temp-file DB per test
// (GIGRADAR_DB_PATH) plus an isolated XDG_DATA_HOME for config.json, so this
// test can never touch this machine's real data dir (see this session's own
// standing "never touch real ~/.local/share/gigradar data dir" rule).
let tmpDir: string;

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    profile: { name: "Test", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: {
          engagementProfiles: [
            { id: "p1", label: "Hourly", types: ["contract"], minRate: 100, highRate: 150, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" },
          ],
          freshStageOnly: false,
          remoteOnly: true,
        },
      },
      {
        id: "g2",
        label: "Group 2",
        needs: {
          engagementProfiles: [
            { id: "p2", label: "Full-time", types: ["full-time"], minRate: 200000, highRate: 300000, maxHours: 40, maxHoursAtHighRate: 40, rateUnit: "year" },
          ],
          freshStageOnly: false,
          remoteOnly: true,
        },
      },
    ],
    sources: [],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-dashboard-data-test-"));
  process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
  process.env.XDG_DATA_HOME = tmpDir;
});

afterEach(() => {
  closeDb();
  delete process.env.GIGRADAR_DB_PATH;
  delete process.env.XDG_DATA_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("extractEngagementProfileSummaries", () => {
  it("reads the first group's profiles when groupId is omitted (the '/' unscoped route)", () => {
    const raw = { groups: [{ id: "g1", needs: { engagementProfiles: [{ id: "p1", label: "Hourly" }] } }, { id: "g2", needs: { engagementProfiles: [{ id: "p2", label: "Full-time" }] } }] };
    expect(extractEngagementProfileSummaries(raw)).toEqual([{ id: "p1", label: "Hourly" }]);
  });

  it("reads a SPECIFIC group's profiles by id when groupId is given, never assuming it's first", () => {
    const raw = { groups: [{ id: "g1", needs: { engagementProfiles: [{ id: "p1", label: "Hourly" }] } }, { id: "g2", needs: { engagementProfiles: [{ id: "p2", label: "Full-time" }] } }] };
    expect(extractEngagementProfileSummaries(raw, "g2")).toEqual([{ id: "p2", label: "Full-time" }]);
  });

  it("returns [] for a groupId with no matching group, or malformed/missing shapes, rather than throwing", () => {
    const raw = { groups: [{ id: "g1", needs: { engagementProfiles: [{ id: "p1", label: "Hourly" }] } }] };
    expect(extractEngagementProfileSummaries(raw, "does-not-exist")).toEqual([]);
    expect(extractEngagementProfileSummaries({})).toEqual([]);
    expect(extractEngagementProfileSummaries({ groups: "not an array" })).toEqual([]);
    expect(extractEngagementProfileSummaries({ groups: [{ id: "g1" }] })).toEqual([]);
  });
});

describe("resolveGroupLabel", () => {
  it("resolves a configured group id to its label", () => {
    const raw = { groups: [{ id: "g1", label: "Group 1" }, { id: "g2", label: "Group 2" }] };
    expect(resolveGroupLabel(raw, "g2")).toBe("Group 2");
  });

  it("returns undefined for a stale/unknown group id (renamed, removed, or a wrong URL) -- the '/[group]/' route treats this as a real 404", () => {
    const raw = { groups: [{ id: "g1", label: "Group 1" }] };
    expect(resolveGroupLabel(raw, "does-not-exist")).toBeUndefined();
    expect(resolveGroupLabel({}, "g1")).toBeUndefined();
  });
});

describe("resolveHideOutOfBandDefault", () => {
  it("reads the SPECIFIC group's own real setting when groupId is given", () => {
    const raw = { groups: [{ id: "g1", matchQuality: { hideOutOfBandByDefault: false } }, { id: "g2", matchQuality: { hideOutOfBandByDefault: true } }] };
    expect(resolveHideOutOfBandDefault(raw, "g1")).toBe(false);
    expect(resolveHideOutOfBandDefault(raw, "g2")).toBe(true);
  });

  it("reads the FIRST/primary group when groupId is omitted (the unscoped /gigs, /today routes)", () => {
    const raw = { groups: [{ id: "g1", matchQuality: { hideOutOfBandByDefault: false } }, { id: "g2", matchQuality: { hideOutOfBandByDefault: true } }] };
    expect(resolveHideOutOfBandDefault(raw)).toBe(false);
  });

  it("falls back to the documented default (true) for missing/malformed shapes, never throwing", () => {
    expect(resolveHideOutOfBandDefault({}, "g1")).toBe(true);
    expect(resolveHideOutOfBandDefault({ groups: [{ id: "g1" }] }, "g1")).toBe(true);
    expect(resolveHideOutOfBandDefault({ groups: [{ id: "g1", matchQuality: {} }] }, "g1")).toBe(true);
    expect(resolveHideOutOfBandDefault({ groups: "not an array" }, "g1")).toBe(true);
  });
});

describe("loadDashboardData", () => {
  it("returns every gig, unscoped, when groupId is omitted", () => {
    saveConfig(baseConfig());
    recordScan([
      {
        sourceId: "src-a",
        gigs: [
          { sourceId: "src-a", externalId: "1", title: "In group 1", url: "https://example.test/1", matchedGroupIds: ["g1"] },
          { sourceId: "src-a", externalId: "2", title: "In group 2", url: "https://example.test/2", matchedGroupIds: ["g2"] },
        ],
      },
    ]);

    const data = loadDashboardData();

    expect(data.gigs.map((g) => g.title).sort()).toEqual(["In group 1", "In group 2"]);
  });

  it("scopes gigs to the given groupId via matchedGroupIds", () => {
    saveConfig(baseConfig());
    recordScan([
      {
        sourceId: "src-a",
        gigs: [
          { sourceId: "src-a", externalId: "1", title: "In group 1", url: "https://example.test/1", matchedGroupIds: ["g1"] },
          { sourceId: "src-a", externalId: "2", title: "In group 2", url: "https://example.test/2", matchedGroupIds: ["g2"] },
          { sourceId: "src-a", externalId: "3", title: "In both", url: "https://example.test/3", matchedGroupIds: ["g1", "g2"] },
        ],
      },
    ]);

    const data = loadDashboardData("g1");

    expect(data.gigs.map((g) => g.title).sort()).toEqual(["In both", "In group 1"]);
  });

  it("scopes engagementProfiles to the given group, not always the first", () => {
    saveConfig(baseConfig());
    recordScan([{ sourceId: "src-a", gigs: [] }]);

    const data = loadDashboardData("g2");

    expect(data.engagementProfiles).toEqual([{ id: "p2", label: "Full-time" }]);
  });

  // match-warning-tooltip-clarity-and-reliability story.
  describe("profileMismatchByGigKey", () => {
    it("classifies a gig with no rate/employmentType/contractToHire at all as 'rate-not-comparable' when this group's only profile is salaried (the real fractionus/fractionaljobs shape, scoped to g2's full-time-only profile)", () => {
      saveConfig(baseConfig());
      recordScan([
        {
          sourceId: "src-a",
          gigs: [{ sourceId: "src-a", externalId: "1", title: "No rate published", url: "https://example.test/1", matchedGroupIds: ["g2"] }],
        },
      ]);

      const data = loadDashboardData("g2");
      const key = data.gigs[0]!.key;

      expect(data.profileMismatchByGigKey[key]).toBe("rate-not-comparable");
    });

    it("classifies a gig with a real, published rate that genuinely failed the floor as 'real-mismatch'", () => {
      saveConfig(baseConfig());
      recordScan([
        {
          sourceId: "src-a",
          gigs: [
            {
              sourceId: "src-a",
              externalId: "1",
              title: "Below floor",
              url: "https://example.test/1",
              matchedGroupIds: ["g1"],
              rate: { min: 10, unit: "hour" },
            },
          ],
        },
      ]);

      const data = loadDashboardData("g1");
      const key = data.gigs[0]!.key;

      expect(data.profileMismatchByGigKey[key]).toBe("real-mismatch");
    });

    it("has no entry at all for a gig that DID clear a profile", () => {
      saveConfig(baseConfig());
      recordScan([
        {
          sourceId: "src-a",
          gigs: [
            {
              sourceId: "src-a",
              externalId: "1",
              title: "Clears the floor",
              url: "https://example.test/1",
              matchedGroupIds: ["g1"],
              rate: { min: 120, unit: "hour" },
            },
          ],
        },
      ]);

      const data = loadDashboardData("g1");
      const key = data.gigs[0]!.key;

      expect(data.profileMismatchByGigKey[key]).toBeUndefined();
    });
  });
});

// sonar-sweep-header-global-masthead story (header-layout-cleanup epic).
describe("loadSonarSweepStatus", () => {
  it("returns 'Last scan: never run' and a null lastScanIso when no gig has ever been scanned", () => {
    saveConfig(baseConfig());

    const data = loadSonarSweepStatus();

    expect(data.lastScanIso).toBeNull();
    expect(data.status.lastScanLabel).toBe("Last scan: never run");
  });

  it("produces the SAME status/lastScanIso loadDashboardData() would, without needing the full gig rows", () => {
    saveConfig(baseConfig());
    recordScan([
      {
        sourceId: "src-a",
        gigs: [
          { sourceId: "src-a", externalId: "1", title: "In group 1", url: "https://example.test/1", matchedGroupIds: ["g1"] },
          { sourceId: "src-a", externalId: "2", title: "In group 2", url: "https://example.test/2", matchedGroupIds: ["g2"] },
        ],
      },
    ]);

    const full = loadDashboardData();
    const lightweight = loadSonarSweepStatus();

    expect(lightweight.lastScanIso).toBe(full.lastScanIso);
    expect(lightweight.status).toEqual(full.status);
  });

  it("reflects the real MAX(last_seen) across every group, not just the primary/first one", () => {
    saveConfig(baseConfig());
    recordScan([{ sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "g1 gig", url: "https://example.test/1", matchedGroupIds: ["g1"] }] }], {
      now: "2026-01-01T00:00:00.000Z",
    });
    recordScan([{ sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "2", title: "g2 gig", url: "https://example.test/2", matchedGroupIds: ["g2"] }] }], {
      now: "2026-01-05T00:00:00.000Z",
    });

    const data = loadSonarSweepStatus();

    expect(data.lastScanIso).toBe("2026-01-05T00:00:00.000Z");
  });
});

describe("extractEngagementProfiles", () => {
  it("returns the full, schema-valid EngagementProfile for the given group, not just {id, label}", () => {
    const raw = baseConfig();
    expect(extractEngagementProfiles(raw, "g1")).toEqual([
      { id: "p1", label: "Hourly", types: ["contract"], minRate: 100, highRate: 150, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" },
    ]);
  });

  it("reads the first/primary group when groupId is omitted", () => {
    const raw = baseConfig();
    expect(extractEngagementProfiles(raw).map((p) => p.id)).toEqual(["p1"]);
  });

  it("returns [] for a groupId with no matching group, or malformed/missing shapes, rather than throwing", () => {
    expect(extractEngagementProfiles({ groups: [{ id: "g1" }] }, "does-not-exist")).toEqual([]);
    expect(extractEngagementProfiles({})).toEqual([]);
    expect(extractEngagementProfiles({ groups: "not an array" })).toEqual([]);
  });

  it("returns [] when a configured profile is missing required fields (e.g. the {id, label}-only shape extractEngagementProfileSummaries() tolerates) rather than partially validating", () => {
    const raw = { groups: [{ id: "g1", needs: { engagementProfiles: [{ id: "p1", label: "Hourly" }] } }] };
    expect(extractEngagementProfiles(raw, "g1")).toEqual([]);
  });
});

describe("extractRankBucketLabels", () => {
  it("reads the SPECIFIC group's own bucket labels, in configured order, when groupId is given", () => {
    const raw = { groups: [{ id: "g1", rankBuckets: [{ label: "Tier 1" }, { label: "Tier 2" }] }, { id: "g2", rankBuckets: [{ label: "Premium" }] }] };
    expect(extractRankBucketLabels(raw, "g2")).toEqual(["Premium"]);
  });

  it("reads the FIRST/primary group when groupId is omitted", () => {
    const raw = { groups: [{ id: "g1", rankBuckets: [{ label: "Tier 1" }, { label: "Tier 2" }] }, { id: "g2", rankBuckets: [{ label: "Premium" }] }] };
    expect(extractRankBucketLabels(raw)).toEqual(["Tier 1", "Tier 2"]);
  });

  it("returns [] for missing/malformed shapes, never throwing -- the common case (rankBuckets not configured at all)", () => {
    expect(extractRankBucketLabels({})).toEqual([]);
    expect(extractRankBucketLabels({ groups: [{ id: "g1" }] }, "g1")).toEqual([]);
    expect(extractRankBucketLabels({ groups: "not an array" })).toEqual([]);
    expect(extractRankBucketLabels({ groups: [{ id: "g1", rankBuckets: [{ notLabel: "x" }] }] }, "g1")).toEqual([]);
  });
});
