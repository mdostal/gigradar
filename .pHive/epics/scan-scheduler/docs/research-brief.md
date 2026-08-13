# Research Brief: scan-scheduler

## 1. Summary

`Config.schedule` (a cron-expression string) has existed in the schema
since the very first epic — but nothing has ever actually read or
executed it. `npm run radar` is a one-shot CLI command; getting a
recurring scan today means the user manually re-running it. This epic
builds a real, standalone scheduler process that parses `Config.schedule`
and actually runs `runRadar()` on that cadence, plus the per-source
retry/backoff resilience explicitly deferred here by the
`adapter-batch-public-boards` epic's own design doc.

## 2. Key findings (live-checked, not assumed)

- Confirmed by direct grep: `Config.schedule` is read/written by the
  config UI (`config-client.tsx`) and nowhere else — no scheduler, no
  cron wiring, anywhere in the codebase today.
- Two real, current, zero-dependency cron-parsing libraries checked:
  `croner` (v10.0.1, TypeScript-native, explicit IANA-timezone support)
  and `node-cron` (v4.6.0). `croner`'s built-in timezone parameter is a
  direct fit — `Profile.timezone` already exists as a real, required
  field, and a schedule should fire in the user's own local time, not UTC.
- `Profile.timezone` (IANA, e.g. `"America/Chicago"`) is already
  collected and validated — no new config field needed for
  timezone-aware scheduling.
- `runner.ts`'s CLI entrypoint already has the source-registration
  pattern (dynamic imports inside `main()`, not top-level) a long-running
  scheduler process needs too — same reasoning as the CLI (register once
  at process/scheduler startup, not per-run, and definitely not at
  module top-level where it could collide with test doubles).

## 3. Patterns & conventions

- This project's established "long-running standalone process" shape is
  already set by `src/mcp/server.ts` — a separate entrypoint
  (`npm run mcp`), its own script, not integrated into the Next.js
  server. The scheduler follows the identical shape (`npm run scheduler`),
  not bolted onto the web app or Electron.
- `adapter-batch-public-boards`'s design doc explicitly named this gap:
  "Genuine retry/backoff SOPHISTICATION (exponential backoff, per-source
  rate budgets) is legitimately separate, larger scope — correctly
  deferred to the 'fancier cron' epic... which is about scheduling ACROSS
  sources." This epic is that deferred scope, now being built.
- The legacy tool used a macOS-specific `launchd` plist
  (`com.mdostal.gigradar.plist`) to keep its scheduler alive across
  restarts — OS-specific, not portable. This project's own established
  posture (electron-wrapper's explicit "terminal-launched, not a
  packaged installer" scope cut) suggests the same discipline here: this
  epic builds the portable, in-process scheduler LOOP; keeping that
  process alive across a machine restart (via `launchd`/`systemd`/Task
  Scheduler/just leaving a terminal open) is the user's own OS-level
  setup choice, documented but not built.

## 4. Constraints

- **Must not duplicate `runner.ts`'s CLI entrypoint's own scan logic** —
  the scheduler calls the exact same `runRadar(loadConfig())` path,
  wrapped in a cron trigger, not a second implementation.
- **A missing/invalid `Config.schedule` is not an error** — matches the
  existing "omitted = valid, not configured" pattern; the scheduler
  process should say so clearly and exit (or idle), not crash.
- **Per-source backoff state needs to persist ACROSS scheduler runs**
  (the whole point is resilience over a long-running process's lifetime)
  — in-memory state alone wouldn't survive a scheduler restart, but
  restarting the scheduler process is rare enough (vs. every scan cycle)
  that in-memory backoff state, reset on scheduler restart, is a
  reasonable v1 scope — a persisted-to-DB version is a possible later
  refinement, not required now.

## 5. Risks

- **Low — the scheduler running indefinitely with no supervisor could die
  silently** (an uncaught exception outside `runRadar()`'s own
  per-source try/catch) and the user wouldn't notice scans stopped.
  Mitigation: a top-level process-wide error handler that logs fatally
  and exits with a non-zero code (so an OS-level supervisor, if the user
  set one up, would know to restart it) rather than silently hanging in
  a broken state.
- **Low — exponential backoff needs sane bounds** (a minimum retry
  interval, a maximum backoff ceiling) so a persistently-failing source
  doesn't either hammer the target or effectively never retry again.

## 6. Open questions

1. `croner` or `node-cron`? Leaning: `croner` — native TypeScript types,
   explicit IANA-timezone parameter support (a direct fit for
   `Profile.timezone`), zero dependencies, actively maintained.
2. What are the exact backoff bounds? Leaning: exponential starting at
   the schedule's own base interval, capped at a reasonable ceiling
   (e.g. 24h) so a source failing for days doesn't retry every cycle
   forever, but also doesn't silently stop retrying altogether.
