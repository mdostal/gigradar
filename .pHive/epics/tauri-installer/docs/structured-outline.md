# Structured Outline: tauri-installer

## Part 1 — Detailed Approach

### Slice 1: Bare packaged app

1. `npm install -D @tauri-apps/cli` — first new toolchain dependency.
   `npx tauri init` scaffolds `src-tauri/` against this repo's existing
   `package.json` (`build.beforeBuildCommand: "npm run build"`,
   `build.devUrl: "http://127.0.0.1:3000"` matching the existing Next
   dev port).
2. `scripts/prepare-tauri-sidecars.sh` (new): downloads the pinned
   Node.js release tarball for the target platform (macOS arm64 first;
   the script parameterizes target-triple so x86_64/Windows/Linux are
   additive later, not a rewrite), extracts the `node` binary, copies it
   to `src-tauri/binaries/node-{target-triple}` per Tauri's own naming
   convention.
3. `tauri.conf.json`'s `bundle.externalBin: ["binaries/node"]` +
   `bundle.resources` includes the built `.next/standalone` output
   (Next's own standalone-output mode, `output: "standalone"` in
   `next.config.js` — a real, additive Next.js config change, produces
   a self-contained server bundle with its own minimal `node_modules`,
   which is what actually gets shipped instead of the full dev
   `node_modules` tree).
4. `src-tauri/src/main.rs`: on `app.ready()`, resolve the bundled
   Node sidecar + bundled server entrypoint's real resource paths
   (Tauri's `path()` API), spawn via `app.shell().sidecar("node")`
   with `NODE_OPTIONS=--experimental-sqlite` and the server entrypoint
   as an arg, poll `127.0.0.1:3000` (Open Question 1: start with a
   simple `std::net::TcpStream::connect` retry loop in Rust — no need
   for `electron/server-ready.ts`'s exact HTTP-probe shape, TCP-connect
   is sufficient and simpler for a readiness gate), then
   `WebviewWindowBuilder::new(...).url(...)`.
5. Manual verification: `npx tauri build`, install the produced `.app`
   on the owner's own machine, confirm the dashboard renders with real
   data from the real (unbundled at this point — same on-disk XDG data
   dir every other mode already uses) SQLite store.

### Slice 2: Chromium sidecar

1. `scripts/prepare-tauri-sidecars.sh` extended: `npx playwright
   install chromium` into a known local cache dir, then copy that
   browser's files into `src-tauri/resources/playwright-browsers/`.
2. `src-tauri/src/main.rs`: when spawning the Node sidecar (Slice 1's
   spawn call), also set `PLAYWRIGHT_BROWSERS_PATH` in its environment,
   pointed at the bundled resource path resolved via Tauri's `path()`
   API.
3. `src/lib/auth/browser-session.ts`: `launchHeadedBrowser()` already
   calls `checkChromiumAvailable()` before launching — this function's
   existing "is a Chromium available" check needs no logic change
   (Playwright's own `PLAYWRIGHT_BROWSERS_PATH` env var is respected by
   Playwright itself, transparently) — confirm this live during
   implementation rather than assume; if Playwright's resolution needs
   an explicit `executablePath` override instead, that's the one real
   core-code change this epic makes.
4. Manual verification: from the packaged app, "Capture login" for a
   real `browser-session` source opens a real bundled Chromium window,
   completes a real login, saves a real session file.

### Slice 3: CI build + publish

1. New `.github/workflows/tauri-release.yml`: triggered on a pushed
   tag matching `v*`. Runs `npm ci`, `scripts/prepare-tauri-sidecars.sh`,
   `npx tauri build` on a `macos-latest` runner, then `gh release
   create` (or `tauri-apps/tauri-action`, which the earlier Tauri-docs
   research confirmed generates the update-manifest JSON directly) to
   publish the `.dmg` + manifest to GitHub Releases.
2. Tag convention (Open Question 2's resolution): prod tags are plain
   `vX.Y.Z` (matching `package.json`'s existing version already used by
   every prior epic's release-finalize step this session); dev-channel
   tags are `vX.Y.Z-dev.N`, cut more freely, not gated on the same
   "main only for releases" discipline other work follows.
3. Manual verification: push a real test tag, confirm the Actions run
   produces a real downloadable `.dmg` on the repo's Releases page.

### Slice 4: Real auto-update

1. `npm install @tauri-apps/plugin-updater @tauri-apps/plugin-shell` +
   Rust-side plugin registration in `main.rs`.
2. `tauri.conf.json`'s `plugins.updater` config: `pubkey` (the public
   half of the eventual Portunus-vaulted keypair — placeholder/local
   test key until that's generated for real), `endpoints` built from
   the stored channel preference at runtime (not a static array — the
   docs' own dynamic-endpoint pattern from design-discussion.md §2).
3. New local preference module (`src-tauri/src/update_channel.rs` or a
   thin JS-side module, TBD during implementation which side owns the
   read/write) for the `{channel: "dev"|"prod"}` file.
4. A minimal channel-toggle UI — likely simplest as a native Tauri tray
   menu or window menu item ("Update channel: Dev / Prod") rather than
   a new page inside gigradar's own Next.js UI, since this is
   installer-level state, not `Config`.
5. Manual verification (the epic's real acceptance bar): install a real
   published `.dmg` from Slice 3, bump the version, publish a new
   release under the SAME channel the test install is tracking, confirm
   the running app detects and applies the update.

## Part 2 — File Manifest

| Path | Change |
|---|---|
| `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs` | new — the Tauri project |
| `src-tauri/binaries/`, `src-tauri/resources/` | new — sidecar binary + bundled server/Chromium (gitignored, generated by the prepare script, not committed) |
| `scripts/prepare-tauri-sidecars.sh` | new |
| `next.config.js` | modified — `output: "standalone"` added |
| `package.json` | modified — `@tauri-apps/cli`/`@tauri-apps/plugin-updater`/`@tauri-apps/plugin-shell` deps, new `tauri:*` scripts |
| `src/lib/auth/browser-session.ts` | possibly modified — only if `PLAYWRIGHT_BROWSERS_PATH` needs an explicit `executablePath` override (confirm live in Slice 2) |
| `.github/workflows/tauri-release.yml` | new |
| `docs/ARCHITECTURE.md` | modified — new packaged-distribution section |
| `docs/index.html` (GitHub Pages) | modified — real install CTA once Slice 3 ships a real downloadable artifact |

## Part 3 — Risk Registry

| Severity | Risk | Mitigation | Owner |
|---|---|---|---|
| Critical | Update-signing private key lost after real installs exist | Real key generation deferred to Portunus vaulting, explicitly NOT this epic's job to generate/store | Owner (Portunus) |
| High | Unsigned build blocked/scary-warned by Gatekeeper, confusing a non-technical first-time user | Documented right-click→Open note, linked directly from the install CTA — accepted tradeoff, not silently hidden | This epic (docs) |
| High | Bundled Node version drifts from what `node:sqlite`/`--experimental-sqlite` actually needs on a future Node release | Pin the exact Node version in `prepare-tauri-sidecars.sh`, not "latest" | This epic |
| Medium | `PLAYWRIGHT_BROWSERS_PATH` doesn't transparently resolve as assumed, needs a real core-code `executablePath` change | Flagged explicitly in Slice 2's own steps as "confirm live, don't assume" | This epic |
| Medium | Installer size (~150-300MB+ for bundled Chromium) surprises users expecting a small download | Documented size on the install CTA copy | This epic (docs) |
| Low | First Rust code in the repo — no existing conventions/lint setup | Keep `main.rs` minimal and well-commented; this is intentionally the smallest possible Rust surface (spawn + poll + load URL), not a place to build gigradar logic in Rust | This epic |

## Part 4 — Elicitation (self-stress-test)

**Q: Why not skip Slice 2 (Chromium bundling) entirely and just require Playwright's normal first-run browser download?**
A: Contradicts the epic's own non-negotiable ("no external dependency,
no bullshit setup by the average worker") — a non-technical user hitting
a mid-flow "downloading browser..." step the first time they click
"Capture login" is exactly the kind of friction this epic exists to
eliminate. Bundling is more work but is the actual requirement, not
scope creep.

**Q: Why is `next.config.js`'s `output: "standalone"` change safe to make now, given every other runtime mode (`npm run dev`/`start`, Electron) already works today?**
A: Standalone output is additive — it changes what `next build` ALSO
produces (a `.next/standalone/` folder), not what the existing
`npm run start` command does. This needs live verification during Slice
1 (does `node:sqlite`/`--experimental-sqlite` behave identically from
the standalone server entrypoint vs. `next start`?) rather than assumed
safe — called out explicitly, not silently trusted.

**Q: Is four slices the right granularity, or should CI (Slice 3) come before Chromium bundling (Slice 2)?**
A: Kept CI after both sidecars deliberately — publishing a `.dmg` that's
missing real feature parity (no Capture Login) to a public Release page,
even temporarily, risks someone downloading a half-working build. Local-
only verification for Slices 1-2, CI only once the artifact is actually
worth publishing.

**Q: What happens to the existing Electron `npm run electron` mode once this ships?**
A: Nothing — explicitly out of scope to touch it (design-discussion.md
§0). Two real, intentionally different distribution modes coexist:
terminal-launched Electron for the owner's own continued dev use,
double-clickable Tauri for anyone else.

## Part 5 — Decision Points (already resolved this session)

1. Framework: Tauri, not Electron, for this installer. RESOLVED.
2. Signing key custody: Portunus, deferred until real signed builds are
   needed. RESOLVED.
3. Notarization: unsigned for now. RESOLVED.
4. Planning depth: full H/V + this structured outline. RESOLVED (this
   document).

No further open decision points before story decomposition.
