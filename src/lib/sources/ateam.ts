import type { Page } from "playwright";
import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";
import { withBrowserSession } from "../auth/browser-session.js";
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
 * *** LIVE VERIFICATION IS EXPLICITLY DEFERRED — READ BEFORE TOUCHING THIS
 * FILE ***. Unlike GoFractional (live-verified against a real, valid
 * session), A.Team's stored session was confirmed LOGGED OUT during this
 * epic's planning (both headless and headed, against both `mat.json` and the
 * broader `gf.json` — see
 * .pHive/epics/browser-session-auth/docs/research-brief.md §7). Completing a
 * fresh interactive Google/Github OAuth login is not something the executing
 * agent can do on the owner's behalf. Per `ateam-adapter.yaml`'s explicit,
 * bifurcated acceptance criteria, this story's DoD covers code correctness,
 * pattern parity with `gofractional.ts`, and fixture-based tests only — real
 * live scraping results (`Gig[]` from an actually-authenticated session) are
 * a STANDING FOLLOW-UP owned by the project owner (mdostal), tracked in
 * docs/ARCHITECTURE.md's roadmap, not a blocker for this story.
 *
 * FIXTURE / STRUCTURAL ASSUMPTIONS ARE STRUCTURE-DERIVED, NOT LIVE-CAPTURED.
 * The research brief documents the legacy tool's *architecture*
 * (`sources.mjs`'s subprocess-and-stdout-scrape integration, which this
 * adapter deliberately does NOT port — see the module-level parallel in
 * gofractional.ts) but does not carry recorded per-listing DOM markup for
 * A.Team's Mission Control board (no valid session was ever reachable to
 * capture it live). Every raw-listing field name, CSS-selector assumption,
 * and the `MISSION_CONTROL_URL`/per-listing href shape below are therefore a
 * best-effort structural approximation — informed by A.Team's own public
 * "Mission Control" branding and gofractional.ts's card-scraping pattern,
 * NOT a recorded live capture. A future maintainer with a valid session MUST
 * re-verify every one of these against the real page before trusting live
 * output; the fixture in
 * src/lib/sources/__tests__/fixtures/ateam-mission-control-listings.json
 * carries the same warning.
 *
 * THE ONE PIECE OF GENUINELY CONFIRMED, LIVE-OBSERVED DATA — used exactly as
 * observed, not paraphrased — is A.Team's real sign-in-page shape (research
 * brief §7): page title exactly `"Sign In"`, body text containing both
 * `"Continue with Google"` and `"Continue with Github"` (that exact,
 * non-standard capitalization — not "GitHub" — is what was actually
 * recorded live). See isSignInPage()/isAuthenticatedATeam() below.
 */

/**
 * BEST-GUESS URL, NOT LIVE-CONFIRMED — see file-level comment. A.Team's own
 * "Mission Control" branding for its matched-engagement board is public; the
 * exact path was never reachable during this epic (every live attempt
 * landed on Sign In before any board content could be observed). Chosen as
 * the most plausible board URL under `platform.a.team` pending live
 * re-verification.
 */
const MISSION_CONTROL_URL = "https://platform.a.team/mission-control";
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
  /** e.g. "/missions/fractional-cto-acme-corp" — assumed site-relative from the listing's own anchor href; unverified real shape. */
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
 * `href` is assumed to always be "/missions/{slug}" (unverified real shape —
 * see file-level comment). The whole slug is used as `externalId` — stable
 * and unique either way, same convention as gofractional.ts's
 * externalIdFromHref().
 */
function externalIdFromHref(href: string): string | undefined {
  const m = /^\/missions\/([^/?#]+)/.exec(href);
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
 * Extracts raw listing data from the Mission Control board's DOM via
 * `page.$$eval` — mirrors gofractional.ts's scrapeCards() shape exactly (an
 * anchor-href selector, climbing to the nearest ancestor that looks like a
 * card container, pulling flat text fields off it) so the two adapters stay
 * structurally comparable, per this story's "pattern parity" acceptance
 * criterion. The selector/field assumptions themselves are unverified — see
 * file-level comment — but the EXTRACTION APPROACH follows the proven
 * pattern rather than inventing a new one.
 */
async function scrapeListings(page: Page): Promise<ATeamRawListing[]> {
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/missions/"]')].filter(
      (a) => !a.getAttribute("href")!.startsWith("/missions/board") && a.getAttribute("href") !== "/missions/",
    );

    return anchors.map((anchor) => {
      // Climb from the title anchor to the smallest ancestor whose text
      // includes both "hrs/week" and either "Remote"/"Hybrid"/"On-site" —
      // the assumed card container, same climbing approach as
      // gofractional.ts's scrapeCards() (no single stable data-testid/class
      // assumed, since none was ever confirmed live for A.Team).
      let card: Element = anchor;
      for (let i = 0; i < 12 && card.parentElement; i++) {
        card = card.parentElement;
        const t = card.textContent ?? "";
        if (t.includes("hrs/week") && /Remote|Hybrid|On-site/.test(t)) break;
      }

      const href = anchor.getAttribute("href")!;
      const title = (anchor.textContent ?? "").trim();
      const clientEl = card.querySelector("[data-testid='client-name'], .client-name");
      const client = clientEl ? (clientEl.textContent ?? "").trim() : null;
      const locationMatch = /(Remote|Hybrid|On-site)/.exec(card.textContent ?? "");
      const locationType = locationMatch ? locationMatch[1]! : null;
      const commitmentMatch = /(\d+(?:-\d+)?\s*hrs\/week)/.exec(card.textContent ?? "");
      const commitment = commitmentMatch ? commitmentMatch[1]! : null;

      return { href, title, client, locationType, commitment };
    });
  });
}

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
    const sessionStatePath = sessionStatePathFrom(cfg);

    const listings = await withBrowserSession(
      {
        sourceId: "ateam",
        storageStatePathSetting: sessionStatePath,
        allowedOrigins: [...ALLOWED_ORIGINS],
        url: MISSION_CONTROL_URL,
        isAuthenticated: isAuthenticatedATeam,
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
