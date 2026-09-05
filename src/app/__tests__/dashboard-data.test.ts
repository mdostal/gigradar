import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, recordScan } from "@/lib/store";
import { saveConfig } from "@/lib/config/save";
import { extractEngagementProfileSummaries, loadDashboardData, resolveGroupLabel, resolveHideOutOfBandDefault } from "../dashboard-data";

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
});
