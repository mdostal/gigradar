# Design Discussion: electron-wrapper

## 0. Prelude

**NORTH STAR**: "we can choose to run in browser or in electron when we
setup on the machine" — a runtime-mode choice for a developer/technical
setup on a machine that already has the project's existing prerequisites
(Node 22+), not a packaged installer for an end user with nothing
installed.

No relevant prior decisions in the shared KG beyond this project's own
epics (same cross-project noise pattern every prior query hit — disregarded).

## 1. What Are We Doing?

Add Electron as an optional runtime mode: `npm run electron` opens
gigradar as a native desktop window, alongside the existing (unchanged)
`npm run dev`/`start` browser mode. The Electron main process does NOT
run server code itself — it spawns the exact same `next start` command
as a genuine child process (using the system's own Node, the same
requirement the app already has today), waits for it to be ready on
`127.0.0.1:3000`, opens a `BrowserWindow` pointing at it, and kills the
child process cleanly on quit.

"Done": `npm run build && npm run electron` opens a native window showing
the real, working dashboard — same app, same local data, same encryption,
just a different shell. `npm run dev`/`start` (browser) keep working
exactly as before, completely unmodified.

**Explicitly NOT in scope**: packaged installers (.dmg/.exe/.AppImage),
code signing, auto-update, or bundling a portable Node runtime for
non-technical end users. That's a materially larger, separate epic if
ever wanted — noted here so it's a deliberate cut, not a silent gap.

## 2. What I Found

- This app cannot be statically exported (Server Actions + `node:sqlite`)
  — confirmed via `next.config.js`/`package.json`. Any Electron approach
  needs a real running Node server.
- Electron's bundled Node runtime version tracks its own release (Electron
  37 → Node 22-line, matching this project's requirement) — but whether
  its embedded main-process runtime honors `--experimental-sqlite` the
  same way a plain `node` invocation does was NOT verifiable without
  actually launching a real Electron app (needs a GUI/display, not
  available during planning research).
- **The risk above is sidestepped architecturally, not left open**:
  server code never runs inside Electron's own process. The main process
  only spawns the EXISTING `next start` command as a subprocess (system
  Node, same as today) and displays its output in a window — Electron's
  own bundled runtime's flag support becomes irrelevant.
- `-H 127.0.0.1` binding (already in place) is a direct fit for this
  spawn-then-load architecture — no changes needed there.
- Local data resolution (`os.homedir()`-based XDG paths) is completely
  unaffected by which shell displays the UI — zero changes needed to
  `src/lib/store`, `src/lib/security`, or `src/lib/config`.

## 3. My Proposed Approach

1. **New `electron/main.ts`** (new top-level `electron/` directory,
   parallel to `src/`, matching Electron's own convention of a separate
   main-process entry point outside the renderer's source tree):
   - On launch: `child_process.spawn("npm", ["run", "start"], {env:
     {...process.env, NODE_OPTIONS: "--experimental-sqlite"}})` — the
     EXACT existing `start` script, not a reimplementation. **Environment
     inheritance stated explicitly (added post-grill, resolves H1
     below)**: `npm run electron` is a TERMINAL-launched command for this
     epic — it inherits a normal shell's `PATH` (where `node`/`npm` are
     already resolvable, the same requirement `npm run dev`/`start`
     already have today), so the spawned child correctly finds `npm` and
     Playwright's own browser-launch needs (used by Capture Login) are
     unaffected. A double-clickable packaged app (explicitly out of scope,
     §1) would NOT get this for free — GUI-launched apps often get a far
     more minimal `PATH` — and would need explicit environment-passing
     (e.g. a `fix-path`-style fix) if ever built later. Named here so it's
     a known, deliberate constraint, not a silently-inherited assumption.
   - Poll `http://127.0.0.1:3000` (a simple retry loop, short interval,
     bounded total wait) until it responds, THEN create the
     `BrowserWindow` — never load before the server is actually ready.
   - **Port conflict handling (resolves research brief open question #2,
     hardcoded 3000)**: if the spawn/poll step detects the port is
     already bound by something else (e.g. a concurrent `npm run dev`),
     surface a clear, actionable native dialog ("port 3000 is already in
     use — stop the other gigradar process first") rather than hanging
     indefinitely or silently failing.
   - On window close / app quit: kill the spawned child process
     (`child.kill()`), so no orphaned `next start` squats on the port for
     the next launch.
2. **`npm run electron` script composes the build in, resolving research
   brief open question #1 differently than originally leaning (changed
   post-grill, resolves U1 below)**: `npm run build && electron
   electron/main.ts` — ONE command, always freshly built, never a
   separate two-step ritual to remember. The original leaning ("require a
   prior `npm run build`," matching `start`'s existing two-step pattern)
   created a real, likely footgun: this project's actual, demonstrated
   development pattern all session has been iterative `npm run dev`
   (hot-reload) — a developer switching to Electron mode without
   remembering to rebuild first would see silently stale code. Composing
   the build into the one command trades a few extra seconds of launch
   time for removing that entire class of confusion — the right tradeoff
   for a mode meant to be switched into casually, per the owner's own
   framing ("choose to run in browser or electron when we set up").
3. **`electron` added as a devDependency** — not a runtime dependency,
   since it's a local development/packaging tool, not something the
   deployed Next.js server itself needs.

## 4. What Could Go Wrong

- **Medium — the "server never runs inside Electron's own process"
  architectural decision needs live confirmation**, not just sound
  reasoning. First implementation step must actually launch the real
  Electron app and confirm the spawned `next start` child correctly loads
  `node:sqlite` and the dashboard renders with real data — not merely
  assumed to work because the reasoning is sound.
- **Low — an orphaned child process** if the main process crashes instead
  of exiting cleanly (SIGKILL vs. graceful `app.on("window-all-closed")`)
  — mitigated by also handling `app.on("before-quit")` and process signal
  handlers, not just the happy-path close event.
- **Low — this doesn't build packaged installers**, explicitly named as
  cut scope in §1, not a silent gap.

## 5. Dependencies and Constraints

- New devDependency: `electron`.
- Depends on nothing from other epics changing — purely additive, spawns
  the EXISTING `build`/`start` scripts unmodified.
- Requires the same Node 22+ prerequisite the project already has via
  `npm run dev`/`start` — no new system requirement introduced.

## 6. Open Questions

1. ~~Build-then-launch vs. build-on-every-launch?~~ — **resolved**:
   require a prior `npm run build`, matching the existing pattern, §3
   step 3.
2. ~~Hardcoded port vs. dynamic?~~ — **resolved**: hardcoded 3000 for v1,
   with a clear conflict error rather than silent failure, §3 step 1.

## 6a. Grill Findings Addressed

Grill round 1 (`.pHive/epics/electron-wrapper/docs/grill-record.md`,
`unresolved_count: 2`) surfaced 2 findings, both resolved:

- **H1** (unstated environment-inheritance assumption for the spawned
  child process) — resolved in §3 step 1: explicitly stated as a
  terminal-launched constraint for this epic, with double-click/packaged
  launch named as a known future risk, not silently assumed to work.
- **U1** (build-required-first vs. this session's actual dev-iteration
  workflow) — resolved in §3 step 2: `npm run electron` composes the
  build into one command instead of requiring a separate, easy-to-forget
  manual rebuild step.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest for any pure-logic pieces (port-polling retry logic);
    manual launch for the actual Electron app (no automated Electron UI
    test harness exists in this repo, and adding one is disproportionate
    to this epic's scope)
  Platforms: macOS (the owner's actual machine) — Windows/Linux Electron
    behavior not verified in this epic, same "verified on what's actually
    available" discipline as every prior epic's manual-verification step
  Automated: unit test the port-ready polling/retry logic in isolation
    (a fake HTTP server standing in for the spawned child) — covers the
    ready-detection and the timeout/conflict-error path without needing a
    real Electron process in the automated suite.
  Manual: npm run build && npm run electron on the owner's real machine —
    confirm a native window opens, the real dashboard renders with real
    data (the same DB this session has been populating), Capture Login
    still opens a real headed browser correctly from within the Electron
    context, and closing the window cleanly stops the spawned server
    process (verified via `ps`/Activity Monitor, not just visually).
  Not verifying: Windows/Linux Electron behavior; packaged installers
    (explicitly out of scope, §1).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~4-6 (electron/main.ts + its test for the polling
    logic, package.json script + devDependency, README/CLAUDE.md note)
  Subsystems: new electron/ entry point only — zero changes to src/lib,
    src/app, or src/mcp
  Migration required: no — purely additive, existing browser mode
    completely unchanged
  Cross-team coordination: no
  Unknowns: 0 remaining in the DESIGN (both open questions resolved); one
    real runtime behavior (does the spawned-child architecture actually
    work end to end) needs live verification during implementation, not
    left as an open design question

  RECOMMENDATION: Small, single story, skip H/V
  RATIONALE: One new entry point, spawning existing, already-working
    scripts. The architectural decision that de-risks this (never run
    server code inside Electron's own process) is already made and
    reasoned through in this document, not deferred to execution. No
    structural unknowns remain — only a live-verification step, which is
    normal implementation work, not a planning gap.
```
