# Design Discussion: builtin-jd-capture

## 0. Prelude

**NORTH STAR**: better tiering matches and better LLM-drafted
applications — both `tiering.ts` and `draft.ts` (assisted-apply-drafting)
directly consume `gig.description`, and today's BuiltIn adapter only
captures a short list-card snippet, not the real job posting.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern every prior query hit — disregarded).

## 1. What Are We Doing?

Extend `src/lib/sources/builtin.ts` to fetch each listing's own
`/job/{slug}/{id}` detail page (confirmed live: robots.txt-compliant, no
login, real substantial content) and extract the FULL job description,
replacing today's short list-card snippet. A single listing's detail-fetch
failure falls back to the existing snippet (never fails the whole scan).

"Done": BuiltIn gigs in the store carry real, full job descriptions;
tiering classification and drafted applications both get meaningfully
better input than today's truncated snippet.

## 2. What I Found

- Confirmed by direct code read: `builtin.ts`'s current `description`
  comes from a single-line list-card div, not the job posting body.
- Confirmed live: detail pages are real, substantial, robots.txt-clean,
  fetchable via the exact same plain `fetch()` pattern already used for
  the list page — no new mechanism, no headless browser needed.
- Confirmed by direct code read: `tiering.ts` and `draft.ts` both
  directly consume `gig.description` — this isn't a cosmetic
  improvement, it measurably affects match quality and draft quality.

## 3. My Proposed Approach

1. **`fetchDetailDescription(url): Promise<string | undefined>`** (new,
   `builtin.ts`) — fetches one listing's detail page, extracts the full
   description via a targeted regex against its own container (same
   regex-over-HTML discipline the rest of this adapter already uses). On
   ANY failure (network error, unrecognized shape) returns `undefined`
   rather than throwing — a single listing's detail fetch failing must
   NOT fail the whole scan, resolving research brief's constraint.
   **Deliberate divergence from the list-fetch's throw convention,
   stated explicitly (added post-grill, resolves H1 below)**: this is
   NOT an inconsistency with the adapter's existing list-level
   throw-on-shape-failure rule — it's a different-in-kind signal.
   The list fetch failing means the WHOLE SOURCE is broken (a
   whole-scan-level health signal, correctly a hard failure). One
   listing's detail-enrichment failing means only that ONE listing
   doesn't get the fuller description this scan — everything else about
   the scan is unaffected, so degrading gracefully (falling back to the
   snippet already captured from the list page) is the right behavior,
   not a violation of the source's own established discipline.
2. **Bounded concurrency, always-fetch (resolves research brief open
   question #1, decided against per-listing caching)**: every listing
   from the list page gets its detail page fetched, capped at 4
   concurrent requests (resolves open question #2) — real parallelism
   without hammering BuiltIn. Deliberately NOT building cross-scan
   "already seen, skip re-fetching" caching: that would require changing
   the `Source.fetch(cfg, profile)` interface to also receive
   already-known gig keys, a change affecting EVERY adapter's contract,
   disproportionate to this one adapter's enhancement. If real-world
   request volume turns out to matter, that's a reasonable, separate,
   later optimization — not built now on speculation.
   **Concrete batching mechanism named (added post-grill, resolves H2
   below)**: a naive `Promise.all(listings.map(fetchDetailDescription))`
   would fire all ~25 requests simultaneously, NOT respecting the stated
   cap. The implementation processes listings in fixed-size batches of 4
   — `Promise.all()` per batch, awaited before starting the next batch —
   a simple, concrete, directly testable mechanism (a test can assert no
   more than 4 in-flight detail requests at any point in time), not just
   an asserted number with no stated enforcement.
3. **`toGig()` uses the detail-fetched description when available**,
   falling back to the existing list-card snippet when the detail fetch
   failed for that listing — never a missing description when SOME
   description (even the shorter one) was successfully obtained.

## 4. What Could Go Wrong

- **Low — BuiltIn's detail-page markup could differ from what this
  research observed on one sample listing.** Same accepted risk class
  every regex-based adapter here already carries — the fallback-to-snippet
  behavior (§3 step 3) means even a detail-page markup break degrades
  gracefully to today's existing behavior, not a scan failure.
- **Low — 4x-ish more requests per scan against BuiltIn than today.**
  Accepted, bounded by the concurrency cap; if this ever proves too
  aggressive in practice, the schedule's own cadence (owner-controlled)
  and the deferred caching optimization (§3 step 2) are both available
  levers without needing this epic revisited.

## 5. Dependencies and Constraints

- Zero new dependencies — plain `fetch()`, matching the existing adapter
  exactly.
- No `Source` interface changes — this stays entirely within
  `builtin.ts`'s own `fetch()` implementation.

## 6. Open Questions

1. ~~Fetch every listing or only new ones?~~ — **resolved**: every
   listing, bounded concurrency, no cross-scan caching (disproportionate
   interface change for this scope) — §3 step 2.
2. ~~Concurrency limit?~~ — **resolved**: 4 concurrent requests — §3
   step 2.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/builtin-jd-capture/docs/grill-record.md`,
`unresolved_count: 2`) surfaced 2 findings, both resolved:

- **H1** (unstated why detail-fetch failures degrade rather than throw,
  given the adapter's own list-level throw convention) — resolved in §3
  step 1: stated explicitly as a deliberate, different-in-kind
  distinction (whole-source signal vs. one-listing's best-effort
  enrichment), not an inconsistency.
- **H2** (the "4 concurrent requests" cap had no stated enforcement
  mechanism) — resolved in §3 step 2: fixed-size batches of 4, a
  concrete, directly testable approach.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest
  Platforms: Node.js
  Automated: fixture-based tests (a real captured detail-page HTML
    sample, live-fetched during this research) covering: correct full
    description extraction, fallback to the list-card snippet when the
    detail fetch fails (network error and unrecognized-shape cases both),
    and the bounded-concurrency behavior (no more than 4 simultaneous
    detail requests at once, verified via a controllable test fetch mock
    that tracks concurrent call count).
  Manual: one live verification run — confirm real, full descriptions
    are captured for real current BuiltIn listings, and that tiering
    output changes meaningfully for at least one gig where the fuller
    description surfaces a keyword the short snippet didn't.
  Not verifying: cross-scan caching (explicitly out of scope, §3 step 2).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~2-3 (builtin.ts + its test file, maybe a fixture file)
  Subsystems: one existing adapter only — no changes to gate/tiering/
    store/UI/Source interface
  Migration required: no — purely additive to one adapter's own fetch()
  Cross-team coordination: no
  Unknowns: 0 remaining (both open questions resolved above)

  RECOMMENDATION: Small, single story, skip H/V
  RATIONALE: A narrow, well-understood, single-adapter enhancement with
    live-verified feasibility already done during planning. No
    structural unknowns remain.
```
