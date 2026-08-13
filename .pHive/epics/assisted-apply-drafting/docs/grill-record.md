# Grill Record — assisted-apply-drafting

**Source draft:** .pHive/epics/assisted-apply-drafting/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — research-brief.md has no such field; used its Risks/Open Questions sections as focusing input instead)
**round_number:** 1
**unresolved_count:** 3

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: clean
- Posture mismatches: clean

## Vocabulary mismatches

No findings. `application_drafts.status` (`draft/approved/rejected/
submitted`) is explicitly distinguished from the existing `GigStatus`
(`new/applied/interview/archived/ignored`) as a separate, parallel axis —
the draft states this distinction itself rather than silently reusing
the same term for two different concepts.

## Hidden assumptions

- **H1** — Having explicitly distinguished draft-status from gig-status
  (see Vocabulary mismatches above), the draft never states whether
  marking a draft `"submitted"` should ALSO update the linked gig's own
  `status` to `"applied"` — or whether the user must perform both
  transitions separately (mark the draft submitted, AND separately mark
  the gig applied via the dashboard's existing status dropdown). These
  are two parallel, clearly-related tracking mechanisms whose sync
  behavior (or deliberate independence) is never stated.
  - Draft location: §3 step 5 ("the user completes the actual submission
    on the source's real site themselves, then marks it 'submitted'")
  - Why this matters: if left unsynced, a user could easily end up with
    a draft marked "submitted" while the gig itself still shows status
    "new" in the main dashboard view — a confusing, easy-to-miss
    inconsistency in exactly the tracking system this epic exists to
    improve.
  - Question for planner: should marking a draft "submitted" also
    transition the linked gig's status to "applied" automatically (one
    user action, two consistent state updates), or are they intentionally
    independent (and if so, why)?

- **H2** — §3 step 2's `generateDraft(gig, profile, applyProfile)` is
  described as grounded strictly in the real provided data, but
  `Config.applyProfile` is explicitly OPTIONAL (§3 step 1, "omitted = not
  configured, not an error" — matching `roleArea`/`schedule`'s pattern).
  The draft never addresses what `generateDraft()` does when
  `applyProfile` is `undefined` — a realistic first-run scenario (a new
  user clicks "Generate draft" before ever filling in email/phone/
  LinkedIn/etc.).
  - Draft location: §3 step 2 (`generateDraft()`'s signature and grounding
    description)
  - Why this matters: without an explicit decision, this could either
    silently produce a draft with garbled/missing contact fields (a real
    version of the "accuracy landmines" risk §4 already names for a
    different cause), or crash unpredictably depending on how the prompt
    handles undefined values.
  - Question for planner: should `stageApplication()`/`generateDraft()`
    throw a specific, actionable error when `applyProfile` isn't
    configured yet (pointing the user at the config page), rather than
    attempting a degraded draft?

## Unresolved tensions

- **U1** — Research brief §2 cites the legacy tool's own proven
  principle: "Red never applies" (part of the real, already-validated
  4-check gate this design explicitly treats as valuable prior art for a
  LATER epic). But THIS epic's design places zero tier restriction on who
  can request a draft — `stageApplication(matchResult)` is callable for
  any `MatchResult` regardless of tier. The draft doesn't reconcile
  "deliberately narrower than the full gate" (the epic's own stated scope
  boundary) with "a minimal, common-sense guardrail like 'don't offer to
  draft for a red-tier gig' seems like it belongs in the human-review-
  assist layer too, not just the deferred auto-fire layer."
  - Draft location: §1 ("Done" bar, no tier restriction mentioned), §3
    step 4 (`stageApplication(matchResult)`, no tier check), research
    brief §2 (cites "Red never applies" as legacy prior art)
  - Tension: "this epic is intentionally narrower than the full 4-check
    gate" (stated scope boundary) vs. "a minimal red-tier guardrail is
    arguably not gate-sophistication, just basic sense, and its absence
    means a user could accidentally generate (and burn real LLM-call
    cost on) a draft for a gig the tiering system already flagged as
    clearly off-target."
  - Question for planner: should this epic include a minimal guardrail
    (e.g., `stageApplication()` throws or the UI simply doesn't offer
    "Generate draft" for `tier === "red"`), reserving the FULL 4-check
    gate's other three checks (economics, live/new, fillable) for the
    later auto-fire epic — or is even this minimal check intentionally
    out of scope, and if so, why?

## Convention violations

No findings. `Config.applyProfile` follows the established optional-
section pattern exactly; `application_drafts`'s schema follows
`schema.ts`'s existing `IF NOT EXISTS` idempotent pattern; the
draft-then-explicit-action UI shape matches `role-templates`/
`resume-link-ui`'s established convention.

## Posture mismatches

No findings. LLM usage remains explicit/user-triggered (matching
`profile-overview-ingestion`'s already-established posture), nothing
auto-submits, and the design explicitly reaffirms rather than departs
from "assisted, not auto."

## Notes

None beyond the findings above. This is a notably larger, more
cross-cutting design than this session's recent smaller epics
(config schema + store schema + LLM + UI, all at once) — the design
doc's own H/V recommendation appropriately reflects that scale.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
