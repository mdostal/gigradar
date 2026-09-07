import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db.js";
import { getLastScanCycle, recordScanCycle } from "../scan-cycles.js";

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-scan-cycles-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getLastScanCycle", () => {
  it("is undefined when no cycle has ever been recorded (brand-new install, or a DB predating this story)", () => {
    expect(getLastScanCycle({ db })).toBeUndefined();
  });

  it("round-trips a fully-completed cycle (empty incompleteSourceIds)", () => {
    recordScanCycle({ sourcesTotal: 8, incompleteSourceIds: [] }, { db, now: "2026-09-07T09:00:00.000Z" });
    expect(getLastScanCycle({ db })).toEqual({
      completedAt: "2026-09-07T09:00:00.000Z",
      sourcesTotal: 8,
      incompleteSourceIds: [],
    });
  });

  it("round-trips a partial cycle (real errored/skipped source ids)", () => {
    recordScanCycle(
      { sourcesTotal: 10, incompleteSourceIds: ["gofractional", "ateam"] },
      { db, now: "2026-09-07T09:00:00.000Z" },
    );
    expect(getLastScanCycle({ db })).toEqual({
      completedAt: "2026-09-07T09:00:00.000Z",
      sourcesTotal: 10,
      incompleteSourceIds: ["gofractional", "ateam"],
    });
  });

  it("returns only the MOST RECENT cycle across several recorded ones -- append-only history, not an update-in-place", () => {
    recordScanCycle({ sourcesTotal: 5, incompleteSourceIds: ["a"] }, { db, now: "2026-09-07T08:00:00.000Z" });
    recordScanCycle({ sourcesTotal: 5, incompleteSourceIds: [] }, { db, now: "2026-09-07T09:00:00.000Z" });
    recordScanCycle({ sourcesTotal: 5, incompleteSourceIds: ["b", "c"] }, { db, now: "2026-09-07T08:30:00.000Z" });

    const last = getLastScanCycle({ db });
    expect(last).toEqual({ completedAt: "2026-09-07T09:00:00.000Z", sourcesTotal: 5, incompleteSourceIds: [] });
  });

  it("every recorded cycle is kept (append-only) -- proves this isn't silently collapsing to one row", () => {
    recordScanCycle({ sourcesTotal: 5, incompleteSourceIds: [] }, { db, now: "2026-09-07T08:00:00.000Z" });
    recordScanCycle({ sourcesTotal: 5, incompleteSourceIds: ["a"] }, { db, now: "2026-09-07T09:00:00.000Z" });

    const rows = db.prepare("SELECT COUNT(*) AS n FROM scan_cycles").get() as { n: number };
    expect(rows.n).toBe(2);
  });
});
