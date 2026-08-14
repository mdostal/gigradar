import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../types.js";
import { closeDb, getDb, getGig, listGigs } from "../../store/index.js";
import { runRadar } from "../runner.js";
// Importing these (rather than a test double, unlike apply/__tests__/runner.test.ts)
// runs their module-level `registerSource()` calls, so this test exercises
// the REAL Braintrust and BuiltIn adapters end to end (real parsing logic,
// mocked only at the `fetch()` boundary below) — not a stand-in.
import { braintrustSource } from "../../sources/braintrust.js";
import { builtinSource } from "../../sources/builtin.js";

// Reuses Braintrust's own recorded fixture (5 real jobs, ids 17628 / 17602 /
// 17661 / 17629 / 17583) and BuiltIn's own recorded fixture (10 real jobs) —
// see sources/__tests__/braintrust.test.ts and builtin.test.ts for how each
// was captured. Zero network calls happen anywhere in this file.
const sourcesFixturesDir = fileURLToPath(new URL("../../sources/__tests__/fixtures", import.meta.url));
const braintrustPage1 = JSON.parse(
  fs.readFileSync(path.join(sourcesFixturesDir, "braintrust-jobs-role-5-page1.json"), "utf8"),
);
const braintrustPage2 = JSON.parse(
  fs.readFileSync(path.join(sourcesFixturesDir, "braintrust-jobs-role-5-page2.json"), "utf8"),
);
const builtinFixtureHtml = fs.readFileSync(path.join(sourcesFixturesDir, "builtin-jobs-dev-engineering.html"), "utf8");

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", json: async () => body } as unknown as Response;
}
function htmlResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, statusText: ok ? "OK" : "Error", text: async () => body } as unknown as Response;
}

/** Routes the shared global.fetch mock by host, since both real sources hit it in the same scan. */
function mockBothSources(builtinHtml: string) {
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("usebraintrust.com")) {
      return u.includes("page=2") ? jsonResponse(braintrustPage2) : jsonResponse(braintrustPage1);
    }
    if (u.includes("builtin.com")) return htmlResponse(builtinHtml);
    throw new Error(`unexpected fetch in two-source-dedup test: ${u}`);
  }) as unknown as typeof fetch;
}

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;
const originalFetch = global.fetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-two-source-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    needs: {
      engagementProfiles: [
        {
          id: "any-hourly",
          label: "Any (hourly)",
          types: ["contract", "fractional", "contract-to-hire"],
          minRate: 0,
          highRate: 999_999,
          maxHours: 999,
          maxHoursAtHighRate: 999,
          rateUnit: "hour",
        },
        {
          id: "any-salaried",
          label: "Any (salaried)",
          types: ["full-time"],
          minRate: 0,
          highRate: 999_999_999,
          rateUnit: "year",
        },
      ],
      freshStageOnly: false,
      remoteOnly: false,
    },
    sources: [
      { id: "braintrust", enabled: true },
      { id: "builtin", enabled: true },
    ],
  };
}

describe("two real sources enabled together (Braintrust + BuiltIn)", () => {
  it("registers both sources under distinct ids", () => {
    expect(braintrustSource.id).toBe("braintrust");
    expect(builtinSource.id).toBe("builtin");
  });

  it("persists every gig from both sources with no drops and no cross-source overwrites", async () => {
    mockBothSources(builtinFixtureHtml);

    const result = await runRadar(makeConfig(), { db, now: "2026-08-10T12:00:00.000Z" });

    expect(result.errors).toEqual([]);
    // Braintrust's fixture has 5 jobs, BuiltIn's has 10 — both counts must
    // survive intact through gate -> tier -> recordScan with nothing dropped
    // or merged into the other source's rows.
    expect(result.passed).toHaveLength(15);

    const braintrustRows = listGigs({ sourceId: "braintrust" }, { db });
    const builtinRows = listGigs({ sourceId: "builtin" }, { db });
    const allRows = listGigs({}, { db });
    expect(braintrustRows).toHaveLength(5);
    expect(builtinRows).toHaveLength(10);
    expect(allRows).toHaveLength(15); // 5 + 10, not deduped against each other

    // Every stored key is correctly namespaced `${sourceId}:${externalId}`.
    expect(braintrustRows.every((g) => g.key.startsWith("braintrust:"))).toBe(true);
    expect(builtinRows.every((g) => g.key.startsWith("builtin:"))).toBe(true);

    // Spot-check one real gig from each source persisted with its own data,
    // not the other source's.
    const bt = getGig("braintrust:17628", { db });
    expect(bt?.title).toBe("Python Engineer (China or USA - Remote)");
    expect(bt?.url).toBe("https://app.usebraintrust.com/jobs/17628/");

    const bi = getGig("builtin:10611593", { db });
    expect(bi?.title).toBe("Staff Backend Software Engineer");
    expect(bi?.url).toBe("https://builtin.com/job/staff-backend-software-engineer/10611593");
  });

  it("does not collide even when both sources happen to use the same externalId", async () => {
    // A minimal card in BuiltIn's real structural pattern (same markup shape
    // validated by builtin.test.ts's fixture-based tests), with its id
    // deliberately set to "17628" — the exact same externalId Braintrust's
    // own fixture uses for a *different* real job ("Python Engineer (China
    // or USA - Remote)"). This card's specific id/title/company values are
    // constructed for this collision scenario, not claimed as a recorded
    // live BuiltIn response (unlike builtin-jobs-dev-engineering.html) —
    // its only job is to prove the store's `${sourceId}:${externalId}` key
    // keeps two same-numbered listings from two different sources apart.
    const collidingBuiltinHtml = `
      <div id="jobs-list"><div class="d-flex gap-sm flex-column">
        <div id="job-card-17628" data-id="job-card">
          <div class="left-side-tile-item-2"><a data-id="company-title"><span>Colliding Co</span></a></div>
          <h2><a href="/job/collision-check-engineer/17628" data-id="job-card-title">Collision Check Engineer</a></h2>
        </div>
      </div></div>`;
    mockBothSources(collidingBuiltinHtml);

    const result = await runRadar(makeConfig(), { db, now: "2026-08-10T12:00:00.000Z" });
    expect(result.errors).toEqual([]);

    // Two distinct rows exist for externalId "17628" — one per source — not
    // one row where the second scan clobbered the first.
    const bt = getGig("braintrust:17628", { db });
    const bi = getGig("builtin:17628", { db });
    expect(bt).toBeDefined();
    expect(bi).toBeDefined();
    expect(bt?.title).toBe("Python Engineer (China or USA - Remote)");
    expect(bt?.company).toBe("SuperAnnotate AI, Inc");
    expect(bi?.title).toBe("Collision Check Engineer");
    expect(bi?.company).toBe("Colliding Co");
    expect(bt?.key).not.toBe(bi?.key);
    expect(bt?.key).toBe("braintrust:17628");
    expect(bi?.key).toBe("builtin:17628");

    const allRows = listGigs({}, { db });
    expect(allRows).toHaveLength(6); // 5 real Braintrust jobs + this 1 synthetic BuiltIn job
  });
});
