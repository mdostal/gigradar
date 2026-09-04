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
