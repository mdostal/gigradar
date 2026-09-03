import type { Page } from "playwright";
import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";
import { withBrowserSession } from "../auth/browser-session.js";
import { sessionBackendFrom } from "../auth/session-backend.js";
import { SOURCE_ORIGINS } from "./origins.js";

/**
 * GoFractional (gofractional.com) — a Cloudflare-fronted fractional/interim
 * jobs board. `auth: "browser-session"`: this adapter is the first real
 * consumer of `src/lib/auth/browser-session.ts` (see that module and
 * docs/ARCHITECTURE.md's "browser-session mechanism" section for the shared
 * mechanics — origin-scoping, headed-only launch, centralized cleanup — all
 * owned there, not duplicated here).
 *
 * REAL, LIVE-VERIFIED PAGE SHAPE (verified against the owner's real,
 * already-logged-in session, plain headed Chromium, zero privilege
 * escalation or console-session tricks needed — see this story's
 * completion notes for the full run):
 *
 * - `https://www.gofractional.com/jobs` is **publicly viewable even fully
 *   logged out** — it renders the same real listing cards either way, with
 *   NO sign-in redirect and NO URL change. This contradicts the naive
 *   assumption (and the initial epic-planning note) that an unauthenticated
 *   session would bounce to a distinguishable sign-in URL/page — it does
 *   not. The only reliable authenticated-vs-not signal observed is the
 *   header nav: a "Dashboard" link when authenticated, a "Log in" link
 *   (never both) when not — see isAuthenticatedGoFractional() below.
 * - Each listing's own detail page (`/job/{slug}`) is gated by a Cloudflare
 *   "Performing security verification" interstitial even from this same
 *   authenticated session/context, both via direct navigation and via a
 *   same-page link click — so this adapter deliberately never navigates
 *   there. All scraped fields come from the `/jobs` list view's own cards
 *   (same approach as braintrust.ts/builtin.ts), and `Gig.url` is the real
 *   `/job/{slug}` permalink *constructed* from each card's own anchor href
 *   — a genuine per-listing URL, just never fetched by this adapter.
 * - The list view shows no `$`-denominated rate anywhere in a card (only a
 *   filter widget elsewhere on the page uses a rate range) — `Gig.rate` is
 *   left unset (unknown), never guessed, matching this repo's no-fabricated-
 *   data rule.
 * - Only the first page's ~20 cards are scraped (a "Next" pager exists but
 *   is not followed) — deliberately scoped down, matching builtin.ts's own
 *   single-page precedent; DOM-scraping brittleness is an accepted,
 *   documented tradeoff for this source (see the story's risks).
 */

const JOBS_URL = "https://www.gofractional.com/jobs";
const ORIGIN_BASE = "https://www.gofractional.com";

/**
 * Scoped to gofractional.com and its subdomains ONLY (e.g. this also covers
 * `app.gofractional.com`, observed live in the real storageState/DOM) — NEVER
 * Google/Clerk SSO or any other origin a broader multi-site storageState file
 * (like the real `gf.json`, which spans 23 origins) might also carry. See
 * browser-session.ts's domainMatchesAllowlist() for the exact-or-subdomain
 * matching this list is filtered through before any cookie reaches a browser
 * context.
 *
 * Sourced from the shared registry (src/lib/sources/origins.ts) rather than
 * an inline constant, so this adapter and the session-capture mechanism
 * never drift apart on what "gofractional" is allowed to touch.
 */
const ALLOWED_ORIGINS = SOURCE_ORIGINS["gofractional"]!;

/** Raw, already-flat data pulled out of one listing card's DOM — no HTML, no PII beyond public company/job-title text. */
interface GoFractionalRawCard {
  /** e.g. "/job/fractional-cto-cmxxxxx" — always site-relative from the anchor's own href. */
  href: string;
  title: string;
  company: string | null;
  /** e.g. "Posted 1 day", "Posted about 6 hours", "Posted 29 days" (real observed variety). */
  posted: string | null;
  /** e.g. "Remote" | "Hybrid" | "On-site" (real observed values — the work-arrangement badge, distinct from any location text). */
  workType: string | null;
  /** e.g. "5-20 hrs/week" or "40 hrs/week" (real observed shapes — a range or a single figure). */
  hours: string | null;
}

/**
 * "Remote" -> true, "On-site" -> false. "Hybrid" (and anything unrecognized)
 * is genuinely ambiguous — left unset (unknown) rather than guessed, same
 * convention as builtin.ts's toRemote().
 */
function toRemote(workType: string | null): boolean | undefined {
  if (workType === "Remote") return true;
  if (workType === "On-site") return false;
  return undefined;
}

const HOURS_RE = /^(\d+)(?:-(\d+))?\s*hrs\/week$/;

/**
 * GoFractional's card shows a range ("5-20 hrs/week") or a single figure
 * ("40 hrs/week"); `Gig.weeklyHours` only holds one number, so this reports
 * the range's UPPER bound — the real, stated ceiling this listing could
 * demand, which is the correct side to compare against `Needs.maxHours`
 * (a gate should catch "could ask for up to 40h/week", not just the
 * best-case minimum). Never fabricated: both bounds come straight from the
 * page; only which one survives into the single-number field is a choice.
 */
function toWeeklyHours(hours: string | null): number | undefined {
  if (!hours) return undefined;
  const m = HOURS_RE.exec(hours.trim());
  if (!m) return undefined;
  const min = Number(m[1]);
  const max = m[2] !== undefined ? Number(m[2]) : min;
  return max;
}

const POSTED_RE = /^Posted\s+(?:about\s+)?(\d+)\s+(hour|day|week|month)s?$/i;

/**
 * Converts GoFractional's relative "Posted N day(s)/hour(s)/..." card text
 * to an ISO date relative to `now` (the real fetch time) — same approach as
 * builtin.ts's toPostedAt(), since GoFractional's card never shows an
 * absolute date either. An unparseable/missing string leaves postedAt unset
 * (unknown), not guessed.
 */
function toPostedAt(posted: string | null, now: Date): string | undefined {
  if (!posted) return undefined;
  const m = POSTED_RE.exec(posted.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const d = new Date(now.getTime());
  switch (unit) {
    case "hour":
      d.setUTCHours(d.getUTCHours() - n);
      break;
    case "day":
      d.setUTCDate(d.getUTCDate() - n);
      break;
    case "week":
      d.setUTCDate(d.getUTCDate() - n * 7);
      break;
    case "month":
      d.setUTCMonth(d.getUTCMonth() - n);
      break;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * `href` is always "/job/{slug}" (confirmed live — real slugs range from
 * GoFractional's own e.g. "fractional-engineering-director-cmry9syx" to
 * syndicated-listing slugs with no separate id suffix at all, e.g.
 * "ashbyhq-corporate-recruiter-contract-crusoe-jobs"). The whole slug is
 * used as `externalId` — stable and unique either way, no assumption about
 * a trailing id fragment needed.
 */
function externalIdFromHref(href: string): string | undefined {
  const m = /^\/job\/([^/?#]+)/.exec(href);
  return m ? m[1] : undefined;
}

function toGig(card: GoFractionalRawCard, now: Date): Gig | null {
  const externalId = externalIdFromHref(card.href);
  if (!externalId || card.title.length === 0) return null; // can't build a valid Gig without a stable id and a title

  return {
    sourceId: "gofractional",
    externalId,
    title: card.title,
    company: card.company ?? undefined,
    // The real per-listing permalink, constructed from the card's own
    // anchor href — never the /jobs search/listing page. Deliberately not
    // fetched (see file-level comment: Cloudflare-gates the detail page).
    url: `${ORIGIN_BASE}${card.href}`,
    weeklyHours: toWeeklyHours(card.hours),
    remote: toRemote(card.workType),
    postedAt: toPostedAt(card.posted, now),
    raw: card,
  };
}

/**
 * Confirms this is genuinely GoFractional's real jobs list page, independent
 * of auth state (this check passes whether logged in or out — see file-level
 * comment) — a structural sanity check distinct from isAuthenticatedGoFractional()
 * below. Mirrors braintrust.ts's/builtin.ts's own "is this really the page
 * we expect" guard, just for this DOM shape instead of a JSON/HTML marker.
 */
async function isRealJobsPage(page: Page): Promise<boolean> {
  const title = await page.title();
  return title.includes("Fractional Jobs");
}

/**
 * How long to keep polling for the "Dashboard" nav link before concluding
 * the session is genuinely invalid — see this function's doc comment for
 * why a single immediate check is NOT safe here.
 */
const AUTH_CHECK_POLL_TIMEOUT_MS = 5000;
const AUTH_CHECK_POLL_INTERVAL_MS = 250;

async function hasDashboardLink(page: Page): Promise<boolean> {
  return page.$$eval("a", (anchors) => anchors.some((a) => (a.textContent ?? "").trim() === "Dashboard"));
}

/**
 * GoFractional's `/jobs` page renders identically (same real listings, no
 * redirect) whether authenticated or not — confirmed live, contradicting
 * the "redirects to a distinguishable sign-in URL/state" assumption noted at
 * epic-planning time. The one reliable authenticated-vs-not signal actually
 * observed is the header nav: a "Dashboard" link appears ONLY when
 * authenticated (a "Log in" link appears instead when not, but checking for
 * the positive "Dashboard" signal is more robust than asserting the negative
 * absence of some other text).
 *
 * MUST poll rather than check once immediately after navigation — confirmed
 * live that this is a client-hydrated nav: right after `page.goto()`
 * resolves, the DOM still shows the logged-out shell (no "Dashboard" link)
 * for a few hundred ms even with a perfectly valid, authenticated session,
 * only swapping in the real authenticated nav once client-side hydration
 * catches up. An immediate single check produced a false "session
 * expired/invalid" against a session confirmed valid seconds earlier by a
 * slower, waited check — this loop is what fixed that. A genuinely
 * unauthenticated session never gains the link no matter how long this
 * waits, so the bounded timeout below only ever adds latency to the
 * genuine-failure path, never a false positive.
 */
export async function isAuthenticatedGoFractional(page: Page): Promise<boolean> {
  const deadline = Date.now() + AUTH_CHECK_POLL_TIMEOUT_MS;
  for (;;) {
    if (await hasDashboardLink(page)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(AUTH_CHECK_POLL_INTERVAL_MS);
  }
}

/**
 * Extracts raw card data from the `/jobs` page's DOM via `page.$$eval` — the
 * data-extraction step runs INSIDE the real browser page in production, and
 * this function returns only flat strings (no live `Page`/DOM handles), so
 * `toGig()` above (and the tests exercising it) never need a real or
 * simulated DOM, only this plain-data shape.
 */
async function scrapeCards(page: Page): Promise<GoFractionalRawCard[]> {
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/job/"]')].filter(
      (a) => !a.getAttribute("href")!.startsWith("/jobs"),
    );

    return anchors.map((anchor) => {
      // Climb from the title anchor to the smallest ancestor whose text
      // includes both "Posted" and "hrs/week" — the real card container
      // (confirmed live; GoFractional's markup has no single stable
      // data-testid/class marking the card itself).
      let card: Element = anchor;
      for (let i = 0; i < 12 && card.parentElement; i++) {
        card = card.parentElement;
        const t = card.textContent ?? "";
        if (t.includes("Posted") && t.includes("hrs/week")) break;
      }

      const href = anchor.getAttribute("href")!;
      const title = (anchor.textContent ?? "").trim();
      const companyEl = card.querySelector(".text-blue-400");
      const company = companyEl ? (companyEl.textContent ?? "").trim() : null;
      const postedEl = [...card.querySelectorAll("span")].find((s) => /^Posted /.test(s.textContent ?? ""));
      const posted = postedEl ? (postedEl.textContent ?? "").trim() : null;
      const badge = card.querySelector("span.rounded-full");
      const workType = badge ? (badge.textContent ?? "").trim() : null;
      const hoursMatch = /(\d+(?:-\d+)?\s*hrs\/week)/.exec(card.textContent ?? "");
      const hours = hoursMatch ? hoursMatch[1]! : null;

      return { href, title, company, posted, workType, hours };
    });
  });
}

/** Required only for the "local" (default) session backend -- see sessionBackendFrom(). A "portunus"-backed source needs no local path at all. */
function sessionStatePathFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.sessionStatePath;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error(
      'gofractional: source "gofractional" is missing settings.sessionStatePath. ' +
        "Set it to a storageState file path (or an \"env:VAR_NAME\" reference) — see docs/ARCHITECTURE.md's browser-session section.",
    );
  }
  return configured;
}

export const gofractionalSource: Source = {
  id: "gofractional",
  label: "GoFractional",
  auth: "browser-session",
  // platform-aware-application-drafting epic, owner's own words: "you add
  // why you're a fit on go-fractional" -- a single, punchy "why are you a
  // fit" statement, not a traditional cover letter.
  applicationFormat: "why-fit",
  async fetch(cfg: SourceConfig): Promise<Gig[]> {
    const sessionBackend = sessionBackendFrom(cfg);
    const sessionStatePath = sessionBackend === "local" ? sessionStatePathFrom(cfg) : undefined;

    const cards = await withBrowserSession(
      {
        sourceId: "gofractional",
        storageStatePathSetting: sessionStatePath,
        sessionBackend,
        allowedOrigins: [...ALLOWED_ORIGINS],
        url: JOBS_URL,
        isAuthenticated: isAuthenticatedGoFractional,
        // true-embedded-browser epic: this is an unattended scan -- a
        // headed browser must never open here, see withBrowserSession()'s
        // own attended doc comment.
        attended: false,
      },
      async (page) => {
        // isAuthenticatedGoFractional() above already ruled out the
        // auth-failure case (withBrowserSession throws before this callback
        // ever runs) — this is a SEPARATE structural check: is this really
        // the real jobs page, independent of auth state (see
        // isRealJobsPage()'s doc comment).
        if (!(await isRealJobsPage(page))) {
          throw new Error(`gofractional: unexpected page shape at ${JOBS_URL} (page title did not match)`);
        }
        return scrapeCards(page);
      },
    );

    // Unlike builtin.ts's per-category page (where zero listings in one
    // category is legitimate), GoFractional's unfiltered main /jobs board
    // realistically never has zero listings — confirmed live to always
    // render ~20+ cards. Zero cards here, despite the page-shape check
    // above passing, means the card-selector DOM assumptions broke (markup
    // drift), not a genuinely empty board — throw rather than silently
    // returning [] (this repo's no-silent-zero rule, applied to a scraping
    // break specifically, same spirit as the auth-failure case above).
    if (cards.length === 0) {
      throw new Error(`gofractional: found 0 job cards at ${JOBS_URL} — the card markup this adapter expects may have changed`);
    }

    const now = new Date();
    const gigs = cards.map((c) => toGig(c, now)).filter((g): g is Gig => g !== null);

    // Cards were found but every single one failed to parse into a valid
    // Gig — a real parsing break, same convention as builtin.ts.
    if (gigs.length === 0) {
      throw new Error(`gofractional: found ${cards.length} job card(s) but could not parse any of them`);
    }

    return gigs;
  },
};

registerSource(gofractionalSource);
