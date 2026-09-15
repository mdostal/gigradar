import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config, Gig } from "../../types.js";
import { closeDb, getDb } from "../db.js";
import { getGig, recordScan } from "../gigs.js";
import { ARCHIVE_AFTER_DAYS, RETIER_AFTER_DAYS, runStaleGigMaintenance } from "../maintenance.js";

// Live-reproduced bug this story fixes: a gig unseen for weeks kept
// whatever tier it was stamped with at first-seen, even after the owner's
// own redKeywords config changed to correctly exclude it (real example:
// fractionus:fractional-coo-at-trustech-pro-inc, 18+ days stale, still
// green). Same fresh-temp-db-per-test convention as store.test.ts.
let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-maintenance-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeGig(overrides: Partial<Gig> & { sourceId: string; externalId: string }): Gig {
  return {
    title: "Fractional COO",
    url: `https://example.test/${overrides.sourceId}/${overrides.externalId}`,
    ...overrides,
  };
}

function makeConfig(): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: { engagementProfiles: [{ id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: false },
        // Real, current config: COO explicitly excluded -- matches the
        // owner's own real redKeywords list (this session).
        roleArea: { coreTitles: ["cto"], keywords: [], redKeywords: ["coo"] },
      },
    ],
    sources: [{ id: "src-a", enabled: true }],
  };
}

const T0 = "2026-08-01T00:00:00.000Z";

describe("runStaleGigMaintenance: re-tier", () => {
  it("recomputes tier against CURRENT config for a gig unseen for RETIER_AFTER_DAYS+, correcting a stale GREEN COO match to RED", () => {
    // Simulate the real bug: this gig was inserted (and tiered) BEFORE the
    // owner's redKeywords included "coo" -- stamp it green directly via a
    // raw scan the same way an old, since-corrected config once would have.
    recordScan([{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green" }] }], { db, now: T0 });
    expect(getGig("src-a:1", { db })?.tier).toBe("green");

    const now = new Date(T0).getTime() + (RETIER_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.retiered).toBe(1);
    expect(result.archived).toBe(0);
    expect(getGig("src-a:1", { db })?.tier).toBe("red");
  });

  it("does NOT touch a gig re-seen more recently than RETIER_AFTER_DAYS", () => {
    recordScan([{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green" }] }], { db, now: T0 });

    const now = new Date(T0).getTime() + (RETIER_AFTER_DAYS - 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.retiered).toBe(0);
    expect(getGig("src-a:1", { db })?.tier).toBe("green");
  });

  it("never touches a gig that isn't status:new (e.g. already applied)", () => {
    recordScan([{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green" }] }], { db, now: T0 });
    db.prepare("UPDATE gigs SET status = 'applied' WHERE key = 'src-a:1'").run();

    const now = new Date(T0).getTime() + (ARCHIVE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.retiered).toBe(0);
    expect(result.archived).toBe(0);
    const stored = getGig("src-a:1", { db });
    expect(stored?.status).toBe("applied");
    expect(stored?.tier).toBe("green");
  });
});

describe("runStaleGigMaintenance: archive", () => {
  it("archives a gig unseen for ARCHIVE_AFTER_DAYS+ with outcomeReason expired_unapplied", () => {
    recordScan([{ sourceId: "src-a", gigs: [makeGig({ sourceId: "src-a", externalId: "1" })] }], { db, now: T0 });

    const now = new Date(T0).getTime() + (ARCHIVE_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.archived).toBe(1);
    const stored = getGig("src-a:1", { db });
    expect(stored?.status).toBe("archived");
    expect(stored?.outcomeReason).toBe("expired_unapplied");
    expect(stored?.outcomeNote).toMatch(/not re-seen/i);
  });

  it("archives instead of re-tiering once a gig crosses ARCHIVE_AFTER_DAYS, even though it also qualifies for re-tier", () => {
    recordScan([{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green" }] }], { db, now: T0 });

    const now = new Date(T0).getTime() + (ARCHIVE_AFTER_DAYS + 5) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.archived).toBe(1);
    expect(result.retiered).toBe(0);
    // tier is left as whatever it was -- archiving, not re-tiering, is the terminal action here.
    expect(getGig("src-a:1", { db })?.tier).toBe("green");
  });
});

describe("runStaleGigMaintenance: score-based tierScoring groups are skipped for re-tier", () => {
  it("does not re-tier a gig whose primary group uses percentile tierScoring (population data not reconstructed here)", () => {
    recordScan([{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green" }] }], { db, now: T0 });

    const config = makeConfig();
    config.groups[0]!.tierScoring = { kind: "percentile", greenPercentile: 80, yellowPercentile: 50 };

    const now = new Date(T0).getTime() + (RETIER_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(config, { db, now });

    expect(result.retiered).toBe(0);
    expect(getGig("src-a:1", { db })?.tier).toBe("green");
  });
});

// stale-band-retier-alongside-tier story. Live-confirmed real bug: a gig
// whose rate falls outside every group's engagement profile never gets
// its `matchBand` recomputed by this pass at all -- it keeps stale/absent
// band data forever, which dashboard-filter.ts's resolveDisplayBand()
// then fails OPEN as "in-band", defeating the "Hide out-of-band" filter
// (default ON) for the exact population of aging gigs it exists to catch.
describe("runStaleGigMaintenance: re-band", () => {
  it("recomputes matchBand against CURRENT config for a gig unseen for RETIER_AFTER_DAYS+, correcting a stale out-of-band rate to in-band", () => {
    // $500/hr clears g1's $0-999,999/hr band easily -- but this gig was
    // never scanned through apply/runner.ts (recordScan() here is the raw
    // store primitive), so it has no matchBand/matchedGroupBands at all
    // yet, exactly the real, live-confirmed shape of a pre-epic or
    // never-rescanned gig.
    recordScan(
      [{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green", rate: { min: 500, max: 500, unit: "hour" } }] }],
      { db, now: T0 },
    );
    expect(getGig("src-a:1", { db })?.matchBand).toBeUndefined();

    const now = new Date(T0).getTime() + (RETIER_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.rebanded).toBe(1);
    const stored = getGig("src-a:1", { db });
    expect(stored?.matchBand).toBe("in-band");
    expect(stored?.matchedGroupBands).toEqual({ g1: "in-band" });
  });

  it("recomputes matchBand for a gig whose primary group uses percentile tierScoring -- band recompute has no population dependency, unlike tier", () => {
    // $1/hr fails every profile's real floor below, regardless of tierScoring mode.
    recordScan(
      [{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green", rate: { min: 1, max: 1, unit: "hour" } }] }],
      { db, now: T0 },
    );

    const config = makeConfig();
    config.groups[0]!.tierScoring = { kind: "percentile", greenPercentile: 80, yellowPercentile: 50 };
    config.groups[0]!.needs.engagementProfiles = [
      { id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 150, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" },
    ];

    const now = new Date(T0).getTime() + (RETIER_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(config, { db, now });

    expect(result.retiered).toBe(0); // still skipped, unchanged behavior
    expect(result.rebanded).toBe(1); // but band recompute still runs
    expect(getGig("src-a:1", { db })?.matchBand).toBe("out-of-band");
  });

  it("does NOT recompute matchBand for a gig re-seen more recently than RETIER_AFTER_DAYS", () => {
    recordScan(
      [{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green", rate: { min: 500, max: 500, unit: "hour" } }] }],
      { db, now: T0 },
    );

    const now = new Date(T0).getTime() + (RETIER_AFTER_DAYS - 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.rebanded).toBe(0);
    expect(getGig("src-a:1", { db })?.matchBand).toBeUndefined();
  });

  it("does not rebanded a gig whose recomputed band is unchanged from its stored value", () => {
    recordScan(
      [{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green", rate: { min: 500, max: 500, unit: "hour" }, matchBand: "in-band", matchedGroupBands: { g1: "in-band" } }] }],
      { db, now: T0 },
    );

    const now = new Date(T0).getTime() + (RETIER_AFTER_DAYS + 1) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.rebanded).toBe(0);
  });

  it("archives instead of re-banding once a gig crosses ARCHIVE_AFTER_DAYS", () => {
    recordScan([{ sourceId: "src-a", gigs: [{ ...makeGig({ sourceId: "src-a", externalId: "1" }), tier: "green" }] }], { db, now: T0 });

    const now = new Date(T0).getTime() + (ARCHIVE_AFTER_DAYS + 5) * 24 * 60 * 60 * 1000;
    const result = runStaleGigMaintenance(makeConfig(), { db, now });

    expect(result.archived).toBe(1);
    expect(result.rebanded).toBe(0);
  });
});
