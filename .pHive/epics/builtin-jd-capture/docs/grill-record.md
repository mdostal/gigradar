# Grill Record — builtin-jd-capture

**Source draft:** .pHive/epics/builtin-jd-capture/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — research-brief.md has no such field; used its Risks/Open Questions sections as focusing input instead)
**round_number:** 1
**unresolved_count:** 2

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: clean
- Convention violations: clean
- Posture mismatches: clean

## Vocabulary mismatches

No findings.

## Hidden assumptions

- **H1** — §3 step 1's "on ANY failure... returns `undefined` rather
  than throwing" is a DIFFERENT rule from `builtin.ts`'s own established
  list-level convention (throw on a genuine page-shape failure, return
  `[]` only for a legitimately-quiet page — the exact distinction this
  session's `adapter-batch-public-boards` epic grilled and resolved
  explicitly for the list-fetch case). The draft never states WHY
  degrading-not-throwing is the right rule at the PER-LISTING detail
  level even though the SOURCE-level list-fetch uses a stricter
  throw-on-shape-failure rule — a reader could reasonably wonder if this
  is an inconsistency rather than a deliberate, different-in-kind
  distinction (whole-source health signal vs. one-listing's
  best-effort enrichment).
  - Draft location: §3 step 1
  - Why this matters: an implementer following the adapter's own nearby
    list-level throw convention literally could reasonably make detail
    fetches throw too, silently breaking the "one bad listing doesn't
    fail the scan" goal this design actually wants.
  - Question for planner: should the design state explicitly WHY
    detail-level failures degrade rather than throw (a single listing's
    enrichment failing is not the same signal as the whole source being
    broken), so this reads as a deliberate, reasoned distinction rather
    than an unexamined inconsistency with the adapter's own nearby
    convention?

- **H2** — §3 step 2 states a "4 concurrent requests" cap but never
  specifies the actual mechanism enforcing it. A naive
  `Promise.all(listings.map(fetchDetailDescription))` would fire ALL ~25
  requests simultaneously, NOT respecting the stated cap — bounding
  concurrency requires explicit batching/semaphore logic the design
  never names.
  - Draft location: §3 step 2 ("bounded concurrency... capped at 4
    concurrent requests")
  - Why this matters: this is exactly the kind of implementation detail
    that's easy to get wrong by omission — the acceptance criteria/tests
    need something concrete to verify against, not just an asserted
    number.
  - Question for planner: should the story explicitly name the batching
    approach (e.g., process listings in fixed-size batches of 4 via
    `Promise.all` per batch, or a small manually-implemented
    semaphore/pool) so there's a concrete mechanism the acceptance
    criteria can test against?

## Unresolved tensions

No findings.

## Convention violations

No findings. Regex-over-HTML parsing, no new dependency, and the
existing adapter's ethical-scraping (robots.txt) discipline are all
preserved.

## Posture mismatches

No findings.

## Notes

Appropriately thin grill pass for a small, single-adapter enhancement —
matches this session's established proportionality for similarly-scoped
epics.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
