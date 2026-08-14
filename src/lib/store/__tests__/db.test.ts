// Covers ensureDraftsSubmittingStatus() (graduated-auto-fire-trust epic) —
// the CHECK-constraint rebuild-via-temp-table migration db.ts's own header
// comment describes. Unlike ensureColumn()'s plain ALTER TABLE ADD COLUMN,
// this one is genuinely risky (rename/recreate/copy/drop against a
// pre-existing DB), so it gets a dedicated test simulating a real
// pre-migration database, not just implicit coverage via a fresh :memory: DB
// (which never exercises the migration path at all — SCHEMA_SQL already has
// 'submitting' baked in on a brand-new table).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db.js";
import { recordScan } from "../gigs.js";
import { getDraft, saveDraft, setDraftStatus } from "../drafts.js";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-db-migration-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Hand-builds a pre-existing DB with the OLD (pre-'submitting') schema —
 * mirrors exactly what a real user's DB file looked like before this
 * story shipped — with one real gig + one real draft row already in it, so
 * the migration test can assert the data survives the rename/recreate/copy.
 */
function seedPreMigrationDb(): void {
  const db: DatabaseSyncType = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE gigs (
      key TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
      title TEXT NOT NULL, company TEXT, url TEXT NOT NULL, rate_min REAL, rate_max REAL,
      rate_unit TEXT, weekly_hours REAL, remote INTEGER, contract_to_hire INTEGER,
      employment_type TEXT, stage TEXT, posted_at TEXT, description TEXT, raw TEXT,
      tier TEXT, matched_profile_ids TEXT,
      status TEXT NOT NULL DEFAULT 'new', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      unavailable_since TEXT, reappeared_at TEXT
    ) STRICT;
    CREATE TABLE application_drafts (
      gig_key TEXT PRIMARY KEY REFERENCES gigs(key),
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected', 'submitted')),
      generated_at TEXT NOT NULL, approved_at TEXT, submitted_at TEXT
    ) STRICT;
  `);
  db.prepare(
    `INSERT INTO gigs (key, source_id, external_id, title, url, status, first_seen, last_seen)
     VALUES ('src-a:1', 'src-a', '1', 'Fractional CTO', 'https://example.test/1', 'new', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO application_drafts (gig_key, content, status, generated_at, approved_at)
     VALUES ('src-a:1', '{"coverText":"hi","answers":{}}', 'approved', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.close();
}

describe("ensureDraftsSubmittingStatus (pre-existing DB migration)", () => {
  it("lets a 'submitting' draft be written on a DB that pre-dates this status value", () => {
    seedPreMigrationDb();

    const db = getDb({ path: dbPath });
    // The pre-migration CHECK constraint would have rejected this insert
    // outright — reaching setDraftStatus without throwing proves the
    // migration actually ran and replaced the constraint.
    expect(() => setDraftStatus("src-a:1", "submitting", { db, now: "2026-01-02T00:00:00.000Z" })).not.toThrow();
    expect(getDraft("src-a:1", { db })?.status).toBe("submitting");
  });

  it("preserves the pre-existing gig and draft rows exactly across the migration", () => {
    seedPreMigrationDb();

    const db = getDb({ path: dbPath });
    const draft = getDraft("src-a:1", { db });
    expect(draft?.status).toBe("approved");
    expect(draft?.content).toEqual({ coverText: "hi", answers: {} });
    expect(draft?.approvedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("is a no-op (idempotent) on a DB that already has the new CHECK constraint", () => {
    const db = getDb({ path: dbPath }); // fresh DB — SCHEMA_SQL already includes 'submitting'
    recordScan([{ sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "x", url: "https://x.test" }] }], {
      db,
      now: "2026-01-01T00:00:00.000Z",
    });
    saveDraft("src-a:1", { coverText: "hi", answers: {} }, { db, now: "2026-01-01T00:00:00.000Z" });

    // Re-opening the same path must not blow away the row that already exists.
    closeDb();
    const db2 = getDb({ path: dbPath });
    expect(getDraft("src-a:1", { db: db2 })).toBeDefined();
  });
});
