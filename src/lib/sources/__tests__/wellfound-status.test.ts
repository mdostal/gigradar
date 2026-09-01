// Tests for src/lib/sources/wellfound-status.ts (product-review-followups
// epic, status-reconciliation-from-platforms story). Mirrors
// gofractional-status.test.ts's own structure exactly: withBrowserSession
// fully mocked, a REAL isolated SQLite DB (never the store itself mocked),
// focused on the status-label mapping and normalized-title matching/write
// logic -- plus this source's own two-page (ongoing + archived) merge.
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
import { reconcileWellfoundStatuses } from "../wellfound-status.js";

interface WithBrowserSessionOptions {
  sourceId: string;
  storageStatePathSetting: string;
  allowedOrigins: string[];
  url: string;
  isAuthenticated: (page: unknown) => Promise<boolean>;
}

type Row = { company: string; title: string; statusLabel: string; updatedText: string; href: string };

/** Wires the mocked withBrowserSession to resolve `ongoingRows` for the "/jobs/applications" call and `archivedRows` for the "/jobs/applications/archived" call — mirroring the two real, separate pages this source fetches. */
function stubTwoPages(ongoingRows: Row[], archivedRows: Row[]) {
  const capturedOptions: WithBrowserSessionOptions[] = [];
  withBrowserSessionMock.mockImplementation(async (options: WithBrowserSessionOptions) => {
    capturedOptions.push(options);
    return options.url.endsWith("/archived") ? archivedRows : ongoingRows;
  });
  return () => capturedOptions;
}

const cfg: SourceConfig = { id: "wellfound", enabled: true, settings: { sessionStatePath: "/fake/wellfound.json" } };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-wf-status-test-"));
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
    { sourceId: "wellfound", gigs: [{ sourceId: "wellfound", externalId, title, url: `https://wellfound.com/jobs/${externalId}` }] },
  ]);
}

describe("reconcileWellfoundStatuses", () => {
  it("updates a locally-tracked gig's status when an ONGOING row maps 'Pending' -> applied", async () => {
    seedGig("123-founding-cto", "Founding CTO");
    stubTwoPages([{ company: "Acme", title: "Founding CTO", statusLabel: "Pending", updatedText: "Aug 26", href: "/jobs/applications/1-2" }], []);

    const result = await reconcileWellfoundStatuses(cfg);

    expect(result.updated).toEqual([{ key: "wellfound:123-founding-cto", title: "Founding CTO", from: "new", to: "applied" }]);
    expect(getGig("wellfound:123-founding-cto")?.status).toBe("applied");
  });

  it("updates a locally-tracked gig's status when an ARCHIVED row maps 'Expired' -> archived", async () => {
    seedGig("456-swe-platform", "Software Engineer, Platform");
    stubTwoPages([], [{ company: "Thoughtful AI", title: "Software Engineer, Platform", statusLabel: "Expired", updatedText: "Oct 23, 2024", href: "/jobs/applications/archived/3-4" }]);

    const result = await reconcileWellfoundStatuses(cfg);

    expect(result.updated).toEqual([{ key: "wellfound:456-swe-platform", title: "Software Engineer, Platform", from: "new", to: "archived" }]);
    expect(getGig("wellfound:456-swe-platform")?.status).toBe("archived");
  });

  it("merges rows from BOTH pages in one result", async () => {
    seedGig("1-a", "Role A");
    seedGig("2-b", "Role B");
    stubTwoPages(
      [{ company: "X", title: "Role A", statusLabel: "Pending", updatedText: "1 day", href: "/jobs/applications/5-6" }],
      [{ company: "Y", title: "Role B", statusLabel: "Expired", updatedText: "2 days", href: "/jobs/applications/archived/7-8" }],
    );

    const result = await reconcileWellfoundStatuses(cfg);

    expect(result.updated).toHaveLength(2);
    expect(getGig("wellfound:1-a")?.status).toBe("applied");
    expect(getGig("wellfound:2-b")?.status).toBe("archived");
  });

  it("fetches both the ongoing and archived URLs, each scoped to wellfound.com ONLY", async () => {
    const getOptions = stubTwoPages([], []);

    await reconcileWellfoundStatuses(cfg);

    const options = getOptions();
    expect(options).toHaveLength(2);
    const urls = options.map((o) => o.url).sort();
    expect(urls).toEqual(["https://wellfound.com/jobs/applications", "https://wellfound.com/jobs/applications/archived"]);
    for (const o of options) {
      expect(o.sourceId).toBe("wellfound");
      expect(o.allowedOrigins).toEqual(["wellfound.com"]);
    }
  });

  it("reports alreadyCurrent and does not re-write when the local status already matches", async () => {
    seedGig("1-a", "Role A");
    stubTwoPages([{ company: "X", title: "Role A", statusLabel: "Pending", updatedText: "1 day", href: "/jobs/applications/1-a" }], []);
    await reconcileWellfoundStatuses(cfg); // first pass: new -> applied

    const result = await reconcileWellfoundStatuses(cfg); // second pass: already applied

    expect(result.updated).toEqual([]);
    expect(result.alreadyCurrent).toEqual([{ key: "wellfound:1-a", title: "Role A", status: "applied" }]);
  });

  it("backfills a NEW gig record (never just drops it) for a row with no corresponding local gig, using the row's REAL href", async () => {
    stubTwoPages(
      [{ company: "Some Co", title: "A Role Gigradar Never Tracked", statusLabel: "Pending", updatedText: "1 day", href: "/jobs/applications/985900737-4618021" }],
      [],
    );

    const result = await reconcileWellfoundStatuses(cfg);

    expect(result.updated).toEqual([]);
    expect(result.noMatch).toEqual([]);
    expect(result.backfilled).toEqual([
      { key: "wellfound:jobs/applications/985900737-4618021", title: "A Role Gigradar Never Tracked", status: "applied" },
    ]);
    const backfilledGig = getGig("wellfound:jobs/applications/985900737-4618021");
    expect(backfilledGig?.status).toBe("applied");
    expect(backfilledGig?.title).toBe("A Role Gigradar Never Tracked");
    expect(backfilledGig?.url).toBe("https://wellfound.com/jobs/applications/985900737-4618021");
  });

  it("backfills an ARCHIVED-page row too, keyed off its own real archived href", async () => {
    stubTwoPages(
      [],
      [{ company: "Other Co", title: "An Old Untracked Role", statusLabel: "Expired", updatedText: "3 weeks ago", href: "/jobs/applications/archived/111-222" }],
    );

    const result = await reconcileWellfoundStatuses(cfg);

    expect(result.backfilled).toEqual([
      { key: "wellfound:jobs/applications/archived/111-222", title: "An Old Untracked Role", status: "archived" },
    ]);
  });

  it("does not double-backfill: re-running reconciliation against the same unmatched row finds it via title match on the second pass", async () => {
    stubTwoPages(
      [{ company: "Some Co", title: "A Role Gigradar Never Tracked", statusLabel: "Pending", updatedText: "1 day", href: "/jobs/applications/985900737-4618021" }],
      [],
    );
    await reconcileWellfoundStatuses(cfg); // first pass: backfilled

    const result = await reconcileWellfoundStatuses(cfg); // second pass: now locally tracked

    expect(result.backfilled).toEqual([]);
    expect(result.alreadyCurrent).toEqual([
      { key: "wellfound:jobs/applications/985900737-4618021", title: "A Role Gigradar Never Tracked", status: "applied" },
    ]);
    expect(listGigs().filter((g) => g.sourceId === "wellfound")).toHaveLength(1); // no duplicate record
  });

  it("still reports noMatch (does not backfill) for a row with an empty title or href", async () => {
    stubTwoPages([{ company: "Some Co", title: "", statusLabel: "Pending", updatedText: "1 day", href: "/jobs/applications/1-2" }], []);

    const result = await reconcileWellfoundStatuses(cfg);

    expect(result.backfilled).toEqual([]);
    expect(result.noMatch).toHaveLength(1);
  });

  it("reports ambiguous (never guesses) when a row's title normalizes to MORE THAN ONE local gig", async () => {
    seedGig("1-a", "Founding CTO");
    seedGig("2-b", "Founding CTO");
    stubTwoPages([{ company: "X", title: "Founding CTO", statusLabel: "Pending", updatedText: "1 day", href: "/jobs/applications/9-9" }], []);

    const result = await reconcileWellfoundStatuses(cfg);

    expect(result.updated).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]).toMatchObject({ title: "Founding CTO", matchCount: 2 });
  });

  it("reports unknownStatusLabel for a status badge text this mapping doesn't recognize", async () => {
    seedGig("1-a", "Founding CTO");
    stubTwoPages([{ company: "X", title: "Founding CTO", statusLabel: "Some Brand New Label", updatedText: "1 day", href: "/jobs/applications/1-a" }], []);

    const result = await reconcileWellfoundStatuses(cfg);

    expect(result.updated).toEqual([]);
    expect(result.unknownStatusLabel).toHaveLength(1);
    expect(getGig("wellfound:1-a")?.status).toBe("new");
  });

  it("throws a specific, actionable error (before ever invoking withBrowserSession) when settings.sessionStatePath is missing", async () => {
    const badCfg: SourceConfig = { id: "wellfound", enabled: true };

    await expect(reconcileWellfoundStatuses(badCfg)).rejects.toThrow(/sessionStatePath/);
    expect(withBrowserSessionMock).not.toHaveBeenCalled();
  });
});
