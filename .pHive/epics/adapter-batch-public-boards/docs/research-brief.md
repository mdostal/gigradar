# Research Brief: adapter-batch-public-boards

## 1. Summary

Four platforms from the owner's real pipeline table, sourced from the
legacy tool's `sources.mjs` (structural scraping code, read directly off
the hive — no credential files touched) plus live verification against the
real sites just now: **FractionalJobs**, **Fractionus**, **FractionalFinders**
are server-rendered public boards — a live `fetch()` returns full job data
in the raw HTML, no Playwright needed, matching the `builtin.ts` adapter's
existing pattern exactly, not the legacy tool's heavier Playwright-cli
approach. **Wellfound** requires an authenticated session (Google OAuth) —
matches the existing `gofractional.ts`/`ateam.ts` `browser-session`
pattern. **Ladders**, the fifth platform in this batch's original scope,
is dropped — see §4.

## 2. Live verification (this research, not assumed)

- `curl -A "Mozilla/5.0" https://www.fractionaljobs.io/` → HTTP 200,
  63 real `/jobs/<slug>` links present in the raw HTML.
- `curl -A "Mozilla/5.0" https://fractionus.com/jobs` → HTTP 200, 53 real
  `/jobs/<slug>` links present in the raw HTML.
- `curl -A "Mozilla/5.0" https://www.fractionalfinders.com/jobs` → HTTP
  200, 16 real `/jobs/<slug>` links present in the raw HTML.
- `curl -A "Mozilla/5.0" https://www.theladders.com/jobs/technology-jobs`
  → **HTTP 403** — actively bot-blocked, not just client-rendered. The
  legacy tool's Playwright-based approach worked around this with a real
  headed browser; this research treats an active 403 as a materially
  different, stronger signal than a client-rendering requirement.
- `robots.txt` for all three fetch-compatible hosts: no `Disallow` rules
  found (fractionaljobs.io and fractionus.com only publish a `Sitemap:`
  line; fractionalfinders.com's is empty) — same ethical-scraping check
  `builtin.ts`'s own header comment establishes as this project's
  convention.

## 3. Key files & reference logic

- `src/lib/sources/builtin.ts` — the exact pattern to follow for the 3
  fetch-compatible boards: `auth:"none"`, plain `fetch()`, regex-over-HTML
  parsing (no HTML-parsing dependency in this repo), throw on an
  unrecognized shape rather than silently returning `[]`.
- `src/lib/sources/gofractional.ts` / `ateam.ts` — the pattern for
  Wellfound: `auth:"browser-session"`, `withBrowserSession()`,
  `settings.sessionStatePath`, origin-scoped via `src/lib/sources/origins.ts`.
- The legacy tool's `sources.mjs` (structural code, read from its private
  codebase): `fetchFractionalJobs`/`fetchFractionus`/`fetchFractionalFinders`/
  `fetchWellfound` — real, working slug-parsing and title/company
  extraction logic to adapt (URL patterns, regex shapes), not verbatim-copy
  (different runtime: playwright-cli named sessions vs. this project's own
  `fetch()`/`withBrowserSession()`).
- Each legacy function marks its output `_flagOnly: true` (no reliable
  rate/hours data on these boards, so never auto-apply-eligible) — this
  concept doesn't need porting: gigradar's `Gig.rate`/`weeklyHours` are
  already optional (`undefined` = unknown, never fabricated, per
  `docs/ARCHITECTURE.md`'s rule 5), and INTERACT is unconditionally
  human-approved already (no separate flag needed).
- Wellfound's legacy fetch reuses the "gf" (GoFractional) session via
  Google SSO cookies already present in that browser profile — this
  project's own convention is one dedicated session file per source
  (`<sourceId>-session.json`), so Wellfound gets its OWN Capture Login
  entry, not a reused GoFractional session (better isolation; consistent
  with every other source in this codebase).

## 4. Constraints / scope cut

- **Ladders dropped from this batch.** Actively bot-blocked (HTTP 403 to
  a plain, realistic browser `User-Agent`), and the owner's own platform
  table already ranks it P3 ("Full-time, premium-locked; low value for
  fractional"). Building a full headed-Playwright workaround for a
  platform the owner has already deprioritized is disproportionate effort
  for this batch — tracked separately in the fresh-research batch if
  ever wanted.
- Wellfound's job data comes from a `__NEXT_DATA__` JSON blob embedded in
  server-rendered HTML (confirmed by the legacy implementation) — this
  needs a REAL rendered page (client-side hydration can alter it) via
  Playwright, not a plain unauthenticated `fetch()`, in addition to the
  Google OAuth session requirement.

## 5. Risks

- **Medium — HTML-scraping fragility.** All three fetch-compatible boards
  are parsed via regex-over-HTML (matching `builtin.ts`'s established,
  accepted risk posture) — a markup change breaks the adapter. Mitigated
  the same way `builtin.ts` already is: throw on an unrecognized shape,
  never silently return `[]`.
- **Low — relevance filtering duplication.** The legacy tool's `FIT_RX`
  word-boundary regex is a parallel, simpler version of this project's own
  `matching/tiering.ts` GREEN/YELLOW/RED classifier (which already runs
  AFTER every source's `fetch()`, per `apply/runner.ts`). These new
  adapters should NOT re-implement a second relevance filter — they return
  every real listing they find, exactly like `braintrust.ts`/`builtin.ts`
  already do, and let the existing, already-configured `roleArea` tiering
  (now populated with the owner's real criteria, from the prior epic's
  hive-migration prefill) do the filtering. Duplicating `FIT_RX` inside
  the adapter would silently pre-filter results in a way the user's own
  configured `roleArea` can't see or override.
- **Low — Wellfound's `__NEXT_DATA__` shape is a private API surface**
  (undocumented, can change without notice) — same class of risk this
  project already accepts for Braintrust's JSON API and BuiltIn's HTML
  shape; not a new risk category.

## 6. Open questions

1. Should the 3 fetch-compatible adapters return ALL real listings (no
   in-adapter relevance pre-filter), consistent with `braintrust.ts`/
   `builtin.ts` and letting `tiering.ts` do the one real classification
   pass? Leaning: yes, per §5's "no duplicate filter" risk.
2. Does Wellfound need its own dedicated Capture Login session (not a
   reused GoFractional one)? Leaning: yes, per §3's isolation rationale.
