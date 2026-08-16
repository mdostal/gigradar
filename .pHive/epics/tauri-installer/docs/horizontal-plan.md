# Horizontal Plan: tauri-installer

## L1 — Rust/Tauri project scaffold

- New `src-tauri/` (Cargo.toml, `tauri.conf.json`, `src/main.rs`) —
  the FIRST Rust code in this repo. `tauri.conf.json`'s `bundle.identifier`,
  window config, and `externalBin` entries (empty until L2/L3 populate
  them) live here.
- `package.json` gains `@tauri-apps/cli` as a dev dependency and a new
  `npm run tauri` family of scripts (`tauri dev`, `tauri build`) —
  additive, doesn't touch any existing script.

## L2 — Sidecar 1: bundled Node + gigradar server

- A build step (new `scripts/prepare-tauri-sidecars.sh` or similar)
  downloads/pins a real per-platform Node.js binary, renames it to the
  Tauri-required `node-{target-triple}` convention, and copies
  gigradar's own `npm run build` output (`.next/`, `node_modules`
  production deps) into `src-tauri/resources/`.
- `src-tauri/src/main.rs`: on launch, spawns the bundled Node sidecar
  with the bundled server entrypoint as an argument and
  `NODE_OPTIONS=--experimental-sqlite` set — same invocation shape
  `npm run start`/`electron/main.ts` already use, just pointed at
  bundled paths instead of `PATH`-resolved ones.
- Readiness polling (Open Question 1's resolution) against
  `http://127.0.0.1:3000` before the webview loads the URL.

## L3 — Sidecar 2: bundled Playwright Chromium

- Bundles Playwright's Chromium browser binary as a resource (not a
  Tauri `externalBin` sidecar — Playwright itself launches it, Tauri
  just needs to ship the bytes).
- `src/lib/auth/browser-session.ts`'s `launchHeadedBrowser()` needs a
  small, additive change: read `PLAYWRIGHT_BROWSERS_PATH` (set by the
  Tauri wrapper at spawn time) so it finds the bundled browser instead
  of Playwright's own default cache location — a real, small core
  change, the only one this whole epic makes outside `src-tauri/`.

## L4 — Update channel + updater plugin

- New local preference file (sibling to gigradar's data dir, per
  design-discussion.md §3.3): `{ channel: "dev" | "prod" }`.
- Tauri updater plugin configured with the two channel endpoint URLs
  (Open Question 2's resolution); a small settings surface (likely a
  native Tauri menu item or a minimal in-webview control) to toggle
  the stored channel and trigger a manual check.

## L5 — CI / release pipeline

- New GitHub Actions workflow: on a real version tag push, builds the
  macOS bundle (`tauri build`), signs it with the Tauri updater keypair
  (`TAURI_SIGNING_PRIVATE_KEY` from repo secrets — populated later, per
  the Portunus-gated key-custody resolution; the workflow itself is
  buildable and testable now against a local placeholder key), and
  publishes the `.dmg` + update manifest JSON to GitHub Releases.

## L6 — Docs

- `docs/ARCHITECTURE.md`: new "Packaged desktop distribution (Tauri)"
  section alongside the existing "Two runtime modes" section — explicit
  about this being a THIRD mode (browser / Electron-dev / Tauri-
  packaged), not a replacement of the other two.
- A real "first launch on an unsigned build" doc note (the right-click
  → Open workaround), linked from the GitHub Pages site's install CTA.

## Cross-layer dependency

```
L1 (Tauri shell)
  -> L2 (Node+server sidecar) -> proves the app actually runs at all
       -> L3 (Chromium sidecar) -> proves Capture Login works packaged
       -> L5 (CI pipeline) -> proves it can be built+distributed by anyone, not just locally
            -> L4 (updater + channel toggle) -> closes the loop: distributed installs can self-update
                 -> L6 (docs) -> last, documents what's actually true once built
```
