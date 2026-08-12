# Research Brief: electron-wrapper

## 1. Summary

Add Electron as an OPTIONAL runtime mode alongside the existing browser
mode — `npm run dev`/`start` (browser, unchanged) vs. a new `npm run
electron` (native window) — chosen at setup time on the developer's own
machine, per the owner's framing. Scoped to a runtime-mode choice for this
epic, NOT packaged installers (.dmg/.exe/.AppImage) — that's a materially
bigger, separate lift (code signing, notarization, auto-update) not asked
for here; noted as a clean future extension, not silently promised.

## 2. Key findings (live-checked, not assumed)

- **This app cannot be statically exported.** It uses Server Actions and
  `node:sqlite` (`--experimental-sqlite`, a Node runtime flag) —
  confirmed via `next.config.js`/`package.json`'s scripts and
  `src/lib/store/db.ts`. Any Electron approach MUST run a real Node
  server process, not load static files.
- **Electron bundles its own Node runtime, version-tied to the Electron
  release** (confirmed: Electron 37's own `@types/node` devDependency is
  `^22.7.7`, matching this project's Node 22 requirement for `node:sqlite`
  — a good sign, but NOT the same as confirming the specific
  `--experimental-sqlite` flag is honored inside Electron's own embedded
  main-process runtime, which boots differently than a plain `node`
  binary invocation. This was NOT verifiable without actually launching a
  real Electron app (needs a GUI/display) — flagged as a real
  implementation-time risk, not silently assumed to work.
- **The architectural fix that sidesteps this risk entirely**: don't run
  server code inside Electron's own main-process runtime at all. Instead,
  Electron's main process SPAWNS the exact same `next start` command
  (`child_process.spawn`, using the SYSTEM's own `node` binary — the same
  one `npm run dev`/`start` already require today, with `NODE_OPTIONS`
  passed explicitly to that child process) as a genuine subprocess, waits
  for it to respond on `127.0.0.1`, then opens a `BrowserWindow` pointing
  at that URL. This decouples Electron's bundled runtime entirely from
  the app server's Node requirements — it's the exact same server process
  that already works today, just launched and displayed differently.
- `package.json`'s existing `dev`/`start` scripts already bind to
  `-H 127.0.0.1` — a direct architectural fit for "spawn it locally, load
  it in a window," no changes needed there.

## 3. Key files & surfaces

- `package.json` — `dev`/`start`/`build` scripts, the exact commands the
  Electron main process spawns as a child process.
- `next.config.js` — confirms Server Actions + `node:sqlite`, why static
  export is off the table.
- `src/lib/store/path.ts` / `security/key-path.ts` — `os.homedir()`-based
  XDG resolution, entirely unaffected by whether the server runs under
  plain Node or as an Electron-spawned child process — the local-data
  story doesn't change at all for this epic.

## 4. Constraints

- **Requires the SAME system Node/npm the app already requires today**
  (Node 22+, for `node:sqlite`) — this epic does NOT bundle a portable
  Node runtime inside the Electron app (that's the packaging/distribution
  scope explicitly cut, §1). "Choose to run in browser or Electron when
  we set up on the machine" (the owner's own framing) matches this: a
  developer/technical setup on a machine that already has Node, not a
  signed installer for a non-technical end user with nothing installed.
- Must NOT duplicate the server-spawning logic `npm run start`/`build`
  already encode — the Electron main process should shell out to the
  EXISTING npm scripts, not reimplement "build then start" itself.
- The spawned child process needs a clean shutdown path (killed when the
  Electron window closes) — an orphaned `next start` process left running
  after the app quits would silently squat on the port for the next
  launch.

## 5. Risks

- **Medium — unverified whether Electron's main process needs its OWN
  `--experimental-sqlite` handling at all.** Resolved architecturally
  (§2): it doesn't, because server code never runs inside Electron's own
  process — only in the spawned child. This should still be confirmed by
  actually launching the real Electron app during implementation, not
  left as untested reasoning.
- **Low — port conflicts.** If port 3000 is already in use (e.g. the
  developer also has `npm run dev` running), the spawned child would fail
  to bind. Needs a clear, actionable error, not a silent hang.
- **Low — first launch requires a `next build`** (production `next start`
  needs a prior build) — needs to be either a documented prerequisite
  step or run automatically by the Electron launch script before spawning
  `next start`.

## 6. Open questions

1. Does `npm run electron` build automatically on every launch (simpler,
   slower startup) or require a separate `npm run build` step first
   (faster subsequent launches, matches how `next start` already works
   today)? Leaning: require a prior build, matching the existing
   `build`/`start` split exactly — no new behavior invented.
2. What port does the spawned server use — hardcoded 3000 (matches
   today's dev default) or dynamically chosen to avoid conflicts?
   Leaning: hardcoded 3000 for v1 (simplicity, matches what a developer
   already expects from `npm run dev`/`start`), with a clear error if
   it's already taken rather than silent failure.
