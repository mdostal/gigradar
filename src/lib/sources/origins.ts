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
 * `MISSION_CONTROL_URL` (`https://platform.a.team/mission-control`), NOT a
 * separate "/login" guess. A.Team has no confirmed dedicated login route
 * anywhere in this project's research; the one thing actually
 * LIVE-CONFIRMED (`browser-session-auth`'s research brief §7) is that
 * navigating to Mission Control itself while unauthenticated redirects to
 * A.Team's real sign-in page (page title exactly "Sign In", body containing
 * both "Continue with Google" and "Continue with Github" — see `ateam.ts`'s
 * `isSignInPage()`). Reusing the one URL that has actually been observed to
 * work is more honest than inventing an unverified `/login` path on top of
 * an already-unverified board URL (see `ateam.ts`'s file-level comment on
 * `MISSION_CONTROL_URL` itself being best-guess, not live-confirmed).
 */
export const SOURCE_LOGIN_URLS: Record<string, string> = {
  gofractional: "https://www.gofractional.com/login",
  ateam: "https://platform.a.team/mission-control",
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
