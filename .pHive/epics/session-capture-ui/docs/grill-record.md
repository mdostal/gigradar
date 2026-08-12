# Grill Record — session-capture-ui

**Source draft:** .pHive/epics/session-capture-ui/docs/design-discussion.md
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

- **H1** — `finishCapture()`'s destination file naming/path convention is
  asserted at the directory-class level but never actually specified.
  - Draft location: §3 step 2 ("writes the FILTERED result to
    `destinationPath`... reusing `getDefaultDataDir()`'s XDG directory
    convention — same location class as `config.json`/`.env`").
  - Why this matters: "same directory" isn't "same filename convention" —
    is `destinationPath` caller-supplied per capture call (from the UI,
    e.g. a filename the user picks), auto-derived from `sourceId` (e.g.
    `gofractional-session.json`), or something else? Multiple captures
    for the SAME source (e.g. re-capturing after expiry) need a defined
    behavior too — overwrite the prior file, or version it? Left
    unspecified, an implementing agent has to invent this unsupervised for
    what's otherwise a carefully-specified epic.
  - Question for planner: decide the naming convention explicitly (e.g.
    `<sourceId>-session.json` in the XDG data dir, always overwritten on
    re-capture) rather than leaving it implicit in "same location class."

- **H2** — The "leaning Small" scale call doesn't directly engage the
  factors §4 itself names as the epic's most novel risk.
  - Draft location: §8 ("RECOMMENDATION: Proceed directly to stories
    (Small-Medium boundary, leaning Small)") vs. §4 ("High — leaked
    Chromium processes on abandoned captures, the epic's most novel new
    failure mode — nothing in this codebase has needed cross-request
    cleanup before").
  - Why this matters: this project's own review history (browser-session-auth
    and dashboard-config-ui both had a scale-assessment finding caught by
    team review, in both cases resolved by directly engaging the specific
    risk factors rather than asserting past them) suggests checking this
    pattern doesn't repeat a third time. A genuinely novel, stateful,
    cross-request mechanism handling live OS processes is a different
    risk class than this epic's file-count estimate implies.
  - Question for planner: either strengthen the Small justification by
    directly addressing why the novel-failure-mode risk doesn't warrant
    more deliberate sequencing (e.g., is the capture mechanism's own
    story-level test coverage sufficient without needing H/V slicing?),
    or reconsider Medium.

## Unresolved tensions

Clean. §4's two related-but-distinct risks (idle-user abandonment,
covered by the timeout; process-restart, explicitly NOT covered by it)
are separately and honestly named, not conflated or left to imply the
timeout solves both.

## Convention violations

Clean. Headed-only and origin-scoping discipline from `browser-session-auth`
are both correctly reused, not weakened or reinterpreted.

## Posture mismatches

Clean. Core/user-layer boundary maintained — no hardcoded owner-specific
flow or source.

## Notes

None beyond the findings above.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; the
planner's job is to revise the draft (or document accepted deviations)
before stories are written.
