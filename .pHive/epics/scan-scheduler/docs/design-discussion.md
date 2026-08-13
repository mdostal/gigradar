# Design Discussion: scan-scheduler

## 0. Prelude

**NORTH STAR**: "set up the loops, the crawling" — get gigradar actually
scanning on a real recurring cadence, not just when the user remembers to
run `npm run radar` by hand. Directly serves the broader "automate this
end to end" goal this session has been building toward.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern every prior query hit — disregarded).

## 1. What Are We Doing?

A new standalone `npm run scheduler` process: parses `Config.schedule`
(the cron-expression field that's existed since the first epic but has
never actually been read), fires `runRadar()` on that cadence in the
user's own local timezone (`Profile.timezone`), and adds the per-source
exponential-backoff resilience `adapter-batch-public-boards`'s own design
doc explicitly deferred to this epic — a source that starts failing
repeatedly backs off rather than getting hammered every single cycle.

"Done": `npm run scheduler` runs indefinitely, fires a real scan at the
configured cadence in the user's local time, logs each run's summary,
and a source that starts erroring doesn't get retried every cycle
forever — it backs off, with sane bounds, and recovers automatically once
it starts succeeding again.

## 2. What I Found

- `Config.schedule` has been dead code since the first epic — confirmed,
  nothing reads it anywhere except the config UI's own form.
- `croner` (zero dependencies, native TS, explicit IANA-timezone support)
  is a direct fit — `Profile.timezone` already exists as a real field, so
  a schedule should fire in the user's own local time, not UTC.
- `runner.ts`'s CLI entrypoint already has the exact source-registration
  pattern (dynamic imports at process-startup scope) a long-running
  scheduler needs — reused, not reinvented.
- `adapter-batch-public-boards`'s own design doc named this exact gap
  ("retry/backoff sophistication... correctly deferred to the 'fancier
  cron' epic") — this is that named, expected follow-on, not new scope
  invented from nothing.
- `src/mcp/server.ts` already establishes this project's "standalone
  long-running process, own npm script" shape — the scheduler follows
  the identical convention.

## 3. My Proposed Approach

1. **New dependency: `croner`** — resolves research brief open question
   #1. Zero dependencies, native TypeScript types, explicit timezone
   parameter (`Profile.timezone`).
2. **`src/scheduler/index.ts`** (new top-level directory, parallel to
   `src/mcp/`'s own shape) — on startup: registers the built-in source
   adapters ONCE (same pattern as `runner.ts`'s CLI `main()`), loads
   `Config` via `loadConfig()`. **Idles instead of exiting when unset
   (added post-grill, resolves H2 below)**: if `Config.schedule` is
   unset, logs that clearly and IDLES — rechecking every hour whether
   the config has since been set — rather than exiting immediately.
   Exiting fast right after startup risks being read as a crash by a
   process supervisor configured for "always restart" (systemd,
   `launchd`'s `KeepAlive`), producing restart-loop log noise; idling
   avoids that class of problem entirely and means a supervisor wired up
   BEFORE the user finishes configuring their schedule still behaves
   sanely. If `Config.schedule` IS set, schedules `runRadar()` via
   `croner`, passing `Profile.timezone` as the cron job's timezone.
   **Never writes to `config.json` (added post-grill, resolves H1
   below)**: the scheduler ONLY ever reads `Config` via `loadConfig()`
   and, for backoff filtering (§3 step 3), constructs a per-cycle
   IN-MEMORY variant — it never calls `saveConfig()` or writes to
   `config.json` under any circumstance. Stated explicitly here because
   this project has held a strict, repeatedly-enforced discipline
   against silently mutating the user's real config (`config-write-path`'s
   entire reason for existing) — a scheduler that ever persisted a
   backoff-driven `enabled: false` would silently and PERMANENTLY
   disable a source the user never asked to turn off.
3. **`src/scheduler/backoff.ts`** (new) — per-source exponential backoff
   state, IN-MEMORY for this epic (resolves research brief's constraint:
   persisting across a scheduler PROCESS RESTART, vs. across scan
   CYCLES within one long-running process, are different problems — this
   epic solves the latter, which is what actually matters for "don't
   hammer a failing source every cycle"). Resolves research brief open
   question #2: starts at the schedule's own base interval, doubles on
   each consecutive failure, capped at a 24-hour ceiling, resets to the
   base interval on the first success after a failure streak. A source
   in backoff is SKIPPED for that cycle (not attempted, not counted as a
   fresh failure) until its backoff window elapses — `runRadar()` itself
   is not modified; the scheduler filters which sources it passes to a
   given cycle's `Config.sources`, based on backoff state, before calling
   `runRadar()`.
4. **Top-level error boundary**: any uncaught exception outside a single
   scan cycle's own per-source try/catch (which `runRadar()` already has)
   logs fatally and exits non-zero — never silently hangs in a broken
   state. Each completed cycle logs a summary (gigs found/passed,
   per-source errors, current backoff states) to stdout, composable with
   whatever OS-level supervisor (launchd/systemd/Task Scheduler/a
   terminal left open) the user chooses to keep the process alive across
   a machine restart — that supervision choice is the user's own
   OS-level setup, documented but not built, matching
   `electron-wrapper`'s own established "terminal-launched, not a
   packaged installer/service" scope discipline.

## 4. What Could Go Wrong

- **Low — `croner`'s exact timezone-handling API needs live confirmation**
  during implementation (not assumed from documentation alone) — same
  "pin the real API" discipline `mcp-server-core`'s story already
  established for a different new dependency.
- **Low — backoff state is in-memory, reset on scheduler restart.**
  Accepted, explicit scope decision (§3 step 3) — a persisted-to-DB
  version is a reasonable later refinement, not required for this
  epic's actual goal (resilience within one long-running process's
  lifetime).
- **Low — this doesn't build OS-level process supervision** (keeping the
  scheduler alive across a machine restart) — explicitly the user's own
  setup choice, matching `electron-wrapper`'s precedent, not a silent
  gap. **A real starting point IS shipped, though (added post-grill,
  resolves U1 below)**: a documented, copy-pasteable macOS `launchd`
  plist template (`docs/scheduler-launchd-template.plist` or inline in
  `docs/ARCHITECTURE.md`, implementation's call) — mirroring the legacy
  tool's own proven, real precedent (`com.mdostal.gigradar.plist`,
  structural pattern only, no real personal values) and matching
  `agent-integration`'s own resolution to its analogous U1 finding (ship
  the actual copy-pasteable artifact, not just the mechanism). Full
  cross-platform process-supervision tooling (systemd unit files,
  Windows Task Scheduler XML) stays out of scope — one real, working
  example on the owner's own actual platform is the epic's bar, not
  exhaustive coverage of every OS.

## 5. Dependencies and Constraints

- New dependency: `croner`.
- Depends on `runRadar()`/`loadConfig()` (unmodified — the scheduler
  calls the exact same functions the CLI does) and `Profile.timezone`
  (already exists, no schema change needed).
- No new persisted state (backoff is in-memory for this epic, per §3
  step 3's explicit decision).

## 6. Open Questions

1. ~~croner or node-cron?~~ — **resolved**: `croner`, §3 step 1.
2. ~~Backoff bounds?~~ — **resolved**: exponential from the schedule's
   base interval, capped at 24h, resets on first success, §3 step 3.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/scan-scheduler/docs/grill-record.md`,
`unresolved_count: 3`) surfaced 3 findings, all resolved:

- **H1** (in-memory-only config handling not stated explicitly) —
  resolved in §3 step 2: stated plainly, `saveConfig()`/`config.json`
  writes are never touched by the scheduler under any circumstance.
- **H2** (exit-0-on-no-schedule could read as a crash to an
  always-restart supervisor) — resolved in §3 step 2: idles and
  rechecks hourly instead of exiting.
- **U1** (the epic's own "set up the loops" framing implied durable
  automation this epic's original scope didn't actually ship a path to)
  — resolved: a real, copy-pasteable macOS `launchd` template is now
  part of this epic's own deliverable, not left as an unassisted
  exercise.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest; croner (new dependency)
  Platforms: Node.js
  Automated: backoff.ts unit tests (exponential growth, 24h cap,
    reset-on-success, a source correctly skipped mid-backoff and
    correctly retried once its window elapses) — pure logic, no real
    timers needed if the clock is injectable/mockable. Scheduler startup
    tests: missing Config.schedule exits cleanly (not an error); a
    malformed cron expression produces a specific, actionable error, not
    a silent no-op. No live network dependency in the automated suite
    (matches this project's established convention) -- a scheduled
    runRadar() firing is tested via a mocked/short-interval cron trigger
    against fixture sources, not real scheduling delays.
  Manual: run `npm run scheduler` for real, with a short test cron
    expression (e.g. every minute) against the owner's real config,
    confirm real scans fire on schedule and a deliberately-broken source
    correctly backs off across consecutive cycles.
  Not verifying: OS-level process supervision (explicitly out of scope,
    §4); cross-scheduler-restart backoff persistence (explicitly
    in-memory only for this epic, §3 step 3).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~6-8 (src/scheduler/index.ts + backoff.ts + their
    tests, package.json script + dependency, docs/ARCHITECTURE.md update)
  Subsystems: new standalone scheduler process only — zero changes to
    src/lib/apply/runner.ts's actual scan logic, src/app, or src/mcp
  Migration required: no — purely additive
  Cross-team coordination: no
  Unknowns: 0 remaining (both open questions resolved above)

  RECOMMENDATION: Small-Medium, story-decompose directly, skip H/V
  RATIONALE: This is a focused, well-understood addition — a cron
    trigger wrapping an already-proven scan function, plus a contained
    backoff module. No structural unknowns remain. A single story
    covering both the scheduler entrypoint and the backoff logic is
    appropriate given how tightly coupled they are (the scheduler IS the
    backoff logic's only caller) — splitting them would add ceremony
    without a real independence benefit.
```
