# Design Discussion: tauri-installer

## 0. Prelude

**NORTH STAR**: a true, 1-click installer a non-technical person (owner's
own example: "a CFO or a BA") can download, run, and use gigradar from —
no Node, no npm, no terminal, no manual setup of any kind. Owner's exact
words (2026-08-14): "the second we do the true 1 click installer, we need
to bundle everything in it, no other bullshit... it has to full bundle
without bullshit setup by the average worker." Paired with a real
dev/prod auto-update mechanism: dev builds ship first, a prod release is
cut from a dev build once proven, and the installed app can be toggled
between tracking the dev or prod channel locally.

Explicitly NOT replacing the existing `electron-wrapper` epic's
terminal-launched `npm run electron` mode — owner's own words: "while it
is alpha or dev, we can have people start it however." That mode stays
exactly as it is, for the owner's own continued dogfooding and anyone
comfortable with a terminal. This epic is the SEPARATE, later, polished
path for real end-user distribution.

**Framework decision, already made this session, not re-litigated here**:
Tauri, not Electron, for this specific installer. Electron was the right
call for the terminal-launched dev mode (matches this project's existing
Node-based tooling with zero new toolchain), but once "average non-
technical worker installs it" is the actual bar, Tauri's sidecar
mechanism (bundling arbitrary binaries cleanly per-platform), smaller/
more polished installer output, and first-party updater plugin win.

## 1. What Are We Doing?

1. **A packaged, double-clickable Tauri app** for macOS (owner's own
   platform, ship first) — Windows/Linux explicitly deferred to a follow-
   on story once the macOS path is proven, not attempted simultaneously.
2. **Full bundling, no external dependency**: a real Node.js binary
   (chosen/pinned by us, not relying on system Node) bundled as a Tauri
   sidecar, spawning gigradar's own built Next.js server exactly the way
   `electron/main.ts` already does today (same "server code never runs
   in the app's own process" discipline) — just with a bundled Node
   instead of the system's. Playwright's Chromium (needed for Capture
   Login and every `browser-session`-auth adapter) bundled as a second
   sidecar/resource, not downloaded on first run.
3. **Real auto-update**: Tauri's official updater plugin, two channels
   (dev/prod) via two separate update-manifest endpoints hosted on
   GitHub Releases, with an in-app toggle for which channel the local
   install tracks.
4. **A real, generated update-signing keypair** (Tauri's updater
   mandates this — cannot be disabled) — the private key's storage/
   custody is the owner's own responsibility to establish, flagged as an
   explicit dependency below, not something this epic can decide FOR
   him.

Explicitly NOT in scope for this epic's first pass: Windows/Linux
builds; OS-level code signing/notarization (a real, separate cost/
account the owner needs to decide on — see Open Questions); replacing
or removing the existing Electron dev-mode wrapper.

## 2. What I Found

- `electron/main.ts` already establishes the exact process-spawning
  discipline this epic reuses: spawn the built server as a real child
  process, poll for readiness (`electron/server-ready.ts`), point a
  window at it once ready, never run server code in the shell's own
  process. That file's own header comment explicitly calls out it's
  "terminal-launched, not a double-clickable packaged app (explicitly
  out of scope for this story)" — this epic is exactly that deferred
  scope.
- Tauri v2's sidecar mechanism (`externalBin` in `tauri.conf.json`)
  bundles an arbitrary per-platform binary (target-triple-suffixed,
  e.g. `node-aarch64-apple-darwin`), invoked at runtime via
  `Command.sidecar()` — this is the real, current mechanism (verified
  live against Tauri's own v2 docs during this story, not assumed from
  training data). A real Node binary bundled this way, spawning
  gigradar's OWN built server.js as an argument, sidesteps ever needing
  to compile the Next.js app into a single executable — same "spawn a
  real child process" shape `electron/main.ts` already uses, just with
  a bundled Node instead of the system's.
- Tauri v2's updater plugin (live-verified) requires a generated
  signing keypair (public key embedded in `tauri.conf.json`, private
  key used at build time via `TAURI_SIGNING_PRIVATE_KEY`) — this is
  MANDATORY, cannot be skipped, and losing the private key means
  existing installs can never receive another update. GitHub Releases
  is an explicitly supported/recommended hosting backend for the
  update manifest JSON + artifacts.
- Channel switching is done by the app choosing which update-manifest
  endpoint URL to check at runtime (a plain config value, e.g. a stored
  local preference) — not a built-in "channels" primitive, but a
  straightforward pattern the docs themselves demonstrate (dev vs.
  stable endpoint strings).
- No Tauri/Rust toolchain exists anywhere in this repo today — this is
  a genuinely new dependency surface (Rust, `cargo`, Tauri CLI), not an
  incremental addition to the existing all-TypeScript stack.
- `node:sqlite` needs `--experimental-sqlite` and a specific-enough Node
  version — bundling our OWN chosen Node binary (rather than relying on
  a packaged runtime like Electron's) actually resolves the exact
  uncertainty `electron/main.ts`'s own header comment flagged ("sidesteps
  ever needing to know whether Electron's own bundled Node honors
  `--experimental-sqlite`") — we control the bundled binary directly now.

## 3. My Proposed Approach

### 3.1 Two sidecars, not one

- **Sidecar 1 — Node + gigradar server**: bundle a real, pinned Node.js
  binary (matching this repo's target Node major version) as a Tauri
  `externalBin`. At launch, the Rust side spawns it with the built
  `.next`/server output as an argument (mirrors `npm run start`'s own
  invocation, `NODE_OPTIONS=--experimental-sqlite` passed as an env var
  to the spawned process), polls `http://127.0.0.1:3000` for readiness
  (reuses `electron/server-ready.ts`'s own polling logic, ported to
  Rust or kept as a small bundled Node readiness-check script — TBD,
  see Open Question 1), then loads that URL into the Tauri webview.
- **Sidecar 2 — Playwright's Chromium**: bundled as app resources (not
  a sidecar binary per se, since it's not directly executed by Tauri's
  shell plugin — Playwright itself launches it) with
  `PLAYWRIGHT_BROWSERS_PATH` pointed at the bundled location so
  `browser-session.ts`'s `launchHeadedBrowser()` finds it without ever
  hitting the network for a first-run download.

### 3.2 Data/config paths unchanged

`src/lib/store/path.ts`/`src/lib/config/load.ts`'s existing
`XDG_DATA_HOME`/platform-fallback resolution needs NO change — a
packaged app still writes to the same `~/.local/share/gigradar` (or
platform equivalent) real user-data location this project already
uses. This is a real, load-bearing design win already baked into this
codebase from earlier epics (`docs/ARCHITECTURE.md`'s "never `./data`
or any path inside the repo" rule) — nothing about packaging changes it.

### 3.3 Update channels

`Config`-adjacent, but deliberately NOT inside `config.json` (that file
is the user's own gigradar Config, not app-installer metadata) — a
separate small local preference file (e.g.
`<data-dir>/../update-channel.json`, sibling to gigradar's data dir, not
inside it) holding `{ "channel": "dev" | "prod" }`, defaulting to
`"prod"` (the safer default for anyone who isn't the owner actively
testing). The Tauri updater checks
`https://github.com/mdostal/gigradar/releases/.../latest-{channel}.json`
(exact URL shape TBD against the real release-tagging convention — see
Open Question 2) at launch and on a manual "Check for updates" action.

### 3.4 CI build pipeline

A new GitHub Actions workflow builds the macOS `.dmg`/`.app` bundle on
`main` release tags (dev-track prereleases tagged e.g. `v0.21.0-dev.1`,
prod-track real tags `v0.21.0`) and publishes to GitHub Releases with
the Tauri-generated update manifest. Windows/Linux jobs added later,
not this epic's first pass.

## 4. What Could Go Wrong

- **Critical — losing the update-signing private key** bricks the
  update path for every install that ever shipped. Mitigation: the
  owner decides where this lives (a password manager, not committed
  anywhere, not this session's job to choose FOR him) before the first
  real signed build — flagged as Open Question 3, a real blocker before
  any build ships.
- **High — macOS Gatekeeper blocks/warns on an unsigned app** (no Apple
  Developer ID code signing/notarization) — a real, separate cost
  ($99/year Apple Developer Program) and account the owner would need
  to set up; this is DIFFERENT from the mandatory-but-free Tauri
  updater signing keypair above and easy to conflate. Mitigation:
  ship unsigned first with a documented "right-click → Open" first-run
  workaround (a real, if imperfect, path that doesn't block starting
  this epic), revisit real notarization once/if wider distribution
  beyond the owner's own machine is the actual goal.
- **Medium — bundling a real Node binary + Playwright's Chromium is a
  genuinely large installer** (Chromium alone is ~150-300MB). Mitigation:
  accepted tradeoff given the "no external dependency" requirement is
  explicit and non-negotiable per the owner's own directive; not
  something to silently shrink scope on.
- **Medium — this is the first Rust/Tauri code in the repo**, a real new
  toolchain and skill surface, not an incremental TypeScript change.
  Mitigation: scope ruthlessly to macOS-only, dev-channel-only for the
  first real working build before adding Windows/Linux/prod-channel
  polish.

## 5. Dependencies and Constraints

- Depends on `electron-wrapper` (the process-spawn/readiness-poll
  pattern this epic reuses) — already shipped.
- New toolchain dependency: Rust + Tauri CLI, not currently installed
  anywhere referenced by this repo.
- Real owner-only dependencies (cannot be resolved by planning/building
  alone): where the update-signing private key lives; whether/when to
  pursue Apple Developer ID notarization.
- Core/user-layer boundary: unaffected — packaging is pure
  distribution/build tooling, touches no `src/lib` core logic.

## 6. Open Questions

1. **Server-readiness polling**: port `electron/server-ready.ts`'s logic
   to Rust (native, no extra Node process just to poll), or keep it as
   a tiny bundled Node script invoked before the main server spawn?
   Proposed default: Rust-native (fewer moving pieces at startup) —
   confirm or override.
2. **Release-tagging convention for dev vs. prod channels**: exact tag/
   manifest naming (e.g. `vX.Y.Z-dev.N` prereleases vs. plain `vX.Y.Z`)
   — proposed to match `scripts/update.sh`'s already-established dev/
   prod branch-channel language, just extended to real version tags.
3. **Where does the update-signing private key live?** This is
   genuinely the owner's call, not a default I should pick.
4. **Apple notarization — pursue now, or ship unsigned + right-click-
   open for now?** Proposed default: unsigned for now (real cost/
   account setup, not blocking), revisit before any distribution wider
   than the owner's own machine.

## 7. Verification Strategy

Automated: none of this is meaningfully unit-testable (it's packaging/
build tooling, not application logic) — verification is real, manual,
end-to-end: a genuinely double-clicked `.app` on a clean macOS user
account (no Node/npm/Playwright pre-installed) launches, the dashboard
loads, Capture Login opens a real bundled Chromium, and a real update
check against a real dev-channel release succeeds.

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~15-20 (new src-tauri/ Rust project + config, CI
    workflow, update-channel preference module, sidecar readiness
    logic, docs).
  Recommendation: LARGE — a genuinely new toolchain (first Rust code in
    this repo), multi-system packaging (two sidecars, code signing
    considerations, CI release pipeline), and real owner-dependency
    blockers (signing key custody, notarization decision) that need
    resolving before implementation, not just during it. Recommend full
    H/V planning before stories.
```
