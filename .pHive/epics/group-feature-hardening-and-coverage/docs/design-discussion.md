# Design Discussion: group-feature-hardening-and-coverage

## Trigger

Owner report, live: "okay, we crashed, we have the new version, i don't see
things for the groups -- go through, do a deep dive testing and verification
pass, ensure full test coverage -- plan a full test suite and ensure we've
covered everything then execute and loop through this tonight until fully
done."

## Investigation performed before writing this doc

Real, curl-only checks against the actual running v0.34.0 packaged app
(127.0.0.1:3000, PID 94834 + sidecar 95001):

- No crash report in `~/Library/Logs/DiagnosticReports` in the last 2 days.
- `/config`, `/config/groups`, `/gigs`, `/`, `/full-time`, `/fractional-hourly`
  all return 200.
- The real server-rendered HTML for `/gigs` shows the nav pill row exactly as
  designed: `Groups: All Groups | Fractional / Hourly | Full-Time`, correct
  `href`s.
- The real Config Dashboard's "Groups & Needs" card shows both groups' real
  rate ranges (`$150-285/hr / $90-200/hr · AI-verify on`, `$250k-$400k TC ·
  AI-verify on`).
- The owner's actual live `~/.local/share/gigradar/config.json` was read
  (read-only, via `readRawConfig()` — never `loadConfig()`'s resolved
  secrets) and validated against `ConfigSchema.safeParse()`: it parses
  successfully, with both groups (`fractional-hourly`, `full-time`) intact,
  both `aiVerify: true`. No data corruption.

**Conclusion: the specific symptom does not reproduce via SSR/curl right
now.** That rules out server-side data corruption and rules out the
`blankConfig()` fallback path (which fires when `ConfigSchema.safeParse()`
fails and would visibly collapse the owner's 2 real groups down to a single
placeholder "Default Search 1" group — exactly the kind of thing "i don't see
things for the groups" would describe, and it is NOT what's happening).

That said, curl only proves what the SERVER renders. It cannot prove
anything about client-side hydration or a runtime exception thrown inside a
mounted React component in the actual Tauri webview — the one thing this
session's standing curl-only-verification rule structurally cannot observe
directly (no real browser, no Playwright). So the honest position is: the
one-time symptom did not leave a reproducible server-side trace, but a real,
independently-worth-fixing gap sits directly upstream of it — see below.

## Two real, confirmed gaps found during this investigation

1. **Zero test coverage on `src/app/config/config-sections.ts`.** This is the
   exact file that computes every Config Dashboard card's content —
   `formatRateRange()`, `groupRateSummary()`, and all 6 sections' `details()`
   /`status()` functions. It already had one real, shipped bug this session
   (the duplicate-React-key issue caught in the PR #137 grill pass) — a file
   with zero tests and a track record of one real bug in its first week is
   exactly where "ensure full test coverage" should point first. Also zero
   coverage on `src/app/config/config-data.ts` (`loadConfigPageData`,
   `blankConfig`) — the loader that decides whether the owner sees their real
   groups or the single-group placeholder fallback.

2. **No error boundary anywhere in the app.** `find src/app -iname
   "error.tsx" -o -iname "global-error.tsx"` returns nothing. Next.js's App
   Router convention is that an uncaught render-time exception in any
   component propagates up to the nearest `error.tsx` (or, if none exists
   anywhere in the tree, to Next's own unstyled default error screen /
   effectively a blank page in a webview with no dev overlay). Concretely:
   if any of the Config Dashboard's `details()` calls throws on a config
   shape it doesn't expect, the ENTIRE page goes blank instead of degrading
   gracefully — which would look and feel exactly like "we crashed... i
   don't see things for the groups" to someone looking at the packaged app.
   This is real, independently worth fixing regardless of whether it's what
   actually happened last night, and it's the one class of failure SSR curl
   checks structurally cannot rule out.

## Scope for this epic

1. `config-sections-test-coverage` — real unit tests for every function in
   `config-sections.ts`, covering the shapes that matter: multiple groups
   sharing a label (the exact case that caused the duplicate-key bug),
   hourly vs. salaried rate formatting, missing optional Profile fields,
   sources with mixed/absent `sessionReadiness`, describable vs.
   non-describable cron schedules, every kill-switch/rules-armed
   combination.
2. `config-data-test-coverage` — real tests for `loadConfigPageData()` and
   `blankConfig()`, using the exact same isolated-`XDG_DATA_HOME` +
   `saveConfig()` pattern already established in
   `src/app/__tests__/dashboard-data.test.ts` — including the
   invalid-config-falls-back-to-`blankConfig()` path, since that's the
   literal mechanism that would produce a "groups disappeared" symptom.
3. `app-error-boundaries` — add a root `global-error.tsx` and route-segment
   `error.tsx` files for `/config` and `/gigs` (and `/[group]`), so a real
   render exception shows a recoverable "Something went wrong" screen with a
   reset button instead of a blank page. This is the concrete fix for the
   one class of failure this session's curl-only verification cannot itself
   rule out.

## Open questions

None — this is a self-contained hardening + coverage pass, not a
requirements-ambiguous feature. No `new-tier-ranking-buckets`-style owner
decision is needed here.

## Scale

Small-to-medium: 3 independently shippable, mechanically verifiable stories,
no cross-story dependencies. No H/V planning ceremony needed at this size —
matches every prior epic this session.
