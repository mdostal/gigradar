# Grill Record — adapter-batch-public-boards

**Source draft:** .pHive/epics/adapter-batch-public-boards/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — research-brief.md has no such field; used its Risks/Open Questions sections as focusing input instead)
**round_number:** 1
**unresolved_count:** 4

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: 1 finding
- Posture mismatches: clean

## Vocabulary mismatches

No findings. "Source," "Gig," "gate," and "tiering" are all used consistently
with CONTEXT.md's definitions.

## Hidden assumptions

- **H1** — §3 step 1 introduces "a realistic `User-Agent` header (matching
  the live-verification calls above)" for the three fetch-based adapters,
  without confirming whether `builtin.ts` — the pattern this draft claims
  to mirror exactly — actually does the same thing. If `builtin.ts` uses no
  special headers (a plain, honest `fetch()`), then spoofing a
  browser-like User-Agent here is a real, unacknowledged divergence from
  the pattern being claimed as precedent, and sits in mild tension with
  the same section's robots.txt-respecting, ethical-scraping framing —
  identifying as a browser specifically to get past whatever distinguishes
  "browser traffic" from "bot traffic" is a different posture than "we
  checked robots.txt and it allows us."
  - Draft location: §3 step 1
  - Why this matters: if this is inconsistent with `builtin.ts`'s actual
    behavior, either this draft's claimed precedent is wrong, or
    `builtin.ts` itself should be checked for whether IT already does this
    (in which case the "matching" claim is fine, just under-cited).
  - Question for planner: confirm what `builtin.ts` actually sends today,
    and either align this draft's language to match reality or drop the
    "matching" claim and justify the User-Agent choice on its own terms.

- **H2** — §3 step 2 assumes Wellfound's `__NEXT_DATA__` JSON-tree
  extraction can reuse "this project's own DOM-eval helper style already
  used in `gofractional.ts`" — but the legacy implementation's actual logic
  (recursively walking an arbitrary-depth JSON object looking for
  `title`/`slug` keys) is structurally different from what a card-based DOM
  scraper like `gofractional.ts` likely does (querying specific CSS
  selectors for known card elements). The draft states this as if it's a
  known, confirmed reuse rather than an assumption.
  - Draft location: §3 step 2
  - Why this matters: if `gofractional.ts`'s eval helper doesn't actually
    fit a recursive-JSON-walk shape, the story implementing this adapter
    may need to write genuinely new extraction logic, not adapt an
    existing helper — a real scope difference the story's estimate should
    reflect.
  - Question for planner: either confirm (by reading `gofractional.ts`'s
    actual eval helper) that it fits this use case, or state plainly that
    Wellfound's `__NEXT_DATA__` walk is new logic, not a reuse.

## Unresolved tensions

- **U1** — §1's north star claims this epic gets "the owner's real
  pipeline actually producing results with minimal manual setup," but §4
  explicitly declines to add any retry/backoff/rate-limit handling,
  deferring it to a future, unscheduled "fancier cron" epic (#37). Given
  this SAME research (§2 of the research brief) already observed one of
  these five candidate platforms (Ladders) actively blocking a plain,
  realistic request with an HTTP 403 — direct evidence that at least some
  of these sites DO actively block scraping under some conditions — there
  is a real, unaddressed risk that the shipped adapters could start
  silently failing (not "silently returning empty," since the draft
  correctly throws on an unrecognized shape, but *loudly erroring on every
  scheduled run* if a site starts blocking) shortly after this epic ships,
  undermining the "actually producing results" promise the epic opens with.
  - Draft location: §1 (north star), §4 ("Not solving this now... flagged
    for whoever builds the fancier cron epic")
  - Tension: "producing results with minimal manual setup" (stated goal)
    vs. "no mitigation for the exact failure mode this research already
    observed once" (explicit non-decision).
  - Question for planner: is throwing loudly on a block/rate-limit
    (rather than silently degrading) an ACCEPTED, sufficient mitigation
    for THIS epic's scope (the user sees a clear error instead of stale
    silence, and the retry/backoff sophistication is legitimately a
    separate epic's concern) — in which case §4 should say that
    explicitly, rather than reading as an unaddressed gap?

## Convention violations

- **C1** — §5 states these adapters "produce real results with ZERO user
  setup the moment this epic merges," but this contradicts how source
  activation actually works in this codebase: `apply/runner.ts` only ever
  calls a source's `fetch()` for entries present in the user's
  `config.json`'s `sources[]` array (confirmed by every existing adapter's
  own registration — `auth:"none"` means "no session/key needed," not "runs
  without being listed"). For the SPECIFIC owner of this codebase, whose
  real local `config.json` was just prefilled in the immediately prior
  epic this session with exactly four sources (braintrust, builtin,
  gofractional, ateam) and none of these four new ones, "zero user setup"
  is concretely false today unless something explicitly adds these new
  entries to that file — a step this draft assigns to no one.
  - Draft location: §1 ("Done" bar, correctly says "zero setup... the
    moment they're enabled" — the qualifier is right there) vs. §5 (drops
    the qualifier: "ZERO user setup the moment this epic merges")
  - Convention: `src/lib/apply/runner.ts`'s source-iteration model (drives
    off `config.sources[]`, not a source registry auto-discovery)
  - Question for planner: should the epic's finalize/integrate step
    explicitly enable these three sources in the owner's own real local
    `config.json` (the same kind of direct, intentional local-config write
    the immediately prior epic already did for the hive-migration
    prefill), so "zero setup" is actually true for this specific install —
    or should §5 be corrected to match §1's more accurate "once enabled"
    framing, leaving it as a UI action for the owner?

## Posture mismatches

No findings. Nothing in this draft departs from the project's core/
user-layer boundary, single-user/local posture, or established adapter
conventions without justification.

## Notes

This is a notably tighter, more mechanical draft than prior epics'
design-discussions — appropriately so, given three of the four adapters
are near-identical repeats of an already-proven pattern (`builtin.ts`) and
live verification (curl checks, robots.txt) is already done in the
document rather than deferred. The findings above are correspondingly
narrower in scope than prior grill passes on larger, more novel epics.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
