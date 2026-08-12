# Grill Record — dashboard-config-ui

**Source draft:** .pHive/epics/dashboard-config-ui/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (research brief has no explicit `inconsistency_risk_signals` section this pass — heuristic pass against the draft alone)
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

- **H1** — The config write path's secret-preservation mechanism, called
  out as "the epic's single highest-stakes correctness requirement," is
  itself left as an unresolved either/or rather than a decided design.
  - Draft location: §3 step 3 ("Reads the RAW, pre-resolution config.json
    separately from loadConfig()'s resolved view (**or** tracks which
    fields came from env: references and refuses to overwrite them with
    resolved values)").
  - Why this matters: §4 explicitly names this as the epic's biggest risk
    — a wrong implementation "doesn't fail loudly... it silently leaks a
    real secret." Leaving the actual mechanism as an unpicked either/or
    contradicts the weight §4 places on getting this exactly right; a
    story written against "or" is a story an implementing agent has to
    make this security-critical call unsupervised.
  - Question for planner: pick one mechanism now — most likely "always
    re-read the raw `config.json` file separately for the write path
    (never derive from `loadConfig()`'s resolved output at all)," since
    that avoids needing to track resolution provenance through the edit
    round-trip — and state it as a decision, not an option.

- **H2** — The "Medium, not Large" scale call is asserted without directly
  engaging the factors that would argue the other way.
  - Draft location: §8 ("RECOMMENDATION: Needs H/V planning (Medium, not
    Large...)" / "Not Large: no multi-system migration, no
    structured-outline-caliber unknowns once the scope questions above are
    answered").
  - Why this matters: this is the first UI code in the entire codebase
    (no app-router, no styling framework, no lint config, no E2E testing
    framework — all confirmed blank-slate in the research brief), combined
    with a security-critical write path the draft itself flags as
    high-risk. The "not Large" reasoning doesn't explain why blank-slate
    setup risk + a security-critical component don't meet the bar for
    Large's "long-horizon, real unknowns" framing — it's asserted, not
    argued from those specific factors. (Team review in the prior epic
    caught an analogous undersold-scope call; worth checking this one
    doesn't repeat that pattern.)
  - Question for planner: either strengthen the Medium justification by
    directly addressing why blank-slate-plus-security-critical doesn't
    tip this to Large, or reconsider whether a structured outline's
    mandatory Risk Registry + Elicitation would genuinely surface things a
    vertical-slice plan alone would miss.

## Unresolved tensions

Clean. The apparent tension between the epic's scope-reduction proposal
(deferring the login-capture flow) and the user's stated wish to "login...
see it all" is explicitly named and reasoned through in §4 as a Low risk
with a concrete justification and committed next step — not hidden.

## Convention violations

Clean. The secrets-handling discipline (never log/serialize resolved
values, outside-repo-tree storage, permission warnings) established across
every prior epic is explicitly carried forward, not weakened.

## Posture mismatches

Clean. Core/user-layer boundary maintained — templates and UI framed as
generic, owner's criteria stay local config.

## Notes

None beyond the findings above.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; the
planner's job is to revise the draft (or document accepted deviations)
before stories are written.
