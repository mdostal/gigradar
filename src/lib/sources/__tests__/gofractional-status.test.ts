// Tests for src/lib/sources/gofractional-status.ts (product-review-followups
// epic, status-reconciliation-from-platforms story). `withBrowserSession()`
// is fully mocked (no real Chromium launch, matching gofractional.test.ts's
// own convention) so this file focuses on what's actually NEW here: the
// status-label mapping and the normalized-title matching/write logic
// against a REAL, isolated SQLite DB (a temp file per test, same pattern
// as src/app/__tests__/actions.test.ts) -- never mocking the store itself,
// since correctly not-overwriting an ambiguous/unmatched row is exactly
// the behavior worth proving against real setStatus()/listGigs() calls.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceConfig } from "../../types.js";

const withBrowserSessionMock = vi.fn();
vi.mock("../../auth/browser-session.js", () => ({
  withBrowserSession: (...args: unknown[]) => withBrowserSessionMock(...args),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest).
import { closeDb, getGig, listGigs, recordScan } from "../../store/index.js";
import { reconcileGoFractionalStatuses } from "../gofractional-status.js";

interface WithBrowserSessionOptions {
  sourceId: string;
  storageStatePathSetting: string;
  allowedOrigins: string[];
  url: string;
  isAuthenticated: (page: unknown) => Promise<boolean>;
}

/** Wires the mocked withBrowserSession to resolve directly to `rows` (bypassing the real page.evaluate() scrape entirely), capturing the options it was called with. */
function stubWithBrowserSession(rows: { company: string; title: string; statusLabel: string; updatedText: string }[]) {
  let capturedOptions: WithBrowserSessionOptions | undefined;
  withBrowserSessionMock.mockImplementation(async (options: WithBrowserSessionOptions) => {
    capturedOptions = options;
    return rows;
  });
  return () => capturedOptions;
}

const cfg: SourceConfig = { id: "gofractional", enabled: true, settings: { sessionStatePath: "/fake/gf.json" } };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-gf-status-test-"));
  process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
  withBrowserSessionMock.mockReset();
});

afterEach(() => {
  closeDb();
  delete process.env.GIGRADAR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedGig(externalId: string, title: string) {
  recordScan([
    {
      sourceId: "gofractional",
      gigs: [{ sourceId: "gofractional", externalId, title, url: `https://www.gofractional.com/job/${externalId}` }],
    },
  ]);
}

describe("reconcileGoFractionalStatuses", () => {
  it("updates a locally-tracked gig's status when the scraped row maps to a different status ('Applied' -> applied)", async () => {
    seedGig("fractional-cto-acme", "Fractional CTO");
    stubWithBrowserSession([{ company: "Acme Robotics", title: "Fractional CTO", statusLabel: "Applied", updatedText: "6 days ago" }]);

    const result = await reconcileGoFractionalStatuses(cfg);

    expect(result.updated).toEqual([{ key: "gofractional:fractional-cto-acme", title: "Fractional CTO", from: "new", to: "applied" }]);
    expect(getGig("gofractional:fractional-cto-acme")?.status).toBe("applied");
  });

  it("maps 'Passed' -> archived", async () => {
    seedGig("staff-eng-northwind", "Staff Backend Engineer");
    stubWithBrowserSession([{ company: "Northwind", title: "Staff Backend Engineer", statusLabel: "Passed", updatedText: "1 month ago" }]);

    const result = await reconcileGoFractionalStatuses(cfg);

    expect(result.updated).toEqual([{ key: "gofractional:staff-eng-northwind", title: "Staff Backend Engineer", from: "new", to: "archived" }]);
    expect(getGig("gofractional:staff-eng-northwind")?.status).toBe("archived");
  });

  it("reports alreadyCurrent and does NOT call setStatus again when the local status already matches", async () => {
    seedGig("fractional-cto-acme", "Fractional CTO");
    stubWithBrowserSession([{ company: "Acme Robotics", title: "Fractional CTO", statusLabel: "Applied", updatedText: "6 days ago" }]);
    await reconcileGoFractionalStatuses(cfg); // first pass: new -> applied

    const result = await reconcileGoFractionalStatuses(cfg); // second pass: already applied

    expect(result.updated).toEqual([]);
    expect(result.alreadyCurrent).toEqual([{ key: "gofractional:fractional-cto-acme", title: "Fractional CTO", status: "applied" }]);
  });

  it("backfills a NEW gig record (never just drops it) for a scraped row with no corresponding local gig", async () => {
    stubWithBrowserSession([{ company: "Some Co", title: "A Role Gigradar Never Tracked", statusLabel: "Applied", updatedText: "2 days ago" }]);

    const result = await reconcileGoFractionalStatuses(cfg);

    expect(result.updated).toEqual([]);
    expect(result.noMatch).toEqual([]);
    expect(result.backfilled).toEqual([
      { key: "gofractional:applied-some-co-a-role-gigradar-never-tracked", title: "A Role Gigradar Never Tracked", status: "applied" },
    ]);
    const backfilledGig = getGig("gofractional:applied-some-co-a-role-gigradar-never-tracked");
    expect(backfilledGig?.status).toBe("applied");
    expect(backfilledGig?.title).toBe("A Role Gigradar Never Tracked");
    expect(backfilledGig?.company).toBe("Some Co");
    expect(backfilledGig?.url).toBe("https://app.gofractional.com/work");
  });

  it("backfills with a status other than 'applied' too ('Passed' row with no local match -> archived)", async () => {
    stubWithBrowserSession([{ company: "Other Co", title: "Another Untracked Role", statusLabel: "Passed", updatedText: "3 weeks ago" }]);

    const result = await reconcileGoFractionalStatuses(cfg);

    expect(result.backfilled).toHaveLength(1);
    expect(result.backfilled[0]?.status).toBe("archived");
  });

  it("does not double-backfill: re-running reconciliation against the same unmatched row finds it via title match on the second pass", async () => {
    stubWithBrowserSession([{ company: "Some Co", title: "A Role Gigradar Never Tracked", statusLabel: "Applied", updatedText: "2 days ago" }]);
    await reconcileGoFractionalStatuses(cfg); // first pass: backfilled

    const result = await reconcileGoFractionalStatuses(cfg); // second pass: now locally tracked

    expect(result.backfilled).toEqual([]);
    expect(result.alreadyCurrent).toEqual([
      { key: "gofractional:applied-some-co-a-role-gigradar-never-tracked", title: "A Role Gigradar Never Tracked", status: "applied" },
    ]);
    expect(listGigs().filter((g) => g.sourceId === "gofractional")).toHaveLength(1); // no duplicate record
  });

  it("still reports noMatch (does not backfill) for a row with an empty title", async () => {
    stubWithBrowserSession([{ company: "Some Co", title: "", statusLabel: "Applied", updatedText: "2 days ago" }]);

    const result = await reconcileGoFractionalStatuses(cfg);

    expect(result.backfilled).toEqual([]);
    expect(result.noMatch).toEqual([{ company: "Some Co", title: "", statusLabel: "Applied", updatedText: "2 days ago" }]);
  });

  it("reports ambiguous (never guesses) when a scraped title normalizes to MORE THAN ONE local gig", async () => {
    seedGig("fractional-cto-a", "Fractional CTO");
    seedGig("fractional-cto-b", "Fractional CTO"); // same title, two different real listings
    stubWithBrowserSession([{ company: "Some Co", title: "Fractional CTO", statusLabel: "Applied", updatedText: "2 days ago" }]);

    const result = await reconcileGoFractionalStatuses(cfg);

    expect(result.updated).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]).toMatchObject({ title: "Fractional CTO", matchCount: 2 });
    // Neither candidate got silently written.
    expect(getGig("gofractional:fractional-cto-a")?.status).toBe("new");
    expect(getGig("gofractional:fractional-cto-b")?.status).toBe("new");
  });

  it("matches titles tolerant of formatting drift (case, punctuation, extra whitespace)", async () => {
    seedGig("fractional-cto-acme", "Fractional CTO — Physical AI & Robotics");
    stubWithBrowserSession([
      { company: "Acme", title: "  fractional cto -- physical ai & robotics  ", statusLabel: "Applied", updatedText: "1 month ago" },
    ]);

    const result = await reconcileGoFractionalStatuses(cfg);

    expect(result.updated).toHaveLength(1);
    expect(getGig("gofractional:fractional-cto-acme")?.status).toBe("applied");
  });

  it("reports unknownStatusLabel (never guesses a mapping) for a status badge text this mapping doesn't recognize", async () => {
    seedGig("fractional-cto-acme", "Fractional CTO");
    stubWithBrowserSession([{ company: "Acme", title: "Fractional CTO", statusLabel: "Some New Status GoFractional Just Added", updatedText: "1 day ago" }]);

    const result = await reconcileGoFractionalStatuses(cfg);

    expect(result.updated).toEqual([]);
    expect(result.unknownStatusLabel).toEqual([
      { company: "Acme", title: "Fractional CTO", statusLabel: "Some New Status GoFractional Just Added", updatedText: "1 day ago" },
    ]);
    expect(getGig("gofractional:fractional-cto-acme")?.status).toBe("new"); // untouched
  });

  it("passes the real, live-verified /work URL and gofractional-only origin allowlist to withBrowserSession()", async () => {
    const getOptions = stubWithBrowserSession([]);

    await reconcileGoFractionalStatuses(cfg);

    const options = getOptions();
    expect(options?.url).toBe("https://app.gofractional.com/work");
    expect(options?.sourceId).toBe("gofractional");
    expect(options?.allowedOrigins).toEqual(["gofractional.com"]);
  });

  it("throws a specific, actionable error (before ever invoking withBrowserSession) when settings.sessionStatePath is missing", async () => {
    const badCfg: SourceConfig = { id: "gofractional", enabled: true };

    await expect(reconcileGoFractionalStatuses(badCfg)).rejects.toThrow(/sessionStatePath/);
    expect(withBrowserSessionMock).not.toHaveBeenCalled();
  });
});
