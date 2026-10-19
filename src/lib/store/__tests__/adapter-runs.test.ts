import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MatchResult } from "../../types.js";
import { closeDb, getDb } from "../db.js";
import { recordScan } from "../gigs.js";
import {
  completeAdapterRun,
  createAdapterRun,
  failAdapterRun,
  getAdapterRun,
  getAdapterRunResult,
  getLatestAdapterRun,
  listAdapterRunResults,
} from "../adapter-runs.js";

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-adapter-runs-test-"));
  db = getDb({ path: path.join(tmpDir, "gigs.db") });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function result(externalId: string, pass: boolean, score: number, reasons: string[]): MatchResult {
  return {
    gig: { sourceId: "s", externalId, title: `Gig ${externalId}`, url: `https://example.com/${externalId}`, raw: { big: "payload" } },
    pass,
    reasons,
    score,
    tier: pass ? "green" : "red",
    matchedProfiles: [],
  };
}

function seedGigs(...ids: string[]) {
  recordScan([{ sourceId: "s", gigs: ids.map((id) => ({ sourceId: "s", externalId: id, title: `Gig ${id}`, url: `https://example.com/${id}` })) }], { db });
}

describe("adapter runs store", () => {
  it("creates a running run, then completes it with every result's reasons verbatim", () => {
    seedGigs("a", "b", "c");
    expect(createAdapterRun("r1", { db, now: "2026-10-19T00:00:00.000Z" })).toMatchObject({ id: "r1", status: "running", finishedAt: null, passedCount: null });
    const reasons = ["✓ matched profile: Fractional", "✓ role/skill fit (40%)"];
    completeAdapterRun(
      "r1",
      {
        sourcesTotal: 2,
        newCount: 3,
        errors: [{ sourceId: "x", message: "no such registered source" }],
        results: [result("a", true, 0.4, reasons), result("b", true, 0.9, ["✓ ok"]), result("c", false, 0, ["✗ not remote"])],
      },
      { db, now: "2026-10-19T00:01:00.000Z" },
    );
    expect(getAdapterRun("r1", { db })).toEqual({
      id: "r1",
      status: "succeeded",
      startedAt: "2026-10-19T00:00:00.000Z",
      finishedAt: "2026-10-19T00:01:00.000Z",
      sourcesTotal: 2,
      passedCount: 2,
      rejectedCount: 1,
      newCount: 3,
      errors: [{ sourceId: "x", message: "no such registered source" }],
      error: null,
    });
    // Passed first by descending score, then rejected.
    expect(listAdapterRunResults("r1", { db }).map((r) => r.gigKey)).toEqual(["s:b", "s:a", "s:c"]);
    const a = getAdapterRunResult("r1", "s:a", { db })!;
    expect(a.reasons).toEqual(reasons);
    expect(a.gig).not.toHaveProperty("raw");
    expect(getAdapterRunResult("r1", "s:c", { db })).toMatchObject({ pass: false, tier: "red", reasons: ["✗ not remote"] });
  });

  it("stores nothing when a result references a gig the scan never recorded (atomic)", () => {
    seedGigs("a");
    createAdapterRun("r1", { db });
    expect(() =>
      completeAdapterRun("r1", { sourcesTotal: 1, newCount: 0, errors: [], results: [result("a", true, 1, []), result("ghost", true, 1, [])] }, { db }),
    ).toThrow();
    expect(getAdapterRun("r1", { db })?.status).toBe("running");
    expect(listAdapterRunResults("r1", { db })).toEqual([]);
  });

  it("records a failure and finds the latest run overall or by status", () => {
    createAdapterRun("old", { db, now: "2026-10-18T00:00:00.000Z" });
    completeAdapterRun("old", { sourcesTotal: 0, newCount: 0, errors: [], results: [] }, { db });
    createAdapterRun("new", { db, now: "2026-10-19T00:00:00.000Z" });
    failAdapterRun("new", "failed", "boom", { db, sourcesTotal: 3 });
    expect(getAdapterRun("new", { db })).toMatchObject({ status: "failed", error: "boom", sourcesTotal: 3 });
    expect(getLatestAdapterRun({ db })?.id).toBe("new");
    expect(getLatestAdapterRun({ db, status: "succeeded" })?.id).toBe("old");
    expect(getAdapterRun("missing", { db })).toBeUndefined();
  });
});
