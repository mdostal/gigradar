# Design Discussion: product-review-followups

## 0. Prelude

Owner's own consolidated brain-dump from a live product-review session
(2026-08-30), covering 6 distinct areas. This is a roadmap-level design
discussion, not 6 full documents — each area gets its own lean epic/story
set, planned just-in-time right before it's executed, not all six planned
in exhaustive detail up front. Execution proceeds as a loop across turns:
do the next area, ship it, verify it live where practical, move to the
next.

## 1. The six areas, owner's own words, and sequencing

**A. Two scraper bugs (fast, do first, unblocks F).** Both live-verified
this session (see prior conversation turns, not re-derived here):
- gun-io: `custom-llm-source.ts`'s `page.goto(url)` has no `waitUntil`,
  and the recipe-derivation step reads `page.content()` immediately after
  with no wait for the SPA to render. Confirmed: same session, same URL,
  bare fetch got "only `<head>`"; a 3s wait got the real 25KB page with
  real listings.
- ateam: the captured session goes stale within minutes of a fresh
  "Capture login" — confirmed live, a direct navigation using the
  just-captured session redirected straight to `/sign-in`. Separately,
  the adapter's own header comment admits its listing selectors were
  never live-verified. Sequencing: fix/understand the session-lifetime
  issue BEFORE attempting a selector rewrite (can't verify selectors
  against a session that dies in minutes).

**B. Real-time UX gaps (fast, independent).**
- "opening the browser for side by side help and stuff makes sense, but
  we should have a notification for that" — Capture Login and
  verification-copilot both open a real visible browser with zero
  notification that it happened. Reuse `src/lib/notify/desktop.ts`'s
  existing `sendDesktopNotification()` — do not invent a second path.
- "the preferences for sorting and filtering aren't in place" —
  confirmed: `dashboard-client.tsx`'s `sorting`/`columnFilters` are plain
  `useState`, reset on every reload. Persist to `localStorage`.

**C. Gmail OAuth reuse via Portunus.** "the gmail oauth SHOULD be able to
be re-used across the board" / "the oauth with google needs to be saved
with portunus and re-used and that should be an easy option to just
assign it." Today's flow (`config/actions.ts`'s
`startGmailOAuthAction`/`disconnectGmailAction`) is per-source. Wants: one
Google auth, stored in Portunus, "assign this" affordance wherever Google
auth is needed.

**D. Setup wizard.** "Feed in my local resume and all of my data...
let's walk through the setup (put an easy profile and wizard together for
setup and changing preferences and nailing out the gigs we are aiming
for)." Guided flow: resume ingestion (reuse existing
`profile-ingestion/extract.ts`) → Profile → Needs (walk the
hourly/fractional/full-time tiers explicitly) → roleArea → sources → done.
Re-enterable later, not just first-run.

**E. Dashboard redesign — the deferred "big RE-DESIGN effort" (largest,
sequence last).** "we have to build all of that... messy dashboard and
single table... clean process with gigs to apply, once we apply we can
see the applied, the interviewing and packets etc." Concrete asks: row-by-
row job detail browsing (not just a flat table), first-class pipeline
views (gigs-to-apply / applied / interviewing / archived — check
`GigStatus`'s real values first), prep packets visible from within
applied/interviewing rows, and a Settings toggle for manual-vs-automated
"research" (clarify exactly what this means — prep packet generation?
draft generation? — during that epic's own research step). References
"the command center and... mdostal.com" as prior art to look for before
finalizing IA.

**F. Status reconciliation from platforms (already queued in project
memory, depends on A).** Once ateam/gofractional/gun-io have durably live
sessions, auto-sync local gig status from real platform history. Gated on
A's session-lifetime fix landing — a session that dies in minutes can't
reliably scrape "my applications" either.

## 2. Sequencing this roadmap actually follows

A → (unblocks) → F. B and C are independent, low-risk, done opportunistically.
D and E share IA decisions — D first where it informs E, but each ships
independently. This roadmap doc is the durable reference; each area gets
its own `.pHive/epics/<area>/` when its turn comes, planned immediately
before execution, not all up front.

## 3. Scale

Large overall (multi-system, spans backend adapters, auth/secrets, a new
guided-setup surface, and a full dashboard IA redesign) — but composed of
independently-shippable, mostly-Small-to-Medium slices. Treating the whole
thing as one flat story list would be worse than sequencing real,
separately-verified epics. Proceeding area-by-area starting with A.
