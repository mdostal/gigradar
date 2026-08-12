# Grill Record — role-templates

**Source draft:** .pHive/epics/role-templates/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass against the draft alone)
**round_number:** 1
**unresolved_count:** 2
**Generated:** 2026-08-11

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: clean
- Convention violations: clean
- Posture mismatches: clean

## Hidden assumptions

- **H1** — The overwrite-confirmation safeguard is suggested as a good
  idea in §4 but never actually committed to as part of the design in §3.
  - Draft location: §3 step 2 ("Applying a template OVERWRITES the
    current roleArea draft") vs. §4 ("Worth a lightweight UI safeguard...
    named explicitly so it isn't dropped during implementation").
  - Why this matters: naming a risk and suggesting a mitigation in the
    risks section isn't the same as deciding to build it — §3 (the actual
    proposed approach) doesn't mention a confirmation step at all. Left
    as-is, an implementing agent could reasonably read §3 as the
    authoritative spec (silent overwrite, no confirmation) and treat §4's
    suggestion as optional commentary.
  - Question for planner: decide explicitly — does this story include a
    confirm-before-overwrite step, or is a silent overwrite acceptable
    for v1 given the field is easy to re-edit? Either is defensible; the
    draft needs to pick one, not leave it as a "worth considering" aside.

- **H2** — The draft's own illustrative example of `redKeywords` content
  is confused, undermining confidence in the "content quality is the only
  real risk" framing.
  - Draft location: §3 step 1 ("`redKeywords` are the same-title-different-domain
    traps... e.g. for CTO: 'chief technology officer' adjacent-but-wrong
    titles like 'cto of sales' style mismatches").
  - Why this matters: "chief technology officer" is the role itself, not
    a trap to exclude, and "cto of sales" isn't a real, commonly-seen
    title — this example doesn't actually illustrate a real
    same-title-different-domain confusion the way the CFO example does
    ("finance"/"fp&a" is concrete and real). Since the design's own risk
    assessment stakes the whole epic's low-risk framing on "content
    quality, not technical risk," a confused example in the design itself
    is worth catching now, before it becomes a template shipped with
    similarly unclear reasoning.
  - Question for planner: replace the CTO `redKeywords` example with a
    real, concrete same-title-different-domain trap (e.g. a title that
    superficially matches "CTO" keyword-wise but is clearly a different
    role — something like "Chief Talent Officer" abbreviated informally,
    or a sales/marketing title that happens to contain an overlapping
    word) — or drop the weak example and let the implementing story
    derive real content from scratch rather than anchoring on a
    confusing illustration.

## Unresolved tensions

Clean.

## Convention violations

Clean. Reuses the existing form state and save path without introducing
a new pattern.

## Posture mismatches

Clean. Template content framed as generic/illustrative, not the project
owner's own criteria.

## Notes

None beyond the findings above.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; the
planner's job is to revise the draft (or document accepted deviations)
before stories are written.
