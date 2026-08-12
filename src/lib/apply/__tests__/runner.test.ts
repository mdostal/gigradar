import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config, Gig, RoleAreaConfig } from "../../types.js";
import { registerSource } from "../../sources/source.js";
import { closeDb, getDb, getGig, listGigs } from "../../store/index.js";
import { runRadar } from "../runner.js";

// Exercises the REAL runner path (runRadar -> gate -> recordScan/store), not
// just the store's own prior unit tests (see src/lib/store/__tests__). The
// registered source below has id "braintrust" and implements the real
// `Source` contract, but its `fetch` is a controllable, network-free test
// double (set via `nextGigs` before each call) — this file never imports the
// real src/lib/sources/braintrust.ts, so there's no duplicate-id collision
// and no live network call.
let nextGigs: Gig[] = [];
registerSource({
  id: "braintrust",
  label: "Braintrust (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    return nextGigs;
  },
});

// A second registered double that can be told to throw, standing in for a
// source whose session/API key expired (auth: "browser-session" | "api-key"
// in real life) — proves the runner surfaces the throw in errors[] and never
// silently treats it as a zero-result scan for delisting purposes.
let flakyShouldThrow = false;
let flakyGigs: Gig[] = [];
registerSource({
  id: "flaky",
  label: "Flaky (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    if (flakyShouldThrow) throw new Error("flaky: simulated auth failure (expired session)");
    return flakyGigs;
  },
});

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  nextGigs = [];
  flakyShouldThrow = false;
  flakyGigs = [];
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(roleArea?: RoleAreaConfig): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    needs: {
      minRate: 0,
      highRate: 999_999,
      maxHours: 999,
      maxHoursAtHighRate: 999,
      allowContractToHire: true,
      freshStageOnly: false,
      remoteOnly: false,
    },
    sources: [{ id: "braintrust", enabled: true }],
    roleArea,
  };
}

function makeGig(externalId: string, title = "Senior Backend Engineer", sourceId = "braintrust"): Gig {
  return {
    sourceId,
    externalId,
    title,
    url: `https://app.usebraintrust.com/jobs/${externalId}/`,
  };
}

describe("runRadar + store integration", () => {
  it("run 1 persists every gig the source returns into the store", async () => {
    nextGigs = [makeGig("1", "Senior Backend Engineer"), makeGig("2", "Staff Platform Engineer")];

    const result = await runRadar(makeConfig(), { db });

    expect(result.errors).toEqual([]);
    expect(result.results).toHaveLength(2);
    // gate() applied to every gig (no filters set => everything passes).
    expect(result.passed).toHaveLength(2);

    const stored = listGigs({ sourceId: "braintrust" }, { db });
    expect(stored.map((g) => g.key).sort()).toEqual(["braintrust:1", "braintrust:2"]);
    expect(stored.every((g) => g.status === "new")).toBe(true);
    expect(stored.every((g) => g.unavailableSince === null)).toBe(true);
  });

  it("run 2 with the same data preserves status and firstSeen (not re-flagged new)", async () => {
    nextGigs = [makeGig("1"), makeGig("2")];
    await runRadar(makeConfig(), { db, now: "2026-01-01T00:00:00.000Z" });

    // A real product action between scans — the store must never undo this.
    db.prepare("UPDATE gigs SET status = 'applied' WHERE key = 'braintrust:1'").run();
    const firstSeenBefore = getGig("braintrust:1", { db })?.firstSeen;
    expect(firstSeenBefore).toBe("2026-01-01T00:00:00.000Z");

    // Second scan, same two gigs come back again.
    nextGigs = [makeGig("1"), makeGig("2")];
    const result = await runRadar(makeConfig(), { db, now: "2026-01-08T00:00:00.000Z" });

    expect(result.errors).toEqual([]);
    const after = getGig("braintrust:1", { db });
    expect(after?.status).toBe("applied"); // preserved, not reset to "new"
    expect(after?.firstSeen).toBe("2026-01-01T00:00:00.000Z"); // never moves
    expect(after?.lastSeen).toBe("2026-01-08T00:00:00.000Z"); // bumped
    expect(after?.unavailableSince).toBeNull(); // still available
  });

  it("flags a gig unavailable when Braintrust stops returning it while other Braintrust gigs persist", async () => {
    nextGigs = [makeGig("1", "Will Be Delisted"), makeGig("2", "Still Open")];
    await runRadar(makeConfig(), { db, now: "2026-01-01T00:00:00.000Z" });

    // Next scan: gig 1 is gone from Braintrust, but the source itself is
    // healthy — it still returns gig 2. This is the real-delisting case,
    // distinct from a source outage (which must never flag anything).
    nextGigs = [makeGig("2", "Still Open")];
    const result = await runRadar(makeConfig(), { db, now: "2026-01-02T00:00:00.000Z" });

    expect(result.errors).toEqual([]);
    expect(getGig("braintrust:1", { db })?.unavailableSince).toBe("2026-01-02T00:00:00.000Z");
    expect(getGig("braintrust:2", { db })?.unavailableSince).toBeNull(); // present this scan, untouched
  });

  it("surfaces a fetch throw (auth failure) in errors[] and never flags that source's gigs unavailable", async () => {
    const config = makeConfig();
    config.sources = [{ id: "flaky", enabled: true }];

    flakyGigs = [makeGig("1", "Flaky Gig One", "flaky"), makeGig("2", "Flaky Gig Two", "flaky")];
    await runRadar(config, { db, now: "2026-01-01T00:00:00.000Z" });
    expect(getGig("flaky:1", { db })).toBeDefined();

    // Second scan: the session expired — fetch throws instead of returning [].
    flakyShouldThrow = true;
    const result = await runRadar(config, { db, now: "2026-01-02T00:00:00.000Z" });

    expect(result.errors).toEqual([
      { sourceId: "flaky", message: "flaky: simulated auth failure (expired session)" },
    ]);
    expect(result.results).toEqual([]);
    // Not silently zero: the previously-stored gigs must NOT be flagged
    // unavailable just because this scan's fetch failed.
    expect(getGig("flaky:1", { db })?.unavailableSince).toBeNull();
    expect(getGig("flaky:2", { db })?.unavailableSince).toBeNull();
  });

  it("an unregistered source id surfaces in errors[] without touching the store", async () => {
    nextGigs = [makeGig("1"), makeGig("2")];
    await runRadar(makeConfig(), { db, now: "2026-01-01T00:00:00.000Z" });

    const config = makeConfig();
    config.sources = [{ id: "does-not-exist", enabled: true }];
    const result = await runRadar(config, { db, now: "2026-01-02T00:00:00.000Z" });

    expect(result.errors).toEqual([{ sourceId: "does-not-exist", message: "no such registered source" }]);
    expect(result.results).toEqual([]);
    expect(getGig("braintrust:1", { db })?.unavailableSince).toBeNull();
    expect(getGig("braintrust:2", { db })?.unavailableSince).toBeNull();
  });
});

describe("runRadar: tiering integration", () => {
  const roleArea: RoleAreaConfig = {
    coreTitles: ["fractional cto"],
    keywords: ["kubernetes"],
    redKeywords: ["recruiter"],
  };

  it("computes a gig's tier via tier() and persists it through the full pipeline (gate -> tier -> store)", async () => {
    nextGigs = [
      makeGig("1", "Fractional CTO for a Seed-Stage Startup"), // core title -> green
      makeGig("2", "Technical Recruiter"), // red keyword, no core title -> red
      makeGig("3", "Marketing Copywriter"), // nothing matches -> yellow
    ];

    const result = await runRadar(makeConfig(roleArea), { db });

    expect(result.errors).toEqual([]);

    // In-memory MatchResult carries the tier.
    const byExternalId = new Map(result.results.map((r) => [r.gig.externalId, r]));
    expect(byExternalId.get("1")?.tier).toBe("green");
    expect(byExternalId.get("2")?.tier).toBe("red");
    expect(byExternalId.get("3")?.tier).toBe("yellow");

    // Persisted through the store's recordScan()/upsert path.
    expect(getGig("braintrust:1", { db })?.tier).toBe("green");
    expect(getGig("braintrust:2", { db })?.tier).toBe("red");
    expect(getGig("braintrust:3", { db })?.tier).toBe("yellow");
  });

  it("without a configured roleArea, every persisted gig tiers yellow (do-nothing default, not an error)", async () => {
    nextGigs = [makeGig("1", "Fractional CTO for a Seed-Stage Startup")];

    const result = await runRadar(makeConfig(undefined), { db });

    expect(result.errors).toEqual([]);
    expect(result.results[0]?.tier).toBe("yellow");
    expect(getGig("braintrust:1", { db })?.tier).toBe("yellow");
  });
});
