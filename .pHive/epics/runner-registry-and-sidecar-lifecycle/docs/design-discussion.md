# Design Discussion: runner-registry-and-sidecar-lifecycle

## 0. Prelude

Two real bugs, both found live this session, both root-caused by direct code
reading (not guessed). Small scope — proceeding straight to stories.

## 1. Bug 1: "no such registered source" on Retry now

**Confirmed live:** clicking "Retry now" for `fractionus` (a real, valid,
already-registered adapter — `src/lib/sources/fractionus.ts` exists with
`id: "fractionus"` and its own `registerSource(fractionusSource)` call)
returned "Still failing: no such registered source".

**Root cause:** every adapter (`braintrust`, `builtin`, `gofractional`,
`ateam`, `fractionaljobs`, `fractionus`, `fractionalfinders`, `wellfound`,
`linkedin`) calls `registerSource(...)` as a MODULE-LOAD side effect.
`getSource(id)` (`src/lib/sources/source.ts`) only finds an adapter if that
module was imported at some point in the current process. Three existing
entry points each do their own bootstrap before ever calling `runRadar()`:

- `src/lib/apply/runner.ts`'s CLI `main()` — dynamic `import()` calls,
  deliberately deferred into a function (not top-level) because
  `runner.test.ts` imports `runRadar()` directly and registers its own
  network-free test-double sources under the SAME ids (e.g. `"braintrust"`)
  — a top-level static import there would collide with "duplicate source
  id".
- `src/scheduler/index.ts` — same dynamic-import pattern, same reasoning.
- `src/mcp/server.ts` — plain top-level static imports (no test-collision
  risk there, standalone process).

`retrySourceAction` (`src/app/issues/actions.ts`, added earlier this
session) calls `runRadar()` DIRECTLY from a Next.js Server Action — but the
Next.js app-server process has never had its own registration bootstrap.
Confirmed by grep: zero `import("../sources/...")` calls anywhere under
`src/app/`.

**Compounding testing gap:** `src/app/issues/__tests__/actions.test.ts`'s
`retrySourceAction` tests mock `@/lib/apply/runner`'s `runRadar` export
entirely, so the suite never exercises the real `getSource()` registry
lookup that's actually broken. `npm test` passed the whole time because the
mock assumed the registry problem away.

**Fix:** extract the shared list of 9 dynamic adapter imports into one new
module, `src/lib/sources/register-all.ts`, exporting `async function
registerAllSources(): Promise<void>`. Must keep using dynamic `import()`
(not static top-level imports) to preserve `runner.test.ts`'s existing
test-double-collision-avoidance property. Node's ES module cache makes
repeated `import()` calls within one process idempotent (a module's
top-level code runs once regardless of how many times it's imported) — no
manual "already registered" flag needed. Wire it into: `retrySourceAction`
(the actual bug — call before `runRadar()`), and refactor `runner.ts`'s
`main()` and `scheduler/index.ts` to use the shared helper instead of each
maintaining their own hand-copied list. `mcp/server.ts`'s static top-level
imports stay as-is — migrating a static-import file to a dynamic-import
shared helper changes its module-load timing semantics for no real benefit
there, and it has no collision risk to solve.

**Test fix:** add a real (non-mocked-`runRadar`) test for
`retrySourceAction` that registers a lightweight network-free test-double
source under a test-only id (mirroring `runner.test.ts`'s own existing
pattern) and proves retry genuinely resolves against the real registry.

## 2. Bug 2: orphaned Node sidecar process after quitting/killing gigradar

**Confirmed live:** after killing the running `.app`'s Tauri process
(`pkill -f ".../MacOS/app"`), its spawned Node sidecar (the actual
Next.js server, holding port 3000) kept running as an orphan — process
group membership was never established, and nothing ever explicitly killed
the child. `lib.rs`'s own existing comment claims "Tauri kills child
processes on app.exit() by default" — checked against the vendored
`tauri`/`tauri-plugin-shell` crate sources directly: `CommandChild` has no
`Drop` impl that kills the OS process, and the `.run(tauri::generate_context!())`
call site (no event callback) never intercepts any exit event to clean up.
The comment's claim doesn't hold.

**User's own framing:** "if that is gigradar we need to fix that so it runs
as part of the app so the user isn't having weird processes they
accidentally killed."

**Fix, two layers (the second solving a case the first structurally
cannot):**

1. **Graceful-exit cleanup (Rust).** Switch `lib.rs`'s `.run(...)` call to
   the `.build(...)?.run(|app, event| ...)` form, store the spawned
   `CommandChild` in managed state, and call `.kill()` on it when
   `RunEvent::Exit` fires. `RunEvent::Exit` fires for every
   Tauri-originated shutdown: closing the window, Cmd+Q, the tray's Quit
   item, and the updater's own `app.restart()` (this epic's earlier
   `install_update`/grace-period-timeout paths). This covers the
   overwhelmingly common real-world case — a user quitting the app
   normally.

2. **Orphan self-detection (Node, belt-and-suspenders).** A `RunEvent`
   handler cannot run for an external `SIGKILL`/force-quit sent directly to
   the OS process (uncatchable by definition) — which is exactly what
   *this session's own* `pkill` did to produce the orphan actually
   observed. The robust fix for that case has to live on the CHILD side:
   the spawned sidecar polls whether its recorded parent PID is still
   alive (`process.kill(ppid, 0)` — signal 0 checks liveness without
   sending a real signal, throws `ESRCH` once that PID no longer exists)
   and self-exits if not. Gated on a new `GIGRADAR_PARENT_PID` env var so
   this only activates when actually spawned as a GUI child (Tauri or
   Electron) — a plain `npm run dev`/`npm run start` terminal session
   never sets it, so normal Ctrl+C/shell job-control behavior is
   unaffected. Wired from both `src-tauri/src/lib.rs` (the sidecar spawn
   already in place) and `electron/main.ts` (which has the identical
   "cleanup only runs on graceful Electron quit" limitation as the Tauri
   side did before layer 1 — same fix, same reasoning, applied uniformly
   rather than fixing only the Tauri half of an identical problem).

## 3. Scale

Small — four independently-shippable stories, no cross-story sequencing
beyond registry-fix before its own test, and sidecar-cleanup before
orphan-self-detection (the second is genuinely a belt-and-suspenders
addition to the first, not a hard dependency, so both are listed but the
detection story does not block on the cleanup story's own completion).
Proceeding directly to story decomposition.

## 4. Risks

- Killing the sidecar on every `RunEvent::Exit` must not fire during the
  updater's own `app.restart()` in a way that races the restart itself —
  `app.restart()` is documented as terminating the whole process and
  re-launching; `RunEvent::Exit` firing during that teardown and killing
  the (already-being-replaced) sidecar is the CORRECT behavior, not a
  conflict, since a fresh sidecar spawns on the new process's own startup.
- The orphan self-detection poll interval must be coarse enough not to add
  meaningful CPU/wake overhead to a long-running desktop app (proposed: 10s
  — frequent enough that an orphan doesn't linger long, cheap enough to be
  invisible).
