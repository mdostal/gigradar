# Grill Record — electron-wrapper

**Source draft:** .pHive/epics/electron-wrapper/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — research-brief.md has no such field; used its Risks/Open Questions sections as focusing input instead)
**round_number:** 1
**unresolved_count:** 2

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 1 finding
- Unresolved tensions: 1 finding
- Convention violations: clean
- Posture mismatches: clean

## Vocabulary mismatches

No findings. "Main process," "renderer," "child process" are used
consistently with standard Electron terminology and don't conflict with
any CONTEXT.md definition.

## Hidden assumptions

- **H1** — §3 step 1's `child_process.spawn("npm", ["run", "start"], ...)`
  assumes the Electron process's own environment (PATH, and transitively
  anything the spawned `next start` process itself needs, e.g.
  Playwright's browser-binary resolution for the "Capture Login" feature
  §7 separately calls out for manual verification) is complete enough for
  `npm` to be found and for the spawned server to behave identically to a
  terminal-launched one. This is a well-known Electron gotcha: a
  GUI-launched app (double-clicked, not started from a terminal) often
  gets a much more minimal `PATH` than a terminal session — frequently
  missing an `nvm`-managed `node`/`npm` entirely. The design's own launch
  model (`npm run build && npm run electron`, terminal-invoked) likely
  sidesteps this in practice, but the draft never states this constraint
  explicitly, and doesn't address the second-order risk: if `npm run
  start` genuinely doesn't inherit the full environment, Playwright's own
  browser launch (used by session-capture.ts, already flagged for manual
  verification in §7) could silently break too, for the same root cause.
  - Draft location: §3 step 1 (the spawn call), §7 (Capture Login flagged
    for manual verification without connecting it to this same risk)
  - Why this matters: if this ever gets packaged as a double-clickable
    app later (explicitly out of scope now, but named as a future
    extension in §1), this exact assumption would silently break —
    worth stating the constraint now so it's not rediscovered the hard
    way later.
  - Question for planner: should the design state explicitly that
    `npm run electron` is a TERMINAL-launched command for this epic
    (inheriting a normal shell's PATH), with double-click/packaged launch
    explicitly named as a known future risk requiring explicit
    environment-passing (e.g. `fix-path` or an equivalent), rather than
    left implicit?

## Unresolved tensions

- **U1** — §3 step 3 requires a prior `npm run build` before `npm run
  electron` (production `next start` semantics). But this project's
  entire active-development pattern THIS SESSION has been iterative
  `npm run dev` (hot-reload, auto-rebuilding on every file change) — the
  owner has been building and testing epic after epic that way. If
  someone switches to Electron mode without remembering to rebuild first,
  they'd see STALE code (whatever the last `npm run build` produced), not
  their latest changes — a real, recurring friction point given the
  owner's own stated intent to "choose to run in browser or electron when
  we set up," which reads as wanting easy, frequent switching, not a
  one-time choice made once and never revisited.
  - Draft location: §3 step 3 ("Requires a prior `npm run build`")
  - Tension: "matches the existing build/start split exactly, no new
    behavior invented" (the draft's own stated rationale) vs. the owner's
    actual, demonstrated workflow this session being dev-mode iteration,
    where a forgotten rebuild before switching to Electron mode produces
    a confusing stale-code experience.
  - Question for planner: is "always run `npm run build` first, an
    accepted, explicitly-documented tradeoff for v1" sufficient (simplest,
    matches existing scripts, just needs to be stated as a conscious
    choice rather than left to be discovered) — or does this epic need a
    dev-mode Electron variant (spawning `next dev` instead of `next
    start`) so switching modes doesn't require remembering a manual
    rebuild step?

## Convention violations

No findings. `electron/` as a new top-level directory doesn't touch
`src/lib`/`src/app`, and the new `npm run electron` script fits the
existing flat script-naming convention (`dev`/`build`/`start`/`radar`/
`mcp`) without introducing a new pattern.

## Posture mismatches

No findings. The design stays fully local (spawns the existing local
server, no new network exposure, no telemetry) — consistent with every
prior epic's stated posture.

## Notes

This is a deliberately thin grill pass, matching the design doc's own
scale assessment ("Small, single story") — a small, low-risk, mostly-
orchestration epic doesn't warrant manufacturing findings to hit a
target count. Two real, concrete findings is the honest result here.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
