import type { Page } from "playwright";
import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";
import { withBrowserSession } from "../auth/browser-session.js";
import { sessionBackendFrom } from "../auth/session-backend.js";
import { SOURCE_ORIGINS } from "./origins.js";

/**
 * A.Team (a.team / platform.a.team) — a talent-network marketplace whose
 * matched-engagement board is branded "Mission Control". `auth:
 * "browser-session"`: the second real consumer of
 * `src/lib/auth/browser-session.ts` (see that module and
 * docs/ARCHITECTURE.md's "browser-session mechanism" section for the shared
 * mechanics — origin-scoping, headed-only launch, centralized cleanup — all
 * owned there, not duplicated here), built to the identical pattern as the
 * immediately-prior `gofractional.ts` adapter.
 *
 * *** LIVE-VERIFIED 2026-08-30 — see product-review-followups epic,
 * ateam-session-lifetime-blocker story ***. This adapter went a long time
 * with live verification explicitly deferred (no reachable authenticated
 * session — see git history on this file for that original standing
 * caveat). That changed: the owner's own real account, a real Google-SSO
 * login, and a genuinely-authenticated Mission Control session confirmed
 * `MISSION_CONTROL_URL`, the real `/mission/{id}` href shape, and
 * `scrapeListings()`'s field-extraction approach all against real DOM —
 * see those declarations' own doc comments for exactly what was observed
 * and how confident each piece is.
 *
 * WHAT'S STILL UNCONFIRMED. Only TWO real cards were observed (both on the
 * "All Missions" board, both showing the "Actively looking for builders"
 * badge) — `locationType`/`commitment` (hours/remote) were not visible
 * anywhere in this board view for either, so they're left `null` rather
 * than guessed; a card layout WITHOUT that badge, or the mission DETAIL
 * page's own markup (which likely carries hours/remote/rate), are natural
 * follow-ups, not blockers. Separately (still genuinely open): the
 * session's own lifetime after capture appears short — a fresh capture
 * scraped real listings successfully, but a SEPARATE process reconnecting
 * to the saved session file some minutes later failed
 * `isAuthenticatedATeam()` — consistent with a short-TTL token needing an
 * active refresh this bare cookie-replay never exercises. Not yet fixed;
 * tracked as its own open item (product-review-followups epic).
 *
 * A.Team's real sign-in-page shape (still exactly as originally recorded):
 * page title exactly `"Sign In"`, body text containing both `"Continue
 * with Google"` and `"Continue with Github"` (that exact, non-standard
 * capitalization — not "GitHub"). See isSignInPage()/isAuthenticatedATeam()
 * below.
 */

/**
 * LIVE-VERIFIED 2026-08-30 (product-review-followups epic,
 * ateam-session-lifetime-blocker story) — the owner's own real account,
 * real Google-SSO login, first genuinely-authenticated session this
 * adapter has ever had. Bare `/mission-control` redirects (when
 * authenticated) to `/mission-control/recommended`, a personalized subset
 * — this points directly at "All Missions" instead, the comprehensive
 * board this adapter actually wants to scan (matches gofractional.ts's own
 * "scrape the full open board" scope, not a narrowed recommendation feed).
 */
const MISSION_CONTROL_URL = "https://platform.a.team/mission-control/all";
const ORIGIN_BASE = "https://platform.a.team";

/**
 * Scoped to A.Team's own domains ONLY — `a.team` and `platform.a.team`,
 * listed explicitly per this story's acceptance criteria (rather than
 * relying solely on `a.team` covering `platform.a.team` as a subdomain, the
 * way gofractional.ts's single-entry allowlist covers `app.gofractional.com`
 * — being explicit here documents both real origins this adapter actually
 * needs, independent of the subdomain-matching implementation detail). NEVER
 * Google/Clerk SSO or any other origin a broader multi-site storageState
 * file (like the real `gf.json`, which spans 23 origins including A.Team,
 * GoFractional, and Google/Clerk SSO — see the research brief) might also
 * carry. See browser-session.ts's domainMatchesAllowlist() for the
 * exact-or-subdomain matching this list is filtered through before any
 * cookie reaches a browser context.
 *
 * Sourced from the shared registry (src/lib/sources/origins.ts) rather than
 * an inline constant, so this adapter and the session-capture mechanism
 * never drift apart on what "ateam" is allowed to touch.
 */
const ALLOWED_ORIGINS = SOURCE_ORIGINS["ateam"]!;

/**
 * Raw, already-flat data pulled out of one Mission Control listing's DOM —
 * STRUCTURE-DERIVED FIELD NAMES/SHAPES, see file-level comment. No HTML, no
 * PII beyond public client/role-title text (same convention as
 * GoFractionalRawCard in gofractional.ts).
 */
interface ATeamRawListing {
  /** e.g. "/mission/6a758de15ebba7b792fb976e" — LIVE-VERIFIED 2026-08-30 real shape (singular "mission", a Mongo-style id, not the earlier guessed "/missions/{slug}"). */
  href: string;
  title: string;
  /** The engaging client/company name, if the card surfaces one. */
  client: string | null;
  /** e.g. "Remote" | "Hybrid" | "On-site" — assumed analogous to gofractional.ts's workType badge; unverified real value set. */
  locationType: string | null;
  /** e.g. "10-20 hrs/week" or "20 hrs/week" — assumed analogous to gofractional.ts's hours text; unverified real shape. */
  commitment: string | null;
}

/**
 * "Remote" -> true, "On-site" -> false. "Hybrid" (and anything unrecognized,
 * including if A.Team's real value set differs entirely from this
 * assumption) is genuinely ambiguous — left unset (unknown) rather than
 * guessed, same convention as gofractional.ts's toRemote()/builtin.ts's.
 */
function toRemote(locationType: string | null): boolean | undefined {
  if (locationType === "Remote") return true;
  if (locationType === "On-site") return false;
  return undefined;
}

const HOURS_RE = /^(\d+)(?:-(\d+))?\s*hrs\/week$/;

/**
 * Assumed to follow the same "N-M hrs/week" range / single-figure shape as
 * GoFractional's card (unverified for A.Team specifically — see file-level
 * comment). `Gig.weeklyHours` only holds one number, so a range reports its
 * UPPER bound — the real, stated ceiling this listing could demand, same
 * reasoning as gofractional.ts's toWeeklyHours(). An unrecognized/missing
 * string leaves weeklyHours unset (unknown), never guessed.
 */
function toWeeklyHours(commitment: string | null): number | undefined {
  if (!commitment) return undefined;
  const m = HOURS_RE.exec(commitment.trim());
  if (!m) return undefined;
  const min = Number(m[1]);
  const max = m[2] !== undefined ? Number(m[2]) : min;
  return max;
}

/**
 * `href` is LIVE-VERIFIED (2026-08-30) to be "/mission/{id}" (singular,
 * Mongo-style id — see ATeamRawListing's own doc comment). The whole id is
 * used as `externalId` — stable and unique, same convention as
 * gofractional.ts's externalIdFromHref().
 */
function externalIdFromHref(href: string): string | undefined {
  const m = /^\/mission\/([^/?#]+)/.exec(href);
  return m ? m[1] : undefined;
}

function toGig(listing: ATeamRawListing, _now: Date): Gig | null {
  const externalId = externalIdFromHref(listing.href);
  if (!externalId || listing.title.length === 0) return null; // can't build a valid Gig without a stable id and a title

  return {
    sourceId: "ateam",
    externalId,
    title: listing.title,
    company: listing.client ?? undefined,
    // The real per-listing permalink, constructed from the listing's own
    // anchor href — never the Mission Control board's own list-view URL.
    url: `${ORIGIN_BASE}${listing.href}`,
    weeklyHours: toWeeklyHours(listing.commitment),
    remote: toRemote(listing.locationType),
    // No `rate` field: unlike GoFractional's confirmed absence of a $ figure
    // on its cards, A.Team's real card content was never observed live at
    // all (see file-level comment) — rather than guess whether/how a rate
    // renders, this adapter deliberately never populates `Gig.rate`, per
    // this repo's no-fabricated-data rule (docs/ARCHITECTURE.md). Revisit
    // once live verification confirms the real card shape.
    // No `postedAt` either, for the same reason — A.Team's real
    // relative/absolute date format (if any) was never observed.
    raw: listing,
  };
}

/**
 * Checks A.Team's REAL, live-observed sign-in-page shape (research brief
 * §7, quoted verbatim in the file-level comment) — title exactly "Sign In",
 * body text containing both "Continue with Google" and "Continue with
 * Github" (that literal capitalization, as actually recorded). Requiring
 * ALL THREE signals together (not a loose single-substring check) is
 * deliberate — matches this epic's design-discussion guidance that a
 * DOM-text auth-failure signal must be a tight match against real observed
 * content, never a generic "contains Sign In" heuristic (an earlier draft
 * of that heuristic was flagged in review for exactly this false-positive
 * risk, e.g. an authenticated page's account-switcher footer incidentally
 * saying "Sign in as a different account").
 */
async function isSignInPage(page: Page): Promise<boolean> {
  const title = await page.title();
  if (title !== "Sign In") return false;
  // Deliberately `page.textContent("body")` rather than
  // `page.evaluate(() => document.body.innerText)` — kept a SEPARATE
  // Playwright call from scrapeListings()'s own `page.evaluate()` below, the
  // same way gofractional.ts's isAuthenticatedGoFractional() uses `$$eval`
  // while its card scraper uses `evaluate` (two independent DOM-read calls,
  // never sharing one mockable entry point) — both for real-world clarity
  // and so tests can mock the sign-in check and the listing scrape
  // independently within a single fetch() run.
  const bodyText = (await page.textContent("body")) ?? "";
  return bodyText.includes("Continue with Google") && bodyText.includes("Continue with Github");
}

/**
 * `withBrowserSession()`'s per-source auth-failure predicate. Unlike
 * gofractional.ts's isAuthenticatedGoFractional() (a POSITIVE
 * authenticated-state signal — a real "Dashboard" nav link, live-confirmed),
 * this adapter can only ground itself in a NEGATIVE signal: A.Team's real
 * sign-in-page content is the one thing this epic actually observed live
 * (see research brief §7) — its real *authenticated* Mission Control
 * board content was never reachable to confirm. This epic's
 * design-discussion also names a URL-path-based check as the PRIMARY signal
 * of choice generally (comparing the post-navigation URL against a
 * per-source "authenticated shape"), with DOM text as a secondary fallback
 * — that ordering is deliberately inverted here because A.Team's real
 * post-expiry redirect URL was never captured either (only page title/body
 * were recorded live), so asserting a specific URL shape would itself be a
 * fabrication. isSignInPage()'s tightly-scoped, genuinely-observed DOM
 * check is therefore used as the sole signal. Adding a corroborating
 * URL-based check is a natural, named follow-up once live verification
 * captures the real redirect target — see docs/ARCHITECTURE.md's roadmap.
 */
async function isAuthenticatedATeam(page: Page): Promise<boolean> {
  return !(await isSignInPage(page));
}

/**
 * Extracts raw listing data from the Mission Control board's DOM.
 * LIVE-VERIFIED 2026-08-30 (product-review-followups epic,
 * ateam-session-lifetime-blocker story) against the owner's own real,
 * authenticated account — the first time this adapter has ever seen real
 * Mission Control markup (see file-level comment for the full history).
 *
 * `a[href^="/mission/"]` (singular) is the real card anchor selector —
 * gofractional.ts-style card-container-climbing was abandoned in favor of
 * this: two real cards observed both had NO stable `data-testid`/class name
 * anywhere in their subtree (a React app with hashed/generated class
 * names), so climbing to find one would have been guessing blind. Instead
 * this reads every genuinely-leaf, non-empty TEXT node inside the anchor in
 * document order — icons/images contribute no `textContent`, so they drop
 * out naturally without any class-name assumption at all. Live-observed
 * order across both real cards: `[company, mission tagline, role title,
 * "Actively looking for builders" (badge, not always present), "Matched on
 * ... skills" (not always present)]`. `client` (index 0) and `title` (index
 * 2, the role) are used with high confidence — that ordering matched both
 * observed cards exactly. `locationType`/`commitment` are left `null`
 * (unknown, never fabricated) because NEITHER real card showed an
 * hours/remote figure anywhere in this board view — unlike gofractional's
 * confirmed absence of a $ rate, this is a genuine "not observed yet, not
 * confirmed absent" gap, worth re-checking against the mission DETAIL page
 * (`/mission/{id}`) in a future pass rather than guessing here.
 */
async function scrapeListings(page: Page): Promise<ATeamRawListing[]> {
  // LIVE-VERIFIED 2026-08-31: `withBrowserSession()`'s own `page.goto(url)`
  // has no `waitUntil` option (defaults to the "load" event) and no
  // follow-up wait — Mission Control is a React SPA whose mission cards
  // render via an async API call AFTER "load" fires, so scraping
  // immediately found the selector fix above still returning ZERO
  // listings against a genuinely-authenticated session. Exact same root
  // cause (and fix) as custom-llm-source.ts's gun-io fix earlier this
  // epic — a real content wait, not a fixed sleep. Best-effort: a
  // never-quite-idle page (background polling, analytics beacons) should
  // still get scraped with whatever DID render, not fail outright.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/mission/"]')];

    return anchors.map((anchor) => {
      const href = anchor.getAttribute("href")!;

      const texts = [...anchor.querySelectorAll("*")]
        .filter((el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0)
        .map((el) => (el.textContent ?? "").trim());

      const client = texts[0] ?? null;
      const title = texts[2] ?? texts[1] ?? texts[0] ?? "";

      return { href, title, client, locationType: null, commitment: null };
    });
  });
}

/** Required only for the "local" (default) session backend -- see sessionBackendFrom(). A "portunus"-backed source needs no local path at all. */
function sessionStatePathFrom(cfg: SourceConfig): string {
  const configured = cfg.settings?.sessionStatePath;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error(
      'ateam: source "ateam" is missing settings.sessionStatePath. ' +
        "Set it to a storageState file path (or an \"env:VAR_NAME\" reference) — see docs/ARCHITECTURE.md's browser-session section.",
    );
  }
  return configured;
}

export const ateamSource: Source = {
  id: "ateam",
  label: "A.Team",
  auth: "browser-session",
  async fetch(cfg: SourceConfig): Promise<Gig[]> {
    const sessionBackend = sessionBackendFrom(cfg);
    const sessionStatePath = sessionBackend === "local" ? sessionStatePathFrom(cfg) : undefined;

    const listings = await withBrowserSession(
      {
        sourceId: "ateam",
        storageStatePathSetting: sessionStatePath,
        sessionBackend,
        allowedOrigins: [...ALLOWED_ORIGINS],
        url: MISSION_CONTROL_URL,
        isAuthenticated: isAuthenticatedATeam,
        // true-embedded-browser epic: this is an unattended scan -- a
        // headed browser must never open here, see withBrowserSession()'s
        // own attended doc comment.
        attended: false,
      },
      async (page) => scrapeListings(page),
    );

    // isAuthenticatedATeam() above already ruled out the auth-failure case
    // (withBrowserSession throws before this point ever runs) — zero
    // listings scraped despite a confirmed-authenticated session means the
    // card markup this adapter assumes has drifted (or was wrong to begin
    // with — see file-level comment), not a confirmed legitimate empty
    // board. Throwing rather than silently returning [] matches this
    // repo's no-silent-zero rule (docs/ARCHITECTURE.md) and gofractional.ts's
    // precedent; unlike GoFractional's public, unfiltered board, A.Team's
    // Mission Control is a personalized match list that COULD legitimately
    // be empty for a given account — this is a deliberate, conservative
    // choice to surface a possible scraping break rather than mask one, and
    // is explicitly named here as a judgment call worth revisiting once
    // live verification confirms real board behavior.
    if (listings.length === 0) {
      throw new Error(`ateam: found 0 mission listings at ${MISSION_CONTROL_URL} — the listing markup this adapter expects may have changed`);
    }

    const now = new Date();
    const gigs = listings.map((l) => toGig(l, now)).filter((g): g is Gig => g !== null);

    // Listings were found but every single one failed to parse into a valid
    // Gig — a real parsing break, same convention as gofractional.ts.
    if (gigs.length === 0) {
      throw new Error(`ateam: found ${listings.length} mission listing(s) but could not parse any of them`);
    }

    return gigs;
  },
};

registerSource(ateamSource);
