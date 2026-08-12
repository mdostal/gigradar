import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Gig } from "../../types.js";
import { closeDb, getDb } from "../db.js";
import { getGig, listGigs, recordScan } from "../gigs.js";
import type { DatabaseSync } from "node:sqlite";

// All tests use a fresh temp-file db per test (never :memory: for the whole
// suite, since the concurrent-writer test needs a real file two separate
// processes can both open) and clean up afterward. Zero network calls.
let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-store-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeGig(overrides: Partial<Gig> & { sourceId: string; externalId: string }): Gig {
  return {
    title: "Fractional CTO",
    url: `https://example.test/${overrides.sourceId}/${overrides.externalId}`,
    ...overrides,
  };
}

describe("recordScan: basic upsert", () => {
  it("inserts a new gig with status 'new' and firstSeen === lastSeen", () => {
    const gig = makeGig({ sourceId: "src-a", externalId: "1", title: "Fractional CTO", company: "Acme" });
    const now = "2026-01-01T00:00:00.000Z";

    const summary = recordScan([{ sourceId: "src-a", gigs: [gig] }], { db, now });

    expect(summary.upserted).toEqual([{ key: "src-a:1", inserted: true }]);
    expect(summary.sourcesWithResults).toEqual(["src-a"]);
    expect(summary.flaggedUnavailable).toEqual([]);
    expect(summary.reappeared).toEqual([]);

    const stored = getGig("src-a:1", { db });
    expect(stored).toBeDefined();
    expect(stored?.title).toBe("Fractional CTO");
    expect(stored?.company).toBe("Acme");
    expect(stored?.status).toBe("new");
    expect(stored?.firstSeen).toBe(now);
    expect(stored?.lastSeen).toBe(now);
    expect(stored?.unavailableSince).toBeNull();
    expect(stored?.reappearedAt).toBeNull();
  });

  it("round-trips rate, remote, contractToHire and raw through the store", () => {
    const gig = makeGig({
      sourceId: "src-a",
      externalId: "2",
      rate: { min: 150, max: 220, unit: "hour" },
      weeklyHours: 20,
      remote: true,
      contractToHire: false,
      stage: "fresh",
      postedAt: "2026-01-01",
      description: "Build stuff",
      raw: { foo: "bar" },
    });

    recordScan([{ sourceId: "src-a", gigs: [gig] }], { db, now: "2026-01-01T00:00:00.000Z" });

    const stored = getGig("src-a:2", { db });
    expect(stored?.rate).toEqual({ min: 150, max: 220, unit: "hour" });
    expect(stored?.weeklyHours).toBe(20);
    expect(stored?.remote).toBe(true);
    expect(stored?.contractToHire).toBe(false);
    expect(stored?.stage).toBe("fresh");
    expect(stored?.postedAt).toBe("2026-01-01");
    expect(stored?.description).toBe("Build stuff");
    expect(stored?.raw).toEqual({ foo: "bar" });
  });
});

describe("recordScan: status and firstSeen survive a re-scan", () => {
  it("never resets status away from a user-set value, and firstSeen never moves", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-08T00:00:00.000Z";
    const gig = makeGig({ sourceId: "src-a", externalId: "1", title: "Fractional CTO" });

    recordScan([{ sourceId: "src-a", gigs: [gig] }], { db, now: t0 });

    // The user marks it applied — a real product action, not something a scan does.
    db.prepare("UPDATE gigs SET status = 'applied' WHERE key = 'src-a:1'").run();

    // Re-scan a week later; the source's title text changed slightly.
    const updatedGig = makeGig({ sourceId: "src-a", externalId: "1", title: "Fractional CTO (updated)" });
    const summary = recordScan([{ sourceId: "src-a", gigs: [updatedGig] }], { db, now: t1 });

    expect(summary.upserted).toEqual([{ key: "src-a:1", inserted: false }]);

    const stored = getGig("src-a:1", { db });
    expect(stored?.status).toBe("applied"); // NOT reset to 'new'
    expect(stored?.firstSeen).toBe(t0); // never moves
    expect(stored?.lastSeen).toBe(t1); // bumped
    expect(stored?.title).toBe("Fractional CTO (updated)"); // content still refreshed
  });
});

describe("delisting detection", () => {
  it("flags a gig unavailable when its source returns results but this gig is missing", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-02T00:00:00.000Z";
    const gigA = makeGig({ sourceId: "src-a", externalId: "1" });
    const gigB = makeGig({ sourceId: "src-a", externalId: "2" });

    recordScan([{ sourceId: "src-a", gigs: [gigA, gigB] }], { db, now: t0 });

    // Second scan: src-a returns results again, but gigA didn't reappear.
    const summary = recordScan([{ sourceId: "src-a", gigs: [gigB] }], { db, now: t1 });

    expect(summary.sourcesWithResults).toEqual(["src-a"]);
    expect(summary.flaggedUnavailable).toEqual(["src-a:1"]);

    expect(getGig("src-a:1", { db })?.unavailableSince).toBe(t1);
    expect(getGig("src-a:2", { db })?.unavailableSince).toBeNull(); // present this scan, untouched
  });

  it("never flags anything when the source returns zero results this scan", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-02T00:00:00.000Z";
    const gigA = makeGig({ sourceId: "src-a", externalId: "1" });

    recordScan([{ sourceId: "src-a", gigs: [gigA] }], { db, now: t0 });

    // src-a ran fine but genuinely found nothing this scan — an explicit empty array.
    const summary = recordScan([{ sourceId: "src-a", gigs: [] }], { db, now: t1 });

    expect(summary.sourcesWithResults).toEqual([]);
    expect(summary.flaggedUnavailable).toEqual([]);
    expect(getGig("src-a:1", { db })?.unavailableSince).toBeNull();
  });

  it("never flags anything when the source errored (is absent from batches entirely)", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-02T00:00:00.000Z";
    const gigA = makeGig({ sourceId: "src-a", externalId: "1" });

    recordScan([{ sourceId: "src-a", gigs: [gigA] }], { db, now: t0 });

    // src-a's fetch threw this scan (e.g. auth expired) — the runner reports
    // it as an error and never calls recordScan for it at all.
    const summary = recordScan([], { db, now: t1 });

    expect(summary.sourcesWithResults).toEqual([]);
    expect(summary.flaggedUnavailable).toEqual([]);
    expect(getGig("src-a:1", { db })?.unavailableSince).toBeNull();
  });

  it("does not let one source's results flag another source's gigs", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-02T00:00:00.000Z";
    const gigA = makeGig({ sourceId: "src-a", externalId: "1" });
    const gigB = makeGig({ sourceId: "src-b", externalId: "1" });

    recordScan(
      [
        { sourceId: "src-a", gigs: [gigA] },
        { sourceId: "src-b", gigs: [gigB] },
      ],
      { db, now: t0 },
    );

    // Only src-b scans this round; src-a is simply absent (e.g. disabled/errored).
    const summary = recordScan([{ sourceId: "src-b", gigs: [gigB] }], { db, now: t1 });

    expect(summary.flaggedUnavailable).toEqual([]);
    expect(getGig("src-a:1", { db })?.unavailableSince).toBeNull();
  });
});

describe("reappearance", () => {
  it("clears unavailableSince and sets reappearedAt when a flagged gig comes back", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-02T00:00:00.000Z";
    const t2 = "2026-01-03T00:00:00.000Z";
    const gigA = makeGig({ sourceId: "src-a", externalId: "1" });
    const gigB = makeGig({ sourceId: "src-a", externalId: "2" });

    recordScan([{ sourceId: "src-a", gigs: [gigA, gigB] }], { db, now: t0 });
    recordScan([{ sourceId: "src-a", gigs: [gigB] }], { db, now: t1 }); // gigA flagged unavailable

    expect(getGig("src-a:1", { db })?.unavailableSince).toBe(t1);

    const summary = recordScan([{ sourceId: "src-a", gigs: [gigA, gigB] }], { db, now: t2 }); // gigA is back

    expect(summary.reappeared).toEqual(["src-a:1"]);
    const stored = getGig("src-a:1", { db });
    expect(stored?.unavailableSince).toBeNull();
    expect(stored?.reappearedAt).toBe(t2);
  });
});

describe("listGigs", () => {
  it("filters by status, sourceId and unavailable", () => {
    const t0 = "2026-01-01T00:00:00.000Z";
    recordScan(
      [
        { sourceId: "src-a", gigs: [makeGig({ sourceId: "src-a", externalId: "1" })] },
        { sourceId: "src-b", gigs: [makeGig({ sourceId: "src-b", externalId: "1" })] },
      ],
      { db, now: t0 },
    );
    // src-a's gig disappears next scan while src-a keeps returning other results.
    recordScan(
      [
        { sourceId: "src-a", gigs: [makeGig({ sourceId: "src-a", externalId: "99" })] },
        { sourceId: "src-b", gigs: [makeGig({ sourceId: "src-b", externalId: "1" })] },
      ],
      { db, now: "2026-01-02T00:00:00.000Z" },
    );

    expect(listGigs({ sourceId: "src-b" }, { db }).map((g) => g.key)).toEqual(["src-b:1"]);
    expect(listGigs({ unavailable: true }, { db }).map((g) => g.key)).toEqual(["src-a:1"]);
    expect(listGigs({ status: "new" }, { db })).toHaveLength(3);
    expect(listGigs({}, { db })).toHaveLength(3); // no filter => everything
  });
});

describe("concurrent writers", () => {
  it("lets two separate connections write to the same file at once without SQLITE_BUSY", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/concurrent-writer.ts", import.meta.url));
    // Close this test's own connection first — the point is two OTHER
    // processes sharing the file, not three connections at once.
    closeDb();

    const runWriter = (sourceId: string, count: number) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", fixture, dbPath, sourceId, String(count)], {
          env: process.env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      });

    // Launched together (not awaited one at a time) so they genuinely overlap.
    const [resultA, resultB] = await Promise.all([runWriter("writer-a", 25), runWriter("writer-b", 25)]);

    expect(resultA.stderr).toBe("");
    expect(resultB.stderr).toBe("");
    expect(resultA.stderr).not.toMatch(/SQLITE_BUSY/);
    expect(resultB.stderr).not.toMatch(/SQLITE_BUSY/);
    expect(resultA.code).toBe(0);
    expect(resultB.code).toBe(0);

    db = getDb({ path: dbPath });
    expect(listGigs({ sourceId: "writer-a" }, { db })).toHaveLength(25);
    expect(listGigs({ sourceId: "writer-b" }, { db })).toHaveLength(25);
  }, 30_000);
});
