import type { Page } from "playwright";
import type { SourceConfig } from "../types.js";
import { listGigs, setStatus } from "../store/index.js";
import type { GigStatus } from "../store/index.js";
import { withBrowserSession } from "../auth/browser-session.js";
import { sessionBackendFrom } from "../auth/session-backend.js";
import { SOURCE_ORIGINS } from "./origins.js";
import { isAuthenticatedGoFractional } from "./gofractional.js";

/**
 * Status reconciliation for GoFractional (product-review-followups epic,
 * status-reconciliation-from-platforms story — first source; see
 * .pHive project memory for why this landed here first: owner's own
 * account, live-verified 2026-08-31).
 *
 * LIVE-VERIFIED PAGE SHAPE: `https://app.gofractional.com/work` is the
 * real, logged-in "Work" dashboard (distinct from `app.gofractional.com`'s
 * bare root, which is an EMPLOYER-facing hiring area the owner's talent
 * account gets redirected away from — confirmed live). It renders a
 * `<table>` per status section (observed: "Under Review" containing rows
 * with a "Applied" status badge, and "Archived" containing rows with a
 * "Passed" status badge) — each row is a `role="link"` `<tr>` with NO real
 * `href` (a client-side router click handler, not a real anchor; per-row
 * job IDs are only reachable by actually clicking through, not scraped
 * here). Matching a row back to a locally-tracked gig is therefore by
 * NORMALIZED TITLE ONLY, not an external id — see reconcile()'s own doc
 * comment for why an ambiguous or absent match is reported, never guessed.
 */
const WORK_URL = "https://app.gofractional.com/work";
const ALLOWED_ORIGINS = SOURCE_ORIGINS["gofractional"]!;

export interface ApplicationStatusRow {
  company: string;
  title: string;
  statusLabel: string;
  updatedText: string;
}

/**
 * Maps GoFractional's own status-badge text to gigradar's `GigStatus`.
 * "applied"/"under review" -> LIVE-VERIFIED (both real labels observed on
 * the owner's real account 2026-08-31). "passed" -> LIVE-VERIFIED (same).
 * Every other key is a REASONABLE, UNVERIFIED GUESS at labels this
 * account's data didn't happen to include (no interview/offer rows were
 * present to observe) — a future maintainer who sees an `unknownStatusLabel`
 * entry in a real `ReconciliationResult` should treat that as the signal to
 * add the real label here, not assume this map is exhaustive.
 */
const STATUS_LABEL_MAP: Record<string, GigStatus> = {
  applied: "applied",
  "under review": "applied",
  passed: "archived",
  rejected: "archived",
  "not selected": "archived",
  declined: "archived",
  withdrawn: "archived",
  interview: "interview",
  interviewing: "interview",
  shortlisted: "interview",
};

/** Lowercases and collapses non-alphanumeric runs to single spaces — tolerant of the two sides' formatting drifting apart (e.g. trailing category/location text accidentally concatenated) without being so loose it conflates two genuinely different titles. */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Extracts every application-status row from the `/work` page's DOM.
 * LIVE-VERIFIED table shape: each status section is a `<table>` whose
 * `tbody tr` rows have (in column order) company / job-details (title as
 * the FIRST child `<div>`, category+location as a second) / compensation /
 * status badge / relative-updated-time / a trailing chevron cell. Reads
 * ONLY the first child `<div>` of the job-details cell for `title` —
 * reading the cell's whole `textContent` would concatenate the title with
 * the category/location text right after it (confirmed live).
 */
export async function scrapeApplicationStatuses(page: Page): Promise<ApplicationStatusRow[]> {
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  return page.evaluate(() => {
    const rows: { company: string; title: string; statusLabel: string; updatedText: string }[] = [];
    for (const tr of document.querySelectorAll("table tbody tr")) {
      const cells = [...tr.querySelectorAll("td")];
      if (cells.length < 5) continue;
      const company = (cells[0]?.textContent ?? "").trim();
      const titleCell = cells[1];
      const titleLine = (titleCell?.querySelector("div")?.textContent ?? titleCell?.textContent ?? "").trim();
      const statusLabel = (cells[3]?.textContent ?? "").trim();
      const updatedText = (cells[4]?.textContent ?? "").trim();
      if (titleLine.length > 0) rows.push({ company, title: titleLine, statusLabel, updatedText });
    }
    return rows;
  });
}

export interface ReconciliationResult {
  updated: { key: string; title: string; from: GigStatus; to: GigStatus }[];
  alreadyCurrent: { key: string; title: string; status: GigStatus }[];
  noMatch: ApplicationStatusRow[];
  ambiguous: (ApplicationStatusRow & { matchCount: number })[];
  unknownStatusLabel: ApplicationStatusRow[];
}

/** Required only for the "local" (default) session backend -- same convention as every other browser-session adapter's own sessionStatePathFrom(). */
function sessionStatePathFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.sessionStatePath;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error(
      'gofractional-status: source "gofractional" is missing settings.sessionStatePath. ' +
        "Set it to a storageState file path (or an \"env:VAR_NAME\" reference) — see docs/ARCHITECTURE.md's browser-session section.",
    );
  }
  return configured;
}

/**
 * Scrapes GoFractional's real application-status dashboard and updates
 * locally-tracked gigs (sourceId "gofractional") whose status has genuinely
 * changed on the real platform. NEVER guesses on ambiguity: a scraped row
 * whose normalized title matches MORE THAN ONE local gig is reported in
 * `ambiguous`, not written — same "no-fabricated-write" discipline this
 * repo's adapters already apply to fabricated DATA, extended here to
 * fabricated MATCHES. A row with no local match at all (a gig gigradar
 * never actually tracked, e.g. applied to before this tool existed) is
 * reported in `noMatch`, not silently dropped.
 */
export async function reconcileGoFractionalStatuses(cfg: SourceConfig): Promise<ReconciliationResult> {
  const sessionBackend = sessionBackendFrom(cfg);
  const sessionStatePath = sessionBackend === "local" ? sessionStatePathFrom(cfg) : undefined;

  const rows = await withBrowserSession(
    {
      sourceId: "gofractional",
      storageStatePathSetting: sessionStatePath,
      sessionBackend,
      allowedOrigins: [...ALLOWED_ORIGINS],
      url: WORK_URL,
      // Reuses gofractional.ts's own real, live-verified auth predicate (the
      // "Dashboard" nav-link poll) rather than inventing a second one — the
      // /work page carries the exact same authenticated-nav shell.
      isAuthenticated: isAuthenticatedGoFractional,
    },
    (page) => scrapeApplicationStatuses(page),
  );

  const localGigs = listGigs().filter((g) => g.sourceId === "gofractional");
  const result: ReconciliationResult = { updated: [], alreadyCurrent: [], noMatch: [], ambiguous: [], unknownStatusLabel: [] };

  for (const row of rows) {
    const newStatus = STATUS_LABEL_MAP[row.statusLabel.toLowerCase()];
    if (!newStatus) {
      result.unknownStatusLabel.push(row);
      continue;
    }

    const normalizedRowTitle = normalizeTitle(row.title);
    const matches = localGigs.filter((g) => normalizeTitle(g.title) === normalizedRowTitle);

    if (matches.length === 0) {
      result.noMatch.push(row);
      continue;
    }
    if (matches.length > 1) {
      result.ambiguous.push({ ...row, matchCount: matches.length });
      continue;
    }

    const gig = matches[0]!;
    if (gig.status === newStatus) {
      result.alreadyCurrent.push({ key: gig.key, title: gig.title, status: gig.status });
      continue;
    }

    setStatus(gig.key, newStatus);
    result.updated.push({ key: gig.key, title: gig.title, from: gig.status, to: newStatus });
  }

  return result;
}
