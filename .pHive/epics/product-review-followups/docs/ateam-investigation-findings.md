# A.Team session/selector investigation — findings, not a fix (2026-08-30)

> **RESOLVED 2026-08-31 — see `fix/ateam-session-capture-and-selectors`
> (merged to `dev`).** The "working theory" below (a failing client-side
> refresh-token exchange) turned out not to be the actual blocker: a live
> session captured via a real interactive Google login and immediately
> replayed authenticated cleanly, reached real Mission Control content,
> and — once the selectors below were fixed against real DOM (see that
> PR) — scraped 51 real gigs end-to-end via the actual production
> `ateamSource.fetch()` path. The real, separate bug this doc's
> investigation never isolated: `scrapeListings()`'s selectors were
> guessed against a wrong URL pattern (`/missions/{slug}` instead of the
> real `/mission/{id}`) and read the DOM before the SPA's async card
> render finished — not a session/auth problem at all. What's still
> genuinely open (a NEW story, not this one): Google's own sign-in state
> doesn't survive between two SEPARATE Capture Login attempts on the same
> machine, even with a persistent Chrome profile — tracked at
> `.pHive/epics/oauth-session-capture-v2/stories/
> google-sso-session-persistence.yaml`.

## What's confirmed, live-verified

1. **The captured session's auth cookies are NOT short-lived.** Read via
   the app's own `readStorageStateFile()` (properly decrypted, not a raw
   JSON parse — an earlier pass in this same investigation misread the
   raw encrypted envelope and wrongly concluded "0 cookies"; corrected
   here). The real cookie set: `refreshToken` and `hasSession` both had
   ~14 days (20,140+ minutes) left. This rules out "the cookies just
   expire in minutes" as the explanation for the sign-in redirect
   observed earlier this session.

2. **`localStorage` for `platform.a.team` has zero auth-related keys.**
   Only three keys captured: `li_adsId`, `hjActiveViewportIds`,
   `_hjUserAttributes` — all Hotjar/LinkedIn-ads analytics trackers, no
   access token, session token, or anything auth-shaped.

3. **Yet navigating to `/mission-control` with this exact session
   redirects straight to `/sign-in`** (confirmed via `withBrowserSession()`
   directly, the app's own real mechanism, not a reproduction of the bug
   in a different tool).

## Working theory (not yet confirmed)

A.Team's client almost certainly uses the classic
refresh-token-cookie + short-lived-access-token-in-memory-or-localStorage
pattern: on a real interactive page load, client-side JS reads
`refreshToken`, calls an API to exchange it for a real access token, and
only THEN renders the authenticated app. Replaying just the captured
cookies via Playwright's `storageState` may not trigger that exchange the
same way a real browser session does — or it does trigger and the
exchange itself is failing for a reason specific to non-interactive replay
(a fetch-credentials nuance, a required header Playwright's storageState
injection doesn't set, a same-site/CORS wrinkle, etc.).

## Why this isn't fixed yet

This needs live network-level observation (watching the actual
refresh-token-exchange request/response fire, or fail to fire, during a
real replayed session) to confirm — not something resolvable through more
read-only session inspection. It also means the earlier plan ("fix
session lifetime first, then rewrite selectors against a session
confirmed still valid") needs revising: the session ISN'T short-lived,
it's failing to actually authenticate the replay for a different reason.

## Next step when this is picked back up

1. Do a fresh Capture Login for ateam.
2. Immediately (same session, no delay) replay it via `withBrowserSession()`
   with Playwright's own request/response logging turned on
   (`page.on("request"/"response")`) watching specifically for a
   refresh-token-exchange call, to see whether it fires at all and what it
   returns.
3. Only after that's understood does the selector rewrite (ateam.ts's own
   header comment already admits those were never live-verified) become
   possible to actually verify against a real, working, authenticated
   session.

This file exists so the next pass doesn't have to re-derive any of the
above from scratch.
