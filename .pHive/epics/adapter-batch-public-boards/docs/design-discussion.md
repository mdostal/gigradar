# Design Discussion: adapter-batch-public-boards

## 0. Prelude

**NORTH STAR**: get the owner's real pipeline actually producing results
with minimal manual setup — 3 of these 4 platforms need ZERO login and can
start producing the moment this epic merges.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern every prior query hit — disregarded).

## 1. What Are We Doing?

Four new `Source` adapters, ported from the owner's real, currently-running
legacy tool (`sources.mjs` on the hive) but re-implemented against THIS
project's own conventions, not copied verbatim:

- **FractionalJobs** (`fractionaljobs.io`), **Fractionus** (`fractionus.com`),
  **FractionalFinders** (`fractionalfinders.com`) — all three confirmed
  server-rendered, `auth:"none"`, following `builtin.ts`'s exact
  fetch()+regex pattern (not the legacy tool's heavier Playwright approach,
  which these sites don't actually need).
- **Wellfound** (`wellfound.com`) — confirmed client-rendered +
  Google-OAuth-gated, following `gofractional.ts`/`ateam.ts`'s
  `browser-session` pattern, with its own dedicated Capture Login entry.

"Done": all four sources appear in the config UI's source picker
(`KNOWN_SOURCES`), the three public ones return real listings with zero
setup the moment they're enabled, Wellfound works after one Capture Login
click, and every returned `Gig` flows through the existing gate/tiering
pipeline unmodified — no new filtering logic duplicated in these adapters.

## 2. What I Found

- Live-verified (this session, not assumed) that FractionalJobs/Fractionus/
  FractionalFinders are server-rendered — `curl` alone returns real job
  links in the raw HTML — so they need `builtin.ts`'s simpler pattern, not
  the legacy tool's Playwright-cli approach.
- Live-verified Ladders (the batch's original 5th platform) actively
  returns HTTP 403 to a realistic browser User-Agent — a stronger signal
  than "needs a browser," and it's already the owner's own lowest-priority
  platform (P3). Dropped from this batch (§4 of research brief).
- `robots.txt` on all three fetch-compatible hosts has no relevant
  `Disallow` — same ethical-scraping check `builtin.ts` already establishes
  as this project's convention.
- The legacy tool's `FIT_RX` word-boundary relevance filter is a parallel,
  simpler duplicate of this project's own `tiering.ts` classifier, which
  already runs on every source's output. Not porting it — these adapters
  return every real listing, exactly like `braintrust.ts`/`builtin.ts`.
- Wellfound's legacy implementation reuses GoFractional's Google-SSO
  session — this project's convention is one dedicated session per source;
  Wellfound gets its own.

## 3. My Proposed Approach

1. **`src/lib/sources/fractionaljobs.ts`**, **`fractionus.ts`**,
   **`fractionalfinders.ts`** — each mirrors `builtin.ts`'s shape exactly:
   `auth:"none"`, a bare `fetch()` with only `{accept: "text/html"}` —
   NO User-Agent spoofing. **Corrected post-grill (resolves H1 below)**:
   the original draft proposed a "realistic User-Agent header," but
   `builtin.ts` (confirmed by direct code read) sends zero special headers
   beyond `accept`, and live re-verification just now (curl with no
   User-Agent at all) confirms all three sites return the exact same 63/
   53/16 real job links either way — spoofing a browser identity would
   have been an unjustified, unnecessary divergence from the honest,
   already-proven pattern this draft claims to follow. Regex extraction of
   `/jobs/<slug>` links + surrounding card text (the legacy functions'
   exact slug-parsing/title-case logic, adapted). **Throw/return-`[]` split
   corrected during collaborative review**: matches `builtin.ts`'s ACTUAL
   two-tier behavior (confirmed by code read, not the single "throw on zero
   matches" rule an earlier draft stated) — throw only on a genuine PAGE
   SHAPE failure (the expected container/markup isn't present at all, or
   cards were found but zero parsed into a valid shape); a page that loads
   fine and legitimately has zero current listings (plausible for smaller
   boards — FractionalFinders had only 16 live listings when checked)
   returns `[]`, not a thrown error. Conflating "genuinely quiet day" with
   "the site broke" would produce false-positive failures. `rate`/
   `weeklyHours` left `undefined` where the board doesn't reliably expose
   them (true for all three — matches the legacy tool's own observation
   that these boards rarely publish rate/hours).
2. **`src/lib/sources/wellfound.ts`** — `auth:"browser-session"`,
   `withBrowserSession()` against both of the legacy tool's target URLs
   (`/role/l/chief-technology-officer`, `/role/l/vp-of-engineering`),
   extracting from the page's `__NEXT_DATA__` script tag. **Corrected
   post-grill (resolves H2 below)**: this is NEW extraction logic, not a
   reuse of `gofractional.ts`'s DOM-eval helper — confirmed by direct code
   read, `gofractional.ts`'s `page.evaluate()` queries specific card/anchor
   CSS selectors (`querySelectorAll('a[href^="/job/"]')` etc.), a flat
   query shape, structurally different from Wellfound's recursive
   walk-an-arbitrary-JSON-tree-for-`title`/`slug`-keys approach (the legacy
   implementation's actual logic, being adapted here). The story
   implementing this should be scoped and estimated as genuinely new
   parsing logic, only reusing `withBrowserSession()`'s session/origin
   plumbing from the existing pattern, not its DOM-extraction code.
   `settings.sessionStatePath` required, same as `gofractional.ts`/
   `ateam.ts`.
3. **`src/lib/sources/origins.ts`**: add `wellfound: ["wellfound.com"]` to
   `SOURCE_ORIGINS`, a login URL to `SOURCE_LOGIN_URLS` (Wellfound's own
   `/login` route — real, standard OAuth-provider-select page, not a
   best-guess), and add all four new sources to `KNOWN_SOURCES` (the
   picker fixed in the prior epic) so they're selectable without a typo
   risk from day one.
4. **No relevance pre-filtering inside any of these adapters** — resolves
   research brief open question #1. Every real listing found is returned;
   `tiering.ts`'s already-configured `roleArea` (now populated with the
   owner's real criteria from the hive-migration prefill) is the one
   classification pass, exactly matching `braintrust.ts`/`builtin.ts`.
5. **Wellfound gets its own dedicated session, not GoFractional's** —
   resolves research brief open question #2, per this project's
   one-session-per-source convention.

## 4. What Could Go Wrong

- **Medium — HTML-scraping fragility** (all three fetch-based adapters):
  accepted, same posture as `builtin.ts` already ships with — throw loud on
  an unrecognized shape, never silently degrade to empty results.
- **Medium — a live site could rate-limit or start blocking these adapters
  after this epic ships** (real evidence this can happen: Ladders already
  does, per this research). **Accepted mitigation, stated explicitly
  (added post-grill, resolves U1 below)**: this epic's bar is "throw a
  loud, specific error naming the failing source" on a block/rate-limit —
  never silently degrade to an empty result, exactly like every other
  adapter's throw-on-auth-failure/throw-on-unrecognized-shape convention.
  That's a SUFFICIENT mitigation for this epic's own scope: the owner sees
  a clear, actionable failure instead of silent staleness. Genuine
  retry/backoff SOPHISTICATION (exponential backoff, per-source rate
  budgets) is legitimately separate, larger scope — correctly deferred to
  the "fancier cron" epic (#37), which is about scheduling ACROSS sources,
  not any single adapter's error handling.
- **Low — Wellfound's `__NEXT_DATA__` shape could change** without notice
  (undocumented internal API) — same accepted risk class as Braintrust's
  JSON API / BuiltIn's HTML shape.
- **Low — this doesn't build the "notify + 1-tap submit" enhancement**
  the owner's table asks for on GoFractional, or LinkedIn/BuiltIn's JD
  capture — those are explicitly tracked separately (task #36), not
  silently folded in here.

## 5. Dependencies and Constraints

- Depends on `dashboard-config-ui` (source picker), `session-capture-ui`
  (Capture Login mechanism Wellfound reuses), `browser-session-auth`
  (`withBrowserSession()`, origin-scoping) — all merged.
- Zero new dependencies — `fetch()` (built-in) for 3 adapters, existing
  `playwright` dependency for Wellfound.
- **Corrected post-grill (resolves C1 below)**: the three fetch-based
  adapters need an actual `SourceConfig` entry in `config.json` to ever
  run — `auth:"none"` means "no session/key needed," not "runs without
  being listed" (confirmed against `apply/runner.ts`'s source-iteration
  model). "Zero setup" is only true once that entry exists. For a fresh
  OSS install, that's the standard onboarding step (the config UI's source
  picker, built in the prior epic, makes adding them a dropdown pick, not
  a typo-prone freeform field). For THIS specific owner's install — whose
  real local `config.json` was directly prefilled in the immediately prior
  session epic — this epic's integrate step ALSO directly enables these
  three new sources in that same real local file (the identical kind of
  intentional, direct local-config write already done for the hive-migration
  prefill), so "zero setup" is concretely true for the actual install this
  session has been building toward, not just a generic OSS claim.
  **Clobber-risk correction from collaborative review**: `saveConfig()`'s
  `sources` field is a FULL-SECTION REPLACE, not an append/splice
  (confirmed by direct read of `save.ts`'s own header comment and merge
  logic) — a naive `saveConfig({sources: [...new ones]})` call would
  silently WIPE the owner's already-prefilled braintrust/builtin/
  gofractional/ateam entries, exactly the class of silent-clobber mistake
  `save.ts` is designed to prevent for secrets but doesn't prevent for the
  `sources` array itself. The integrate step MUST first read the current
  document (`readRawConfig()`), build the complete merged array (existing
  4 entries + the new 3 fetch-based sources, Wellfound deferred until its
  Capture Login is done), and pass that whole array as the edit — never a
  partial one.

## 6. Open Questions

1. ~~No in-adapter relevance filter~~ — **resolved**: none, rely on
   `tiering.ts`, §3 step 4.
2. ~~Wellfound session isolation~~ — **resolved**: dedicated session, §3
   step 5.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/adapter-batch-public-boards/docs/grill-record.md`,
`unresolved_count: 4`) surfaced 4 findings, all resolved — each re-verified
against the real current code/live sites, not just argued about:

- **H1** (unjustified User-Agent spoofing) — dropped entirely; re-verified
  live that all three sites work identically with zero special headers,
  matching `builtin.ts`'s actual (confirmed by code read) convention.
- **H2** (Wellfound assumed to reuse `gofractional.ts`'s DOM-eval helper)
  — corrected; confirmed by code read that the two extraction shapes are
  structurally different, so this is scoped as new logic, not a reuse.
- **U1** (no mitigation for the exact blocking risk this research already
  observed once) — resolved: throw-loud-on-failure is the explicit,
  sufficient bar for this epic; retry/backoff sophistication correctly
  stays deferred to the scheduler epic.
- **C1** (claimed "zero setup" without accounting for how source
  activation actually works) — resolved: this epic's integrate step
  directly enables these sources in the owner's real local config.json,
  making the claim concretely true rather than aspirational.

## 6b. Collaborative Review Findings Addressed

One backend-implementation review, run against the grill-revised draft,
surfaced 2 concrete findings — both grounded in direct reads of the real
current code, both resolved:

- The C1 fix's "directly enable in the owner's real config.json" plan had
  a real clobber risk — `saveConfig()`'s `sources` field is a full-section
  replace, so writing just the new entries would silently wipe the
  already-prefilled ones. Fixed: the integrate step now explicitly reads
  current sources first and writes the complete merged array — §3 step 1.
- The "throw on zero matches" rule didn't actually match `builtin.ts`'s
  real behavior (which distinguishes a page-shape failure from a
  legitimately quiet day with zero current listings) — fixed to mirror the
  real two-tier behavior, avoiding false-positive failures on smaller
  boards — §3 step 1.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest; live curl/fetch verification already done during research
    (not repeated as an automated CI test — matches this project's existing
    zero-live-network-calls-in-CI convention for braintrust.ts/builtin.ts)
  Platforms: Node.js
  Automated: fixture-based unit tests for all four adapters (a captured
    real HTML/JSON sample per board, parsed offline) — covers: correct
    Gig[] mapping, throw-on-unrecognized-shape, zero-listings-found
    handling, and (Wellfound only) the origin-scoped session/auth-failure
    path matching gofractional.ts's/ateam.ts's existing test patterns.
  Manual: one live verification run per adapter (matching this project's
    established practice for every prior source) — confirm real listings
    come back, URLs are real per-listing pages (never search pages, per
    ARCHITECTURE.md's data-integrity rule), and Wellfound's Capture Login
    flow actually produces a working session.
  Not verifying: Ladders (dropped, §4 of research brief); rate-limiting/
    backoff behavior (explicitly deferred to the scheduler epic, #37).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~12-14 (4 new adapter files + 4 fixture test files, plus
    origins.ts additions and docs/ARCHITECTURE.md updates)
  Subsystems: source adapters only — no changes to gate/tiering/store/UI
    beyond the origins.ts registry additions already designed for exactly
    this kind of extension
  Migration required: no — purely additive
  Cross-team coordination: no
  Unknowns: 0 remaining (both open questions resolved; live verification
    already done, not deferred to execution)

  RECOMMENDATION: Small-Medium, story-decompose directly, skip H/V
  RATIONALE: This is the most mechanical epic of the session so far — three
    adapters are near-identical repeats of an already-proven pattern
    (builtin.ts), the fourth is a repeat of another already-proven pattern
    (gofractional.ts/ateam.ts), and live verification (the part that's
    usually the real unknown) is already done, in this document, not
    deferred. A vertical-slice H/V plan would add ceremony without
    resolving any actual open question — story decomposition can sequence
    directly: one story per adapter (or grouped 3-fetch-adapters + 1
    browser-session-adapter), matching this project's existing multi-story
    epic shape.
```
