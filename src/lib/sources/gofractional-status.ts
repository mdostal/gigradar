import type { Page } from "playwright";
import type { SourceConfig } from "../types.js";
import { gigKey, listGigs, recordScan, setOutcome, setStatus } from "../store/index.js";
import type { GigStatus, OutcomeReason } from "../store/index.js";
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

/**
 * A second, narrower map from the SAME raw label to WHY (status-
 * reconciliation-outcomes story, product-review-followups epic — owner's
 * own words, 2026-09-01: "we can see if companies are all just withdrawing
 * contracts (we may be getting replaced by AI or cheaper rates) OR we are
 * getting passed up"). Deliberately NOT exhaustive over every
 * `STATUS_LABEL_MAP` key that maps to `"archived"`: "withdrawn" is
 * genuinely ambiguous from this label alone (candidate-withdrew vs.
 * company-withdrew) and is left OUT here on purpose rather than guessed —
 * a row whose label isn't in this map still gets its real GigStatus set,
 * just no `outcomeReason` stamped. "passed" -> LIVE-VERIFIED (the owner's
 * real account, 2026-08-31: this is GoFractional's own literal wording for
 * "the company passed on you"). The rest are reasonable, unverified
 * guesses, same discipline as `STATUS_LABEL_MAP` itself.
 */
const OUTCOME_REASON_MAP: Record<string, OutcomeReason> = {
  passed: "rejected",
  rejected: "rejected",
  "not selected": "rejected",
  declined: "rejected",
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
  /** A row with no real slug/id in its DOM (see file-level comment) got a NEW gig record, synthetic-id keyed — see reconcileGoFractionalStatuses()'s own doc comment. */
  backfilled: { key: string; title: string; status: GigStatus }[];
  /** A row backfill genuinely could not handle (e.g. an empty title) — distinct from a normal backfill, which now covers what `noMatch` used to just report. */
  noMatch: ApplicationStatusRow[];
  ambiguous: (ApplicationStatusRow & { matchCount: number })[];
  unknownStatusLabel: ApplicationStatusRow[];
}

/**
 * A stable-enough synthetic id for a GoFractional application row that has
 * NO real slug/href anywhere in its DOM (see this file's header comment —
 * these rows are `role="link"` `<tr>`s with a client-side router click
 * handler, not real anchors). Derived from company+title so two distinct
 * roles at the same company (or the same role title at two different
 * companies) don't collide. Deliberately NOT this repo's usual
 * `externalIdFromHref()` pattern — there IS no href to derive one from —
 * documented here as synthetic, not a real GoFractional identifier, so a
 * future maintainer never mistakes it for one.
 */
function syntheticExternalId(row: ApplicationStatusRow): string {
  return `applied-${normalizeTitle(`${row.company} ${row.title}`).replace(/\s+/g, "-")}`;
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
 * fabricated MATCHES.
 *
 * BACKFILLS a row with no local match at all (owner's own words,
 * 2026-08-31: "go through, get ALL of them... build out the full
 * knowledgebase... go fractional ESPECIALLY needs the status updates as a
 * number of jobs keep getting brought up for application that I've already
 * applied to") — a real application gigradar never actually tracked (e.g.
 * applied to before this tool existed, or before this source's own scan
 * ever surfaced that specific listing) gets a NEW gig record via
 * `recordScan()` + an immediate `setStatus()` to the row's real status,
 * rather than just being reported and dropped. This is exactly what stops
 * an already-applied-to listing from resurfacing on the "To review" tab.
 * The new record's `externalId` is a synthetic, company+title-derived id
 * (see `syntheticExternalId()`) since these rows carry no real slug/href;
 * its `url` points at the real `/work` dashboard (the one real, honest
 * place to see it) rather than a fabricated `/job/{slug}` guess.
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
  const result: ReconciliationResult = { updated: [], alreadyCurrent: [], backfilled: [], noMatch: [], ambiguous: [], unknownStatusLabel: [] };

  for (const row of rows) {
    const newStatus = STATUS_LABEL_MAP[row.statusLabel.toLowerCase()];
    if (!newStatus) {
      result.unknownStatusLabel.push(row);
      continue;
    }
    const outcomeReason = OUTCOME_REASON_MAP[row.statusLabel.toLowerCase()];

    const normalizedRowTitle = normalizeTitle(row.title);
    const matches = localGigs.filter((g) => normalizeTitle(g.title) === normalizedRowTitle);

    if (matches.length === 0) {
      if (row.title.trim().length === 0) {
        result.noMatch.push(row);
        continue;
      }
      const externalId = syntheticExternalId(row);
      recordScan([{ sourceId: "gofractional", gigs: [{ sourceId: "gofractional", externalId, title: row.title, company: row.company || undefined, url: WORK_URL }] }]);
      const key = gigKey("gofractional", externalId);
      setStatus(key, newStatus);
      if (outcomeReason) setOutcome(key, outcomeReason, row.statusLabel);
      result.backfilled.push({ key, title: row.title, status: newStatus });
      continue;
    }
    if (matches.length > 1) {
      result.ambiguous.push({ ...row, matchCount: matches.length });
      continue;
    }

    const gig = matches[0]!;
    // An explicit, real status label from the platform is more authoritative
    // than any prior outcomeReason (e.g. one recordScan()'s own delisting
    // heuristic auto-stamped) -- re-stamp it here even when status itself
    // didn't change (the alreadyCurrent branch below), not just on a real
    // transition.
    if (outcomeReason) setOutcome(gig.key, outcomeReason, row.statusLabel);

    if (gig.status === newStatus) {
      result.alreadyCurrent.push({ key: gig.key, title: gig.title, status: gig.status });
      continue;
    }

    setStatus(gig.key, newStatus);
    result.updated.push({ key: gig.key, title: gig.title, from: gig.status, to: newStatus });
  }

  return result;
}
