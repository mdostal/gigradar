import type { Page } from "playwright";
import type { SourceConfig } from "../types.js";
import { listGigs, setStatus } from "../store/index.js";
import type { GigStatus } from "../store/index.js";
import { withBrowserSession } from "../auth/browser-session.js";
import { sessionBackendFrom, type SessionBackend } from "../auth/session-backend.js";
import { SOURCE_ORIGINS } from "./origins.js";
import { isAuthenticatedWellfound } from "./wellfound.js";

/**
 * Status reconciliation for Wellfound (product-review-followups epic,
 * status-reconciliation-from-platforms story — second source, mirrors
 * gofractional-status.ts's own shape). LIVE-VERIFIED 2026-08-31 against
 * the owner's own real account (a dual candidate/recruiter account —
 * `https://wellfound.com/jobs/applications` is the real "Applied" nav tab,
 * reached via the candidate side).
 *
 * REAL PAGE SHAPE. Two pages, not one: `/jobs/applications` ("Ongoing" —
 * live-observed status label "Pending") and `/jobs/applications/archived`
 * ("Archived" — live-observed status label "Expired"). Each row IS a real
 * `<a href="/jobs/applications/{id}">` (or `/archived/{id}`) anchor —
 * UNLIKE gofractional.ts's own application rows, which have no real href
 * at all. That href is still not usable for matching back to a locally-
 * tracked gig, though: it's the APPLICATION's own id, not the underlying
 * job listing's `externalId` (wellfound.ts's own `/jobs/{id}-{slug}`
 * shape) — no direct lookup exists without an extra per-row navigation
 * this pass doesn't do. Matching is therefore by NORMALIZED TITLE, same
 * discipline and same risk profile as gofractional-status.ts.
 */
const APPLICATIONS_URL = "https://wellfound.com/jobs/applications";
const ARCHIVED_APPLICATIONS_URL = "https://wellfound.com/jobs/applications/archived";
const ALLOWED_ORIGINS = SOURCE_ORIGINS["wellfound"]!;

export interface ApplicationStatusRow {
  company: string;
  title: string;
  statusLabel: string;
  updatedText: string;
}

/**
 * "pending"/"expired" -> LIVE-VERIFIED (both real labels observed on the
 * owner's real account 2026-08-31 — Pending on the one real ongoing
 * application, Expired on several real archived ones). Every other key is
 * a REASONABLE, UNVERIFIED GUESS at labels this account's data didn't
 * happen to include — same discipline and same caveat as
 * gofractional-status.ts's own STATUS_LABEL_MAP.
 */
const STATUS_LABEL_MAP: Record<string, GigStatus> = {
  pending: "applied",
  expired: "archived",
  rejected: "archived",
  declined: "archived",
  withdrawn: "archived",
  interviewing: "interview",
  interview: "interview",
};

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Extracts every application-status row from one applications page (either
 * `/jobs/applications` or `/jobs/applications/archived`) via a leaf-text-
 * node walk — same technique as ateam.ts's/gofractional-status.ts's own
 * scrape functions (no stable CSS-module class name survives a rebuild;
 * reading visible text in document order does). Live-verified real order
 * per row: `[company, title, statusLabel, updatedText]` — the row's own
 * status "badge" `<div>` is empty (no text), so it contributes nothing and
 * never shifts this ordering.
 */
export async function scrapeApplicationStatuses(page: Page): Promise<ApplicationStatusRow[]> {
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/jobs/applications/"]')];
    return anchors.map((anchor) => {
      const texts = [...anchor.querySelectorAll("*")]
        .filter((el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0)
        .map((el) => (el.textContent ?? "").trim());
      return {
        company: texts[0] ?? "",
        title: texts[1] ?? "",
        statusLabel: texts[2] ?? "",
        updatedText: texts[3] ?? "",
      };
    });
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
      'wellfound-status: source "wellfound" is missing settings.sessionStatePath. ' +
        "Set it to a storageState file path (or an \"env:VAR_NAME\" reference) — see docs/ARCHITECTURE.md's browser-session section.",
    );
  }
  return configured;
}

async function fetchApplicationsPage(url: string, sessionStatePath: string | undefined, sessionBackend: SessionBackend): Promise<ApplicationStatusRow[]> {
  return withBrowserSession(
    {
      sourceId: "wellfound",
      storageStatePathSetting: sessionStatePath,
      sessionBackend,
      allowedOrigins: [...ALLOWED_ORIGINS],
      url,
      isAuthenticated: isAuthenticatedWellfound,
    },
    (page) => scrapeApplicationStatuses(page),
  );
}

/**
 * Scrapes Wellfound's real application-status pages (both "Ongoing" and
 * "Archived") and updates locally-tracked gigs (sourceId "wellfound") whose
 * status has genuinely changed on the real platform. Same no-fabrication
 * discipline as gofractional-status.ts's reconcileGoFractionalStatuses():
 * an ambiguous (>1 local match) row is reported, never written; a row with
 * no local match at all is reported, never dropped silently.
 */
export async function reconcileWellfoundStatuses(cfg: SourceConfig): Promise<ReconciliationResult> {
  const sessionBackend = sessionBackendFrom(cfg);
  const sessionStatePath = sessionBackend === "local" ? sessionStatePathFrom(cfg) : undefined;

  const [ongoing, archived] = await Promise.all([
    fetchApplicationsPage(APPLICATIONS_URL, sessionStatePath, sessionBackend),
    fetchApplicationsPage(ARCHIVED_APPLICATIONS_URL, sessionStatePath, sessionBackend),
  ]);
  const rows = [...ongoing, ...archived];

  const localGigs = listGigs().filter((g) => g.sourceId === "wellfound");
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
