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
export const KNOWN_SOURCES: readonly { id: string; label: string }[] = [
  { id: "braintrust", label: "Braintrust" },
  { id: "builtin", label: "BuiltIn" },
  { id: "gofractional", label: "GoFractional" },
  { id: "ateam", label: "A.Team" },
];
