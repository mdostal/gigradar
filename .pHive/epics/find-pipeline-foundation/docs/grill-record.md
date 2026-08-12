# Grill Record — find-pipeline-foundation

**Source draft:** .pHive/epics/find-pipeline-foundation/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** present
**round_number:** 1
**unresolved_count:** 2
**Generated:** 2026-08-10

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 1 finding
- Unresolved tensions: 1 finding
- Convention violations: clean
- Posture mismatches: not applicable

## Vocabulary mismatches

Checked draft terminology against `.pHive/CONTEXT.md`'s canonical terms
(Source, Gate, Gig, tier, MatchResult) and against the research brief's
flagged risk that "port the gate" could conflate the legacy `gate()` (which
returns tiered gigs directly) with the new TS `gate()` → `MatchResult`
contract. The draft treats tiering as a distinct new module wired in *after*
`gate()` (§3 step 3), never says "port the gate," and consistently uses
"Source"/"adapter" and "tier" the way CONTEXT.md defines them. Clean.

## Hidden assumptions

- **H1** — Draft states a source-selection preference as if settled while
  simultaneously leaving source selection as unresolved.
  - Draft location: §3 step 4 ("Pick sources that don't require the fragile
    headed-Cloudflare-workaround GoFractional needed (defer that one) —
    start with adapters that have a simpler auth story...") vs. §6 Open
    Question 2 ("How many real Source adapters does this epic ship... Which
    ones, specifically, given the varying auth complexity in legacy
    `platforms.mjs`?")
  - Why this matters: "simpler auth story" is asserted without naming which
    legacy-registry entries qualify (research brief cites 15 entries with
    varying `login`/`session` metadata — e.g. `braintrust`: public board, no
    session; `ateam`: google-oauth via a named session; `gofractional`:
    headed-only). A story can't be written against "pick the simpler ones"
    without the planner (or user) actually naming candidates.
  - Question for planner: name the 2-3 candidate sources explicitly (or
    defer naming to the H/V/story phase with an explicit selection
    criterion), so "simpler auth" isn't left as an implicit, unverified
    filter.

## Unresolved tensions

- **U1** — "Done" criteria implies live-source verification; the
  verification plan explicitly excludes it.
  - Draft location: §1 ("at least a couple of real (non-fixture) sources
    return live, gated, tiered results") vs. §7 Verification Plan ("Not
    verifying: end-to-end live scraping in CI... live scraping in automated
    tests is explicitly the flakiness pattern this epic exists to move away
    from").
  - Tension: if "done" requires observing real live results, but the
    verification strategy is fixture-only, what actually confirms a source
    adapter works against the real site before the epic is called complete?
  - Question for planner: is there an explicit one-time manual verification
    step (run the adapter live once, by hand, outside CI) that counts toward
    "done," separate from the automated fixture-based test suite? If so,
    name it explicitly rather than leaving "live results" as an implicit,
    untested claim.

## Convention violations

Checked against `docs/ARCHITECTURE.md` / CONTEXT.md conventions: core must
never hard-code user-specific data; a Source must throw (not silent-zero) on
auth failure. The draft's tiering proposal is explicitly user-configured
(§3 step 3, "not hardcoded keywords"), and nothing in the draft proposes
changing the existing throw-on-auth-failure behavior already implemented in
`runner.ts`. Clean.

## Posture mismatches

gigradar's stated posture (core/user-layer separation, zero-core-edits to
add a source) is not contradicted anywhere in the draft — the persistence
and tiering proposals are both framed as generic, user-configured modules.
Hive's own "composable substrate / atomic skills" posture does not apply to
this consumer project. Not applicable.

## Notes

- Minor, not rising to a finding: §5 says "this epic doesn't need to stand
  up CI infrastructure itself" while §4 worries about tests becoming "flaky
  in a new way." Worth the planner keeping in mind that without CI, "fully
  tested" today means "passes locally when someone remembers to run `npm
  test'" — not a design flaw, just a gap that a later epic (or a
  cross-cutting concern) may need to close.
- The draft's scope boundary (FIND-only; no apply/UI) is well-grounded — it
  traces directly to the user's explicit epic-scope confirmation, not an
  unstated assumption.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; the
planner's job is to revise the draft (or document accepted deviations)
before stories are written.
