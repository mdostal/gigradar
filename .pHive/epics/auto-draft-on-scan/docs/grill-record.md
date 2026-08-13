# Grill Record — auto-draft-on-scan

**Source draft:** .pHive/epics/auto-draft-on-scan/docs/design-discussion.md
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

## Hidden assumptions

- **H1** — §3 step 2 gives the missing-`ANTHROPIC_API_KEY` case a
  "check once, log once, skip the whole cycle" treatment specifically to
  avoid per-gig log spam — but never applies the SAME treatment to
  `Config.applyProfile` being unset, which `stageApplication()` also
  guards against. The draft's own hedge ("should never actually fire
  here, though") reveals the gap: if a user enables `autoDraftOnScan` and
  sets `ANTHROPIC_API_KEY` but never fills in their apply profile, EVERY
  eligible green-tier gig in EVERY cycle would trigger
  `stageApplication()`'s missing-`applyProfile` error, caught by the
  per-gig error handler and logged — forever, once per eligible gig,
  every single cycle, exactly the per-gig spam pattern the API-key case
  was designed to avoid.
  - Draft location: §3 step 2
  - Why this matters: a realistic, easy-to-hit misconfiguration (enable
    auto-draft, set the API key, forget the apply profile) produces
    unbounded repeated log noise instead of one clear, actionable message.
  - Question for planner: should the scheduler check
    `config.applyProfile` ONCE per cycle (alongside the API-key check),
    logging one clear line and skipping the whole cycle's auto-drafting
    if it's unset — the identical treatment already given to the missing
    API key?

- **H2** — §3 step 2's "not already drafted" check (`getDraft(gigKey)
  === undefined`) never states which draft STATUSES count as "already
  handled." `getDraft()` returns a draft regardless of its status
  (`draft`/`approved`/`rejected`/`submitted`) — so a gig the user
  explicitly REJECTED would, under this check, never be eligible for a
  fresh auto-draft attempt again, even if the gig's own data changes
  later. This may well be the right default (never silently overwrite a
  decision the user already made, regardless of what that decision was),
  but it's a real, non-obvious consequence the design doesn't state.
  - Draft location: §3 step 2 ("not already drafted")
  - Why this matters: an implementer could reasonably read "not already
    drafted" as "not currently in draft status" (i.e., only skip
    `approved`/`submitted`, but retry `rejected` ones) — a materially
    different, plausible alternative reading that isn't ruled out.
  - Question for planner: confirm explicitly — does ANY existing draft
    row for a gig (any status) block future auto-drafting for that same
    gig, or only certain statuses?

## Unresolved tensions

No findings.

## Convention violations

No findings.

## Posture mismatches

No findings. Auto-drafting only, opt-in, never touches submission —
consistent with the confirmed "assisted, not auto" posture.

## Notes

None beyond the findings above.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
