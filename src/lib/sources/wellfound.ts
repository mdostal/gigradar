import type { Page } from "playwright";
import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";
import { withBrowserSession } from "../auth/browser-session.js";
import { sessionBackendFrom } from "../auth/session-backend.js";
import { SOURCE_ORIGINS } from "./origins.js";

/**
 * Wellfound (wellfound.com, formerly AngelList Talent) — a client-rendered,
 * Google-OAuth-gated startup jobs board. `auth: "browser-session"`: the
 * third real consumer of `src/lib/auth/browser-session.ts` (see that module
 * and docs/ARCHITECTURE.md's "browser-session mechanism" section for the
 * shared mechanics — origin-scoping, headed-only launch, centralized
 * cleanup — all owned there, not duplicated here).
 *
 * LIVE-VERIFIED 2026-08-31 (product-review-followups epic — the owner's own
 * real account, real Google-SSO login) — REPLACES the earlier
 * `__NEXT_DATA__` JSON-walk approach entirely. That approach's own header
 * comment (see git history) honestly admitted its target URLs
 * (`/role/l/chief-technology-officer`, `/role/l/vp-of-engineering`) 404'd
 * even anonymously, and its fixture was synthetic — the walk logic itself
 * was NEVER actually confirmed against real listing data. Real findings
 * this pass:
 *   - The real, working candidate jobs board is simply `https://wellfound.com/jobs`
 *     (no per-role path at all — matches this file's own prior note that
 *     role-filtering likely moved to a query-string shape).
 *   - Each real job card is a plain anchor: `<a href="/jobs/{id}-{slug}"
 *     target="_blank">` — a real, stable per-listing URL, not a client-router
 *     row (unlike gofractional.ts's application-status rows). `{id}` is a
 *     numeric prefix before the first `-`; the WHOLE `{id}-{slug}` segment is
 *     used as `externalId` (matches gofractional.ts's/ateam.ts's convention
 *     of using the full slug, not just a numeric fragment).
 *   - The card's title is its own first meaningful text node (a `<span>`
 *     with a CSS-module class whose hash suffix isn't assumed stable —
 *     read structurally, not by class name, same reasoning as ateam.ts's
 *     scrapeListings()).
 *   - Company name, compensation (a combined salary+equity range, e.g. "$100k
 *     – $150k • 0.0% – 2.0%" — NOT a clean single rate figure), and
 *     remote/location shape were NOT reliably extractable from this pass
 *     (no single stable company-name field observed on the card; the
 *     compensation string mixes salary and equity in one line, not this
 *     repo's `Gig.rate` shape) — left unset rather than guessed, this
 *     repo's no-fabricated-data rule. A future pass with more DOM samples
 *     could add these; this fix's scope is "produces real listings at all,"
 *     which the prior version never did.
 */

const ORIGIN_BASE = "https://wellfound.com";

/** LIVE-VERIFIED 2026-08-31 — see file-level comment. The real, working candidate jobs board — no per-role path. */
const JOBS_URL = `${ORIGIN_BASE}/jobs`;

/**
 * Scoped to wellfound.com ONLY — NEVER Google/Clerk SSO or any other origin
 * a broader multi-site storageState file might also carry. See
 * browser-session.ts's domainMatchesAllowlist() for the exact-or-subdomain
 * matching this list is filtered through before any cookie reaches a
 * browser context.
 *
 * Sourced from the shared registry (src/lib/sources/origins.ts) rather than
 * an inline constant, so this adapter and the session-capture mechanism
 * never drift apart on what "wellfound" is allowed to touch.
 */
const ALLOWED_ORIGINS = SOURCE_ORIGINS["wellfound"]!;

/** Raw, already-flat data pulled out of one real job-card anchor — no HTML, no PII beyond public job-title text. */
interface WellfoundRawListing {
  /** e.g. "4617965-founding-cto-chief-ai-delivery-officer" — the full path segment after "/jobs/", live-verified real shape. */
  href: string;
  title: string;
}

function toGig(listing: WellfoundRawListing): Gig {
  return {
    sourceId: "wellfound",
    externalId: listing.href,
    title: listing.title,
    url: `${ORIGIN_BASE}/jobs/${listing.href}`,
    // company/rate/weeklyHours/remote/postedAt deliberately omitted (left
    // unset/unknown) — not reliably extractable from the real card DOM
    // observed live (see file-level comment); this repo's no-fabricated-
    // data rule means this adapter only reports fields it actually found.
    raw: listing,
  };
}

/**
 * Extracts real job-card data from `/jobs` via `page.$$eval` — mirrors
 * ateam.ts's/gofractional.ts's flat-DOM-query approach (this file's own
 * ORIGINAL design intentionally diverged from that pattern for an
 * unverified `__NEXT_DATA__` walk; live verification found the real page
 * needs the same flat-anchor approach after all — see file-level comment).
 * `a[href^="/jobs/"]` filtered to hrefs starting with a digit (the real,
 * live-observed shape: `/jobs/{numericId}-{slug}`) — excludes the "Jobs"
 * nav link itself (`/jobs`, no trailing segment) and any other non-listing
 * `/jobs/*` route without needing to enumerate them by name.
 */
async function scrapeJobCards(page: Page): Promise<WellfoundRawListing[]> {
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/jobs/"]')].filter((a) =>
      /^\/jobs\/\d/.test(a.getAttribute("href") ?? ""),
    );

    return anchors.map((anchor) => {
      const href = anchor.getAttribute("href")!.replace(/^\/jobs\//, "");
      const title = [...anchor.querySelectorAll("*")]
        .filter((el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0)
        .map((el) => (el.textContent ?? "").trim())[0];
      return { href, title: title ?? "" };
    });
  });
}

/**
 * Checks Wellfound's REAL, live-observed login-page shape (see file-level
 * comment: title exactly "Log In | Wellfound", body containing "Continue
 * with Google") — the one piece of genuinely confirmed, live-observed
 * authenticated-vs-not signal this adapter has, following the same
 * "positive absence of a genuinely observed sign-in signature" pattern as
 * ateam.ts's isAuthenticatedATeam()/isSignInPage(). Unlike A.Team's real
 * board URL (confirmed live to redirect to sign-in when unauthenticated),
 * Wellfound's own two role-board URLs currently 404 site-wide regardless of
 * auth state (see file-level comment) — so this predicate's real-world
 * trigger (an authenticated-session-required redirect actually landing on
 * this exact login page) could not be observed at those specific URLs
 * during this story. It's still the most honestly-grounded signal
 * available: real, live-observed content, applied consistently, rather
 * than an invented URL/DOM heuristic.
 */
async function isSignInPage(page: Page): Promise<boolean> {
  const title = await page.title();
  if (title !== "Log In | Wellfound") return false;
  const bodyText = (await page.textContent("body")) ?? "";
  return bodyText.includes("Continue with Google");
}

export async function isAuthenticatedWellfound(page: Page): Promise<boolean> {
  return !(await isSignInPage(page));
}

/** Required only for the "local" (default) session backend -- see sessionBackendFrom(). A "portunus"-backed source needs no local path at all. */
function sessionStatePathFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.sessionStatePath;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error(
      'wellfound: source "wellfound" is missing settings.sessionStatePath. ' +
        "Set it to a storageState file path (or an \"env:VAR_NAME\" reference) — see docs/ARCHITECTURE.md's browser-session section. " +
        "Wellfound gets its own dedicated session file — never reuse gofractional's or ateam's.",
    );
  }
  return configured;
}

export const wellfoundSource: Source = {
  id: "wellfound",
  label: "Wellfound",
  auth: "browser-session",
  async fetch(cfg: SourceConfig): Promise<Gig[]> {
    const sessionBackend = sessionBackendFrom(cfg);
    const sessionStatePath = sessionBackend === "local" ? sessionStatePathFrom(cfg) : undefined;

    const listings = await withBrowserSession(
      {
        sourceId: "wellfound",
        storageStatePathSetting: sessionStatePath,
        sessionBackend,
        allowedOrigins: [...ALLOWED_ORIGINS],
        url: JOBS_URL,
        isAuthenticated: isAuthenticatedWellfound,
        // true-embedded-browser epic: this is an unattended scan -- a
        // headed browser must never open here, see withBrowserSession()'s
        // own attended doc comment.
        attended: false,
      },
      (page) => scrapeJobCards(page),
    );

    // isAuthenticatedWellfound() above already ruled out the auth-failure
    // case (withBrowserSession throws before this point ever runs) — zero
    // listings scraped despite a confirmed-authenticated session means the
    // card markup this adapter assumes has drifted, not a confirmed
    // legitimate empty board. Throw rather than silently returning [] —
    // this repo's no-silent-zero rule, same convention as
    // gofractional.ts/ateam.ts.
    if (listings.length === 0) {
      throw new Error(`wellfound: found 0 job listings at ${JOBS_URL} — the listing markup this adapter expects may have changed`);
    }

    return listings.filter((l) => l.title.length > 0).map(toGig);
  },
};

registerSource(wellfoundSource);
