/**
 * Shared per-source origin allowlist registry. Both the browser-session
 * adapters (gofractional.ts, ateam.ts) and the session-capture mechanism /
 * capture UI (see docs/ARCHITECTURE.md) read from this single source of
 * truth instead of each hardcoding their own copy of an adapter's allowed
 * origins — avoids the two ever silently drifting apart.
 *
 * Keys are each source's registered `Source.id` (see source.ts). Values are
 * extracted byte-identical from the inline `ALLOWED_ORIGINS` constants that
 * previously lived directly in gofractional.ts/ateam.ts — same domains, same
 * order, same casing, no correction. See those files' own comments for why
 * each specific origin is listed (subdomain-matching coverage, explicit
 * documentation of real origins actually needed, etc.) — this registry is
 * deliberately just the data, not a place to re-derive that reasoning.
 *
 * See browser-session.ts's domainMatchesAllowlist() for the exact-or-
 * subdomain matching each list is filtered through before any cookie
 * reaches a browser context.
 */
import type { SourceConfig } from "../types.js";

export const SOURCE_ORIGINS: Record<string, readonly string[]> = {
  gofractional: ["gofractional.com"],
  ateam: ["a.team", "platform.a.team"],
  // adapter-batch-public-boards epic, wellfound-adapter story: wellfound.com
  // ONLY, never Google/Clerk SSO or any other origin a broader multi-site
  // storageState file might also carry — see wellfound.ts's own
  // ALLOWED_ORIGINS comment.
  wellfound: ["wellfound.com"],
};

/**
 * Per-source LOGIN URL — where `startCapture()` (`src/lib/auth/session-capture.ts`)
 * navigates a fresh headed Chromium window so the user can log in. Kept
 * alongside `SOURCE_ORIGINS` (same "single source of truth, keyed by
 * `Source.id`" shape) rather than a separate file: both maps describe the
 * same set of browser-session-auth sources and are read together by the
 * capture UI (`src/app/config/config-client.tsx` only shows a "Capture
 * login" button for a source id present in `SOURCE_ORIGINS`; the matching
 * entry here is what that button's Server Action navigates to).
 *
 * `gofractional`: `https://www.gofractional.com/login` — GoFractional's own
 * dedicated login route. `gofractional.ts` itself never navigates there (it
 * only ever visits the public `/jobs` list — see that file's header
 * comment), so this isn't literally re-used from that adapter; it's re-used
 * from `session-capture-mechanism`'s own test fixture
 * (`src/lib/auth/__tests__/session-capture.test.ts`'s `LOGIN_URL` constant)
 * rather than introduced as a second, possibly-conflicting guess for the
 * same source.
 *
 * `ateam`: deliberately the SAME URL as `ateam.ts`'s own
 * `MISSION_CONTROL_URL` (`https://platform.a.team/mission-control/all`,
 * live-verified 2026-08-30 — see that constant's own doc comment), NOT a
 * separate "/login" guess. A.Team has no dedicated login route; navigating
 * to a Mission Control URL while unauthenticated redirects to A.Team's real
 * sign-in page (page title exactly "Sign In", body containing both
 * "Continue with Google" and "Continue with Github" — see `ateam.ts`'s
 * `isSignInPage()`), which is what Capture Login actually needs. Reusing
 * the one URL this adapter itself navigates to for scraping is more honest
 * than inventing a second, possibly-diverging guess.
 */
export const SOURCE_LOGIN_URLS: Record<string, string> = {
  gofractional: "https://www.gofractional.com/login",
  ateam: "https://platform.a.team/mission-control/all",
  // `wellfound`: `https://wellfound.com/login` — Wellfound's own real,
  // dedicated login route (LIVE-CONFIRMED while building wellfound.ts, not a
  // guess: HTTP 200, page title exactly "Log In | Wellfound", body content
  // includes "Continue with Google" plus an email/password form — a
  // standard OAuth-provider-select page). See wellfound.ts's own
  // isSignInPage() for the same live-observed title/body content reused as
  // this adapter's auth-failure signal.
  wellfound: "https://wellfound.com/login",
};

/**
 * Per-source PROFILE-EDIT URL — where `profile-assist` (`assist-session.ts`)
 * navigates a persistent session so the owner can be helped filling out
 * their profile. UNLIKE `SOURCE_LOGIN_URLS` above, **none of these three
 * entries are live-confirmed** as of this epic's first story — flagged
 * loudly here rather than silently treated as fact, same posture
 * `wellfound.ts`'s own `ROLE_URLS` already uses for exactly this situation
 * (a real gap, shipped anyway, not hidden):
 *
 * `gofractional`: `/talent/profile` is a REAL, server-recognized route
 * pattern (live-confirmed during this epic's planning: navigating there
 * with the project's own stored session returns a `/explore?notice=
 * member-not-found` redirect — a specific, meaningful signal, not a generic
 * 404/fallback) but the specific stored session tested against isn't tied
 * to an onboarded talent profile, so the URL itself is unverified past that
 * one signal.
 *
 * `ateam`: pure best-guess (`/profile`, A.Team's own general URL
 * convention) — the project's stored A.Team session was confirmed EXPIRED
 * (redirects to `/sign-in`) during this epic's planning, so nothing at all
 * could be live-checked.
 *
 * `wellfound`: pure best-guess (`/profile/edit`, a common convention for
 * this kind of page) — no captured Wellfound session exists at all yet
 * (see docs/ARCHITECTURE.md's own standing Wellfound follow-up).
 *
 * **Standing follow-up, owned by the project owner, not tracked as a
 * story** (same posture as the A.Team/Wellfound follow-ups already in
 * docs/ARCHITECTURE.md): re-authenticate each source with a real onboarded
 * account and confirm/correct these three URLs live before trusting
 * profile-assist's Full-auto mode against them unsupervised.
 */
export const SOURCE_PROFILE_URLS: Record<string, string> = {
  gofractional: "https://www.gofractional.com/talent/profile",
  ateam: "https://platform.a.team/profile",
  wellfound: "https://wellfound.com/profile/edit",
};

/**
 * Every registered Source's `id`/`label`, kept as plain data here (not
 * imported from the adapter files themselves) so a CLIENT component
 * (`config-client.tsx`) can render a picker without pulling in server-only
 * adapter code (playwright, fs, etc.) into the browser bundle. Source of
 * truth for the actual ids is each adapter's own `id`/`label` fields
 * (braintrust.ts, builtin.ts, gofractional.ts, ateam.ts) — kept in sync by
 * hand, same convention as SOURCE_ORIGINS/SOURCE_LOGIN_URLS above.
 *
 * Exists because a freeform "Source id" text field let a user type an
 * id that doesn't match any registered source (e.g. "gofractional.com"
 * instead of "gofractional") with no error and no "Capture login" button —
 * a silent, hard-to-diagnose mismatch. A picker makes that typo impossible.
 */
// `auth` mirrors each adapter's own real `Source.auth` field byte-for-byte
// (see the grep-verified list this constant was built from: braintrust.ts,
// builtin.ts, gofractional.ts, ateam.ts, fractionaljobs.ts, fractionus.ts,
// fractionalfinders.ts, wellfound.ts) so the config UI's Settings editor
// can show a hint that matches what a source ACTUALLY needs, instead of a
// one-size-fits-all API-key placeholder that's misleading for the
// `"none"`-auth sources (see config-client.tsx's SettingsEditor).
export const KNOWN_SOURCES: readonly { id: string; label: string; auth: "none" | "api-key" | "browser-session" }[] = [
  { id: "braintrust", label: "Braintrust", auth: "none" },
  { id: "builtin", label: "BuiltIn", auth: "none" },
  { id: "gofractional", label: "GoFractional", auth: "browser-session" },
  { id: "ateam", label: "A.Team", auth: "browser-session" },
  // adapter-batch-public-boards epic, public-fetch-adapters story: three
  // new auth:"none" fetch-based boards (src/lib/sources/fractionaljobs.ts,
  // fractionus.ts, fractionalfinders.ts).
  { id: "fractionaljobs", label: "FractionalJobs", auth: "none" },
  { id: "fractionus", label: "Fractionus", auth: "none" },
  { id: "fractionalfinders", label: "FractionalFinders", auth: "none" },
  // adapter-batch-public-boards epic, wellfound-adapter story:
  // src/lib/sources/wellfound.ts, auth:"browser-session".
  { id: "wellfound", label: "Wellfound", auth: "browser-session" },
  // linkedin-adapter story: src/lib/sources/linkedin.ts. Confirmed live
  // (both via a real headed session AND a bare curl/fetch with zero cookies)
  // that LinkedIn's public "guest" job search page is fully server-rendered
  // and requires no authentication at all — auth:"none", same as
  // builtin.ts/braintrust.ts.
  { id: "linkedin", label: "LinkedIn", auth: "none" },
];

/**
 * llm-custom-sources epic, custom-source-auth story: the SAME class of
 * problem as runner.ts's `getSource(sc.id) ?? customLlmSource` fallback
 * (custom-source-core-mechanism story) — `SOURCE_ORIGINS`/
 * `SOURCE_LOGIN_URLS` are static registries keyed by known adapter ids, and
 * a custom source's owner-typed id is never in them. Static registry first
 * (every existing browser-session-auth source is found here, unchanged),
 * config-driven fallback second (`cfg.settings.allowedOrigins`) —
 * deliberately the identical shape, not a second invented pattern.
 *
 * Returns `undefined` (never throws) when neither the registry nor the
 * config has an answer — callers already have their own specific
 * "no origin allowlist registered" error for that case.
 */
export function resolveAllowedOrigins(sourceId: string, cfg: SourceConfig): string[] | undefined {
  const fromRegistry = SOURCE_ORIGINS[sourceId];
  if (fromRegistry) return [...fromRegistry];

  const configured = cfg.settings?.allowedOrigins;
  if (Array.isArray(configured) && configured.length > 0 && configured.every((o) => typeof o === "string")) {
    return configured;
  }
  return undefined;
}

/** Same config-driven fallback shape as resolveAllowedOrigins() above, for the login URL Capture Login navigates to. */
export function resolveLoginUrl(sourceId: string, cfg: SourceConfig): string | undefined {
  const fromRegistry = SOURCE_LOGIN_URLS[sourceId];
  if (fromRegistry) return fromRegistry;

  const configured = cfg.settings?.loginUrl;
  return typeof configured === "string" && configured.length > 0 ? configured : undefined;
}

/**
 * oauth-session-capture-v2 epic, google-sso-session-persistence story. A
 * Google-only allowlist, DELIBERATELY separate from `SOURCE_ORIGINS` above
 * (never merged into it, never keyed by a real `Source.id`) -- Google is
 * not a job source, it's a shared IDENTITY every SSO-gated source's own
 * "Continue with Google" button redirects through. Capturing a session
 * scoped to ONLY these two origins is what makes it safe to later inject
 * into a fresh per-source capture without ever leaking a target source's
 * own cookies into it, or vice versa.
 */
export const GOOGLE_SSO_ORIGINS: readonly string[] = ["accounts.google.com", "google.com"];

/** Where a Google-scoped Capture Login navigates -- Google's own real sign-in entry point, never a target source's login page. */
export const GOOGLE_SSO_LOGIN_URL = "https://accounts.google.com/";

/**
 * Every registered source LIVE-CONFIRMED (via that adapter's own
 * isSignInPage()/isAuthenticatedX() comment, not guessed) to offer
 * "Continue with Google" on its real login page -- see ateam.ts's
 * isSignInPage() (confirms "Continue with Google" AND "Continue with
 * Github") and wellfound.ts's isSignInPage() (confirms "Continue with
 * Google" alongside an email/password form). `gofractional` is
 * deliberately NOT listed here -- its own file only defensively EXCLUDES
 * Google/Clerk SSO from its allowlist, it never confirms Google is one of
 * its actual sign-in options; listing it would be a guess, not a finding.
 */
export const SOURCES_OFFERING_GOOGLE_SSO: readonly string[] = ["ateam", "wellfound"];

/**
 * Same config-driven fallback shape as resolveLoginUrl() above, for the
 * profile-edit URL profile-assist navigates a persistent session to.
 * SOURCE_PROFILE_URLS only covers the 3 hand-written browser-session
 * adapters; a custom-llm source (e.g. a Catalant/Indeed preset) has no
 * registry entry, so without this fallback profile-assist could never
 * offer it -- same "static registry first, settings.* second" shape
 * resolveAllowedOrigins()/resolveLoginUrl() already established.
 */
export function resolveProfileUrl(sourceId: string, cfg: SourceConfig): string | undefined {
  const fromRegistry = SOURCE_PROFILE_URLS[sourceId];
  if (fromRegistry) return fromRegistry;

  const configured = cfg.settings?.profileUrl;
  return typeof configured === "string" && configured.length > 0 ? configured : undefined;
}
