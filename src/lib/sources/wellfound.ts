import type { Page } from "playwright";
import type { Source } from "./source.js";
import type { Gig, SourceConfig } from "../types.js";
import { registerSource } from "./source.js";
import { withBrowserSession } from "../auth/browser-session.js";
import { SOURCE_ORIGINS } from "./origins.js";

/**
 * Wellfound (wellfound.com, formerly AngelList Talent) — a client-rendered,
 * Google-OAuth-gated startup jobs board. `auth: "browser-session"`: the
 * third real consumer of `src/lib/auth/browser-session.ts` (see that module
 * and docs/ARCHITECTURE.md's "browser-session mechanism" section for the
 * shared mechanics — origin-scoping, headed-only launch, centralized
 * cleanup — all owned there, not duplicated here).
 *
 * EXTRACTION APPROACH IS GENUINELY NEW, NOT A REUSE OF gofractional.ts'S
 * DOM-EVAL HELPER (per this story's explicit design decision, confirmed by
 * a direct code read during epic planning — gofractional.ts's/ateam.ts's
 * `page.evaluate()` calls query flat, specific card/anchor CSS selectors;
 * Wellfound's own client-rendered page instead embeds its full page state as
 * one JSON blob in a `<script id="__NEXT_DATA__">` tag (confirmed live, see
 * below) — a fundamentally different shape needing a recursive walk of an
 * arbitrary-depth JSON tree, not a flat DOM query. Adapted (not copied) from
 * the legacy tool's own equivalent walk logic, read from its private
 * codebase during planning per this story's description.
 *
 * *** LIVE VERIFICATION — READ BEFORE TOUCHING THIS FILE ***
 *
 * What IS genuinely live-confirmed (fetched directly against the real site
 * while building this adapter, zero login/session involved):
 *   - `https://wellfound.com/login` returns a real, dedicated login page
 *     (HTTP 200, title exactly "Log In | Wellfound", body containing
 *     "Continue with Google" plus an email/password form) — this is the URL
 *     registered in `SOURCE_LOGIN_URLS` below, a real route, not a guess.
 *   - Wellfound's Next.js pages (confirmed on at least one real route) do
 *     embed a `<script id="__NEXT_DATA__" type="application/json"
 *     crossorigin="anonymous">` tag carrying the page's full JSON state —
 *     the mechanism this adapter's extraction logic depends on is real.
 *
 * What is a KNOWN, CONFIRMED PROBLEM, surfaced by this same live check and
 * flagged loudly rather than hidden: the two role-board URLs this story
 * (and the legacy tool it's ported from) specify —
 * `/role/l/chief-technology-officer` and `/role/l/vp-of-engineering` — both
 * return a genuine HTTP 404 today, with ZERO session/cookies involved (a
 * plain anonymous request). This isn't an auth-gating issue: re-checking
 * live against EIGHT different `/role/l/<slug>` paths (including these two)
 * all 404 identically, and a `/role/l/chief-technology-officer/` (trailing
 * slash) redirects right back to the same dead, extension-less path. The
 * entire `/role/l/<slug>` scheme this story's URLs assume appears to have
 * been retired in a site restructuring since the legacy tool was built —
 * `robots.txt` now instead disallows crawling `/*?role=*`, hinting the
 * live role-filter mechanism moved to a query-string shape on `/jobs`, not
 * a dedicated path per role. This adapter still targets the two URLs this
 * story explicitly specifies (its own design decision, not this file's to
 * unilaterally override with an unconfirmed guess at a replacement) — but a
 * real Capture Login + a fresh live check of the CURRENT correct board
 * URL(s) is a necessary follow-up before this source can produce real
 * output, tracked the same way as A.Team's own deferred-verification
 * follow-up in docs/ARCHITECTURE.md's roadmap.
 *
 * FIXTURE IS THEREFORE SYNTHETIC, NOT LIVE-CAPTURED — see
 * `src/lib/sources/__tests__/wellfound.test.ts`'s own header comment and
 * `fixtures/wellfound-next-data.json` for the explicit disclaimer. The
 * top-level `__NEXT_DATA__` envelope shape (`props.pageProps`, `page`,
 * `buildId`, `assetPrefix`, ...) mirrors a REAL envelope captured live from
 * the 404 page above (Next.js still renders one even for its own error
 * page); the job-listing objects nested inside `pageProps` are a
 * best-effort synthetic approximation of the legacy tool's own
 * title/slug-keyed shape, not recorded from a real board.
 *
 * Because the real listing shape was never observed, this adapter reads
 * ONLY `title`/`slug` (the walk's own match criterion) plus a small set of
 * plausible company-name/url sibling keys, opportunistically — never a
 * `rate`/`weeklyHours`/`postedAt` guess (this repo's no-fabricated-data
 * rule). `Gig.url` prefers an explicit url-like field on the matched node
 * when present, falling back to a constructed `/jobs/{slug}` permalink
 * otherwise — a structural assumption, not a confirmed real path.
 */

const ORIGIN_BASE = "https://wellfound.com";

/**
 * The two role-board URLs this story specifies (ported from the legacy
 * tool's own target URLs) — see the file-level comment above for this
 * story's live-verification finding that both currently 404. Kept exactly
 * as specified rather than swapped for an unconfirmed guess.
 */
const ROLE_URLS = [`${ORIGIN_BASE}/role/l/chief-technology-officer`, `${ORIGIN_BASE}/role/l/vp-of-engineering`] as const;

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

/** Defensive recursion-depth cap (runaway-loop guard only, same spirit as braintrust.ts's MAX_PAGES_PER_ROLE) — not expected to ever bind against a real `__NEXT_DATA__` tree. */
const MAX_WALK_DEPTH = 60;

/** Raw, already-flat data pulled out of one matched title/slug node — no HTML, no PII beyond public company/job-title text. */
interface WellfoundRawListing {
  title: string;
  slug: string;
  company: string | null;
  /** An explicit url-like field found directly on the matched node, if any — see toGig()'s fallback when this is null. */
  url: string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Returns the first argument that is a non-empty (post-trim) string, else null. Never fabricates — only reports what's actually present. */
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Opportunistic company-name extraction from a matched listing node's own
 * sibling keys — checks a small set of plausible flat-string keys first,
 * then a small set of plausible nested-object keys (each with its own
 * `name`/`companyName` string). Structure-derived, not live-confirmed (see
 * file-level comment) — returns null rather than guessing when none match.
 */
function extractCompanyName(node: Record<string, unknown>): string | null {
  const direct = firstNonEmptyString(node.companyName, node.company, node.startupName, node.employerName);
  if (direct) return direct;

  for (const key of ["company", "startup", "employer"]) {
    const nested = node[key];
    if (isPlainObject(nested)) {
      const name = firstNonEmptyString(nested.name, nested.companyName);
      if (name) return name;
    }
  }
  return null;
}

/** Opportunistic per-listing url extraction from a matched node's own sibling keys — see toGig()'s constructed fallback when this returns null. */
function extractUrl(node: Record<string, unknown>): string | null {
  return firstNonEmptyString(node.url, node.jobListingUrl, node.link, node.permalink, node.href);
}

/**
 * Recursively walks an arbitrary-depth JSON tree (Wellfound's parsed
 * `__NEXT_DATA__` payload) looking for every object that carries BOTH a
 * non-empty `title` and a non-empty `slug` string — the legacy tool's own
 * walk criterion for "this object IS a job listing", adapted (not
 * copied verbatim) here in this project's own style: a pure function with
 * no live DOM/Page dependency, so it's directly unit-testable against a
 * plain JSON fixture with zero mocking (see the test file).
 *
 * Deliberately keeps walking INTO a matched node's own children too (not
 * just its siblings) — a real state tree can plausibly nest one listing
 * inside another's "related jobs" field, and this story's "no relevance
 * pre-filtering, return every real listing found" rule means every
 * structural match counts, not just the first one found per branch.
 *
 * A structural match here is exactly that — structural. An unrelated object
 * that happens to carry both a `title` and a `slug` key (e.g. some other
 * entity type in the same state tree) would also match; this is the same
 * accepted risk class as this story's own "undocumented internal API
 * surface" risk, not a new one introduced here — see file-level comment.
 */
function findListings(node: unknown, depth = 0, out: WellfoundRawListing[] = []): WellfoundRawListing[] {
  if (depth > MAX_WALK_DEPTH || node === null || typeof node !== "object") return out;

  if (Array.isArray(node)) {
    for (const item of node) findListings(item, depth + 1, out);
    return out;
  }

  const obj = node as Record<string, unknown>;
  const title = firstNonEmptyString(obj.title);
  const slug = firstNonEmptyString(obj.slug);
  if (title && slug) {
    out.push({ title, slug, company: extractCompanyName(obj), url: extractUrl(obj) });
  }

  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object") findListings(value, depth + 1, out);
  }

  return out;
}

function toGig(listing: WellfoundRawListing): Gig {
  const url = listing.url
    ? listing.url.startsWith("http")
      ? listing.url
      : `${ORIGIN_BASE}${listing.url.startsWith("/") ? "" : "/"}${listing.url}`
    : // No explicit url-like field on the matched node — construct the
      // real per-listing permalink shape from the slug (structural
      // assumption, not live-confirmed — see file-level comment).
      `${ORIGIN_BASE}/jobs/${listing.slug}`;

  return {
    sourceId: "wellfound",
    externalId: listing.slug,
    title: listing.title,
    company: listing.company ?? undefined,
    url,
    // rate/weeklyHours/remote/postedAt deliberately omitted (left
    // unset/unknown) — the real listing shape was never live-observed (see
    // file-level comment), and this repo's no-fabricated-data rule means
    // this adapter only reports fields it actually, structurally found.
    raw: listing,
  };
}

const NEXT_DATA_SELECTOR = "script#__NEXT_DATA__";

/**
 * Reads and parses the page's `<script id="__NEXT_DATA__">` tag — the real,
 * live-confirmed mechanism Wellfound's Next.js pages use to embed full page
 * state as JSON (see file-level comment). Throws a specific, actionable
 * error naming the source on EVERY page-shape failure: the tag missing
 * entirely (Playwright's `page.$eval` rejects when no element matches —
 * caught and re-thrown as this adapter's own error rather than a raw,
 * confusing Playwright message), present but empty, or present but not
 * valid JSON.
 */
async function extractNextData(page: Page): Promise<unknown> {
  let raw: string | null;
  try {
    raw = await page.$eval(NEXT_DATA_SELECTOR, (el) => el.textContent);
  } catch {
    throw new Error(
      `wellfound: no __NEXT_DATA__ script tag found on the page — unexpected page shape (the client-rendered JSON payload this adapter depends on may have moved or changed)`,
    );
  }
  if (!raw || raw.trim().length === 0) {
    throw new Error(`wellfound: __NEXT_DATA__ script tag was present but empty — unexpected page shape`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`wellfound: __NEXT_DATA__ script tag content is not valid JSON — unexpected page shape`);
  }
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

async function isAuthenticatedWellfound(page: Page): Promise<boolean> {
  return !(await isSignInPage(page));
}

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

async function fetchRoleUrl(url: string, sessionStatePath: string): Promise<WellfoundRawListing[]> {
  return withBrowserSession(
    {
      sourceId: "wellfound",
      storageStatePathSetting: sessionStatePath,
      allowedOrigins: [...ALLOWED_ORIGINS],
      url,
      isAuthenticated: isAuthenticatedWellfound,
    },
    async (page) => {
      const nextData = await extractNextData(page);
      return findListings(nextData);
    },
  );
}

export const wellfoundSource: Source = {
  id: "wellfound",
  label: "Wellfound",
  auth: "browser-session",
  async fetch(cfg: SourceConfig): Promise<Gig[]> {
    const sessionStatePath = sessionStatePathFrom(cfg);

    // Both role-board URLs are fetched via their own withBrowserSession()
    // call (a fresh headed Chromium launch each), per this story's
    // "withBrowserSession() against BOTH ... and ..." description — never
    // one call reused for two navigations. Deduped by slug across both
    // pages (a listing plausibly shown under more than one role), same
    // pattern as braintrust.ts's dedup-across-role-ids.
    const bySlug = new Map<string, WellfoundRawListing>();
    for (const url of ROLE_URLS) {
      const listings = await fetchRoleUrl(url, sessionStatePath);
      for (const l of listings) bySlug.set(l.slug, l);
    }

    // isAuthenticatedWellfound() above already ruled out the auth-failure
    // case for each page (withBrowserSession throws before that page's
    // listings are ever collected) — zero listings across BOTH pages
    // despite auth succeeding on both means the __NEXT_DATA__ shape this
    // adapter's walk expects has changed (or the specific board URLs are
    // broken — see file-level comment), not a confirmed legitimate empty
    // board. Throw rather than silently returning [] — this repo's
    // no-silent-zero rule, same convention as gofractional.ts/ateam.ts.
    if (bySlug.size === 0) {
      throw new Error(
        `wellfound: found 0 listings across ${ROLE_URLS.length} role page(s) (${ROLE_URLS.join(", ")}) — the __NEXT_DATA__ shape this adapter expects may have changed`,
      );
    }

    return [...bySlug.values()].map(toGig);
  },
};

registerSource(wellfoundSource);
