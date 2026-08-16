# Vertical plan: verification-copilot

Two slices. Slice 1 alone already delivers real value (the owner can SEE
a verification block distinctly in `/issues` instead of a generic fetch
error). Slice 2 adds the actual co-pilot action.

## Slice 1 — Detection + distinct issue routing

- `src/lib/sources/verification-challenge.ts` (new):
  `isVerificationChallengeContent(text)`, `VerificationChallengeError`.
- `browser-session.ts`'s `withBrowserSession()`: detect-and-throw wired
  in once, after navigation, before the caller's `isAuthenticated` check.
- `runner.ts`/scheduler's error-to-issue path: `instanceof
  VerificationChallengeError` → `title: "Needs human verification"`,
  distinct from the generic `"Source fetch failed"`.

**Working state:** a real (or mocked-in-test) Cloudflare-style block on
any `browser-session`-auth source shows up in `/issues` as a clearly
distinct, higher-signal issue instead of a generic fetch failure.

## Slice 2 — The co-pilot browser action

- `src/lib/auth/verification-copilot-session.ts` (new): globalThis-pinned
  map, `openCopilotSession(sourceId, url)` (spawnRealChrome + attach +
  load-and-scope the source's storageState + navigate), `getCopilotPage`,
  `closeCopilotSession`.
- `/issues` (`issues-client.tsx`): a "Needs human verification" issue
  (matched by title/context, not string-parsed from `message`) gets an
  "Open browser to help clear it" button + Server Action, and (once open)
  a "Check if it looks cleared" button reusing `checkCaptureReadiness()`
  + a "Done" button that closes the session and resolves the issue via
  the existing `resolveIssue()`.

**Working state:** epic complete — a blocked source is a distinct,
actionable issue with a real, human-drivable way to go clear it, without
digging through terminal logs.
