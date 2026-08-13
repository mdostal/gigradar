# Grill Record — scan-scheduler

**Source draft:** .pHive/epics/scan-scheduler/docs/design-discussion.md
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

No findings. "Cycle," "backoff," and "scheduler" are used consistently
throughout, no mid-document shift.

## Hidden assumptions

- **H1** — §3 step 3's per-source backoff filtering ("the scheduler
  filters which sources it passes to a given cycle's `Config.sources`,
  before calling `runRadar()`") never states explicitly that this
  filtering operates on an IN-MEMORY COPY of the loaded `Config`, never
  written back to `config.json`. This project has held a strict,
  repeatedly-enforced discipline against silently mutating the user's
  real config (`config-write-path`'s entire reason for existing;
  `saveConfig()`'s validate-before-write guarantee) — a scheduler that
  ever persisted a backoff-driven `enabled: false` to the real
  `config.json` would silently and PERMANENTLY disable a source the user
  never asked to turn off, exactly the class of bug this project has
  been careful to prevent everywhere else.
  - Draft location: §3 step 3 (backoff filtering, no explicit
    in-memory-only statement)
  - Why this matters: an implementer without this stated explicitly
    could reasonably reach for the existing `saveConfig()` path (it's
    right there, already built) to "persist" the filtered state, which
    would be exactly the wrong, silently-destructive choice.
  - Question for planner: should the design state explicitly that the
    scheduler only ever reads `Config` via `loadConfig()` and constructs
    a per-cycle in-memory variant for `runRadar()` — never calling
    `saveConfig()` or writing to `config.json` under any circumstance?

- **H2** — §3 step 2's "if `Config.schedule` is unset, logs that clearly
  and exits 0" doesn't consider how this interacts with a process
  supervisor configured for "always restart" semantics (systemd,
  launchd's `KeepAlive`, etc.) — a fast, clean exit immediately after
  startup could be interpreted as a crash loop by such a supervisor,
  producing repeated restart-log noise, depending on the supervisor's own
  configuration (outside this epic's control, per the already-accepted
  "OS-level supervision is the user's own setup" scope cut).
  - Draft location: §3 step 2
  - Why this matters: this is a real, if minor, operational edge case a
    user setting up OS-level supervision (which the design's own scope
    cut anticipates they might do) would hit immediately if they forget
    to set `Config.schedule` first.
  - Question for planner: is exit-0-immediately the right behavior
    (simple, matches "not configured = not an error"), or should the
    process instead idle/wait (e.g., poll for the config becoming set,
    or just document the exit-0 behavior clearly enough that a user
    reads it before wiring up a supervisor)?

## Unresolved tensions

- **U1** — The epic's own §0 north star quotes the owner's literal words:
  "set up the loops, the crawling" — naturally read as wanting durable,
  hands-off automation. But §4 explicitly scopes OS-level process
  supervision (keeping the scheduler alive across a machine restart) as
  "the user's own setup, documented but not built" — and the research
  brief's own reference to the legacy tool's real, proven `launchd`
  plist is never turned into an actual template/starting point for THIS
  project, just cited as historical context. This is the same shape of
  gap grill has caught twice already this session
  (`profile-overview-ingestion`'s U1, `agent-integration`'s U1): an
  epic's own "Done" bar not actually getting the user to the durable,
  working state their own request implied, even though the mechanism
  underneath is real and working.
  - Draft location: §0 (north star quote), §4 ("OS-level process
    supervision... explicitly out of scope")
  - Tension: "set up the loops" (implies durable, survives-a-restart
    automation) vs. "this epic stops at a process that runs while it's
    running, with zero provided starting point for actually keeping it
    alive long-term."
  - Question for planner: should this epic include a documented,
    copy-pasteable starting template for at least ONE common supervisor
    (macOS `launchd`, matching the legacy tool's own proven precedent and
    this being the owner's real machine) — mirroring how
    `agent-integration`'s own U1 resolution ended up shipping a real,
    copy-pasteable MCP client config rather than just the mechanism?

## Convention violations

No findings. The scheduler's standalone-process shape matches
`src/mcp/server.ts`'s already-established convention exactly; source
registration reuses `runner.ts`'s CLI pattern rather than reinventing it.

## Posture mismatches

No findings. Fully local, no new network exposure or telemetry.

## Notes

None beyond the findings above.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings. Each finding above ends with a question for the planner; revising
the draft (or documenting accepted deviations) is the next step, owned by
design-discussion, not by this record.
