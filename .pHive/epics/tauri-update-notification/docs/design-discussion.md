# Design Discussion: tauri-update-notification

## 0. Prelude

**Source request (verbatim intent):** "get the gig radar to have an update feature with a notification and the ability to auto update." A separate, related ask in the same message — "just push it live" — is addressed as an explicit checkpoint at the end of this document, not as a story in this epic (see §7).

**PRIOR DECISIONS.** `docs/ARCHITECTURE.md`'s `tauri-real-auto-update` story (already shipped, task #54) is the direct predecessor of this epic. Its resolved decisions, still binding:
- Update-channel preference (dev/prod) lives in a sibling file next to the data dir (`update-channel.json`), never inside `config.json` — installer-level state, not user Config.
- Prod endpoint = GitHub Releases' `/latest/download/latest.json` alias (only resolves non-prerelease tags). Dev endpoint = a `dev-manifest` branch's `latest.json`, overwritten by CI on every dev-channel publish, read via `raw.githubusercontent.com`.
- The `.dmg`/`.app` itself is ad-hoc signed only, not Apple-notarized — real Developer ID signing is a separate, later, owner-gated step (needs the owner's own Apple Developer Program enrollment). Out of scope here, unchanged.

**NORTH STAR.** `.pHive/project-profile.yaml`: a personal tool being open-sourced; the owner is both the primary user and eventual OSS maintainer. Directly relevant to this epic: the owner spent real time this session confused about which build (packaged `.app` vs. `dev`-branch code) they were looking at — a problem a visible current-version/update-state surface directly addresses.

## 1. Goal

Task #54 marked "Auto-update + dev/prod release channels" complete, and it genuinely is — verified below. What's missing, and what this epic actually delivers, is the **user-facing half**: a real notification when an update is found, and control over when the resulting restart happens. Today the mechanism runs entirely silently.

## 2. What's real vs. what's missing (verified this session, not assumed)

Read directly, not inferred from docs or task history:

**Real and working (no code changes needed):**
- `src-tauri/tauri.conf.json` — `plugins.updater` has a real ed25519 `pubkey` and both endpoints configured; `bundle.createUpdaterArtifacts: true`.
- `src-tauri/src/updater.rs` (165 lines) — `Channel::Dev`/`Channel::Prod`, `read_channel()`/`write_channel()` persisted to `~/.local/share/gigradar/update-channel.json` (mirrors `path.ts`'s POSIX branch), `check_for_updates()` building the right endpoint per channel.
- `src-tauri/src/lib.rs` — a native tray menu with "Check for Updates" (manual trigger) and "Update channel: Prod/Dev (click to switch)" (the toggle, live-updating its own label). A launch-time check fires once the main window is up, non-blocking.
- `.github/workflows/tauri-release.yml` — `tauri-action` signs the bundle and emits `latest.json` for prod tags (`vX.Y.Z`) automatically via `createUpdaterArtifacts`; a dedicated step mirrors it to the `dev-manifest` branch for dev tags (`vX.Y.Z-dev.N`, tagged `prerelease`). This is a complete, correct CI publish path for both channels.
- `src-tauri/src/lib.rs` already has a `#[cfg(test)]` module with real `cargo test` coverage (for `resolve_server_port`) — a working verification path this epic's Rust changes should extend, not invent.

**Missing (confirmed by grep, not guessed):**
- `check_for_updates()` (`updater.rs` lines 118-141), on finding an update, goes straight from `update.download_and_install(...)` to `app.restart()` — **zero notification of any kind** between "found" and "app is gone and relaunching." Whatever the user was doing (mid-scan, mid-Capture-Login, filling a draft) is interrupted without warning.
- `@tauri-apps/plugin-updater` is an installed npm dependency (`package.json`) but **zero references to it anywhere in `src/app` or `src/lib`** — the actual UI the user looks at has no code path that even knows an updater exists.
- Neither `lib.rs` nor `updater.rs` ever calls `app.emit(...)` — there is no Tauri event channel carrying update state (checking / found / downloading / ready / installed / error) from Rust to the webview at all. The frontend isn't wired to a broken notification; there's no wire.
- No UI anywhere (Config, About, nav) shows the running app's own version or update channel — directly relevant to this session's real confusion between the stale packaged `.app` and the current `dev` branch.

## 3. Proposed approach

Two coordinated halves, matching this repo's existing "Rust owns the OS-level mechanism, Next.js owns the UI" split (same shape as the Electron/Tauri window-vs-server split documented in `docs/ARCHITECTURE.md`'s "Two runtime modes" section).

**Rust side (`updater.rs` + `lib.rs`):** stop collapsing "found an update" straight into "restart now." Replace the single `check_for_updates()` call with an explicit lifecycle, each transition emitted as a Tauri event (`gigradar://update-status`, a small tagged enum payload: `Checking`, `Available { version }`, `Downloading`, `ReadyToInstall { version }`, `UpToDate`, `Error { message }`). Downloading still starts automatically once an update is found (this preserves "the ability to auto update" — no click required to fetch the bytes) but the **install/restart step waits** for either an explicit `install_update` Tauri command call from the frontend, or a bounded grace period elapsing with no response (a timeout auto-installs — so a user who never looks at the window still gets updated, just not mid-keystroke). This is the standard "download quietly, ask before restarting" shape most desktop apps (Chrome, VS Code, Slack) use, and it satisfies both halves of the ask literally: real auto-update (nothing to click to fetch it) plus a real notification (something to see and, optionally, act on before the restart happens).

**Frontend side:** a small always-mounted client component (`UpdateNotifier`, added to `layout.tsx` next to `NavHeader` so it's visible from every route) that:
- Feature-detects Tauri (dynamic-imports `@tauri-apps/api/event`/`@tauri-apps/plugin-updater` inside a try/catch; renders nothing at all in browser-mode `npm run dev`/`npm run start` or Electron mode — this UI only exists inside the Tauri shell, matching the tray menu's own Tauri-only scope).
- Subscribes to `gigradar://update-status` via `listen()`.
- Renders a small toast/banner for the states that matter to a human: "Update vX.Y.Z available — downloading…", then "Update ready — restarting in Ns to install. [Restart now] [Snooze 1h]". `Checking`/`UpToDate` render nothing (no noise for the common case). `Error` logs to console only (an update-check failure is not something to interrupt the user over — mirrors this repo's existing "flag, don't fail" convention for transient issues).
- "Restart now" invokes the new `install_update` command immediately. "Snooze 1h" tells Rust (a second small command) to hold off and re-offer later, rather than the timeout firing under the user's nose.

**Version/channel surface:** add a small, real "About" readout — current `CFBundleShortVersionString`-equivalent (Tauri's own `getVersion()`) and the current update channel (Dev/Prod) — to the Config page, next to the other installer-level state that already lives there. Cheap, and directly answers the exact confusion this session hit live ("which build am I looking at").

## 4. Scale assessment

**Medium** — cross-stack (Rust `src-tauri/` + TypeScript `src/app/`), multiple files each side, no single-layer shortcut. Not **Large**: no migration, no multi-system integration, bounded to one existing subsystem with a well-understood current implementation (verified above, not exploratory). Proceeding directly from this design discussion to story decomposition (no H/V slicing, no structured outline) — three stories, each independently shippable and individually leaves the app in a working state, is sufficient ceremony for this scope.

## 5. Risks

- **Silent-failure risk if the event channel is missed by the frontend** (e.g. `UpdateNotifier` not yet mounted when Rust emits `Available`): mitigated by re-emitting the current state on a fresh `listen()` subscription (Rust keeps last-known status in memory, re-sent to any newly-attached listener) rather than a fire-once event a late mount could miss.
- **A user on the `dev` channel gets frequent, noisier updates** (every dev-tag push) — unchanged behavior from today, just now visible instead of silent. Acceptable: dev channel is explicitly opt-in via the tray toggle, defaulting to Prod for anyone who isn't the owner (already true).
- **Auto-restart-on-timeout could still surprise someone** if they've stepped away with the window open (e.g. mid-way through a long Capture Login flow in a separate real Chrome window, unrelated to the gigradar window itself) — the grace period (proposed: 30 minutes, generous relative to any single in-app action) and the "Snooze 1h" affordance are the two mitigations; a hard "never auto-restart" mode is explicitly NOT proposed here, since "the ability to auto update" was a named, explicit part of the ask.

## 6. Dependencies

None on other in-flight epics. Builds only on the already-shipped `tauri-real-auto-update` story's real, verified mechanism (§2).

## 7. Open question — the separate "push it live" ask

The source request also said "just push it live." Two distinct things could mean:
1. Cut the release for the auto-resolve-stale-issues + real-inline-issue-actions work already merged to `dev` (PRs #68/#69).
2. Ship this epic's own update-notification work once built.

**This is not something this plan silently resolves.** The owner's own earlier, explicit sequencing this session was: "I'll do Capture Login for ateam/gofractional once everything else is fixed, then we test/verify together, THEN release." That joint verification pass has not happened — a live read of the real `~/.local/share/gigradar/gigs.db` issues table (this session) still shows open `Source fetch failed`/session-expired issues for both ateam and gofractional. "Push it live" is surfaced back to the owner as an explicit checkpoint after this epic's stories are built and verified (see confirmation step) — not executed automatically, since it would silently override a precondition the owner stated themselves, not a code-quality gate this plan can self-clear.

## 8. Decisions

- Auto-download-then-notify-before-install (not notify-then-ask-to-download, not fully silent) — see §3's reasoning.
- Grace-period auto-install default: 30 minutes from "ready to install," resettable once via "Snooze 1h."
- Version/channel readout lands in Config (existing installer-level-state section), not a new page.
- No new page/route for update history or changelogs — out of scope; the release body already carries notes, and GitHub Releases is the canonical changelog.
