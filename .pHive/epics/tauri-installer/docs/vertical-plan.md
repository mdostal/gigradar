# Vertical Plan: tauri-installer

Four slices, sequential. Each is a genuinely working, demo-able state —
not a partial scaffold waiting on the next slice to mean anything.

## Slice 1 — Bare packaged app (L1 + L2)

A real `.app` the owner can double-click on his own machine, with zero
Node/npm on `PATH` required, that shows gigradar's real dashboard.
Bundled Node sidecar spawns the built server; Tauri's webview loads it.
No Playwright/Chromium bundling yet (Capture Login and browser-session
sources won't work from this build) — that's Slice 2, deliberately
separated so a "does the core app even launch, packaged, on a clean
account" question gets answered on its own, isolated from the much
bigger Chromium-bundling problem.

**Working state after this slice**: a genuinely double-clickable app
that shows the dashboard, gate results, config, drafts, issues — every
feature that doesn't need a real browser session. Unsigned, locally
built only, not yet published anywhere.

## Slice 2 — Chromium sidecar (L3)

Capture Login and every `browser-session`-auth source (GoFractional,
A.Team, Wellfound) work from inside the packaged app, using the bundled
Chromium — no network fetch for a browser download on first run, no
system Playwright install needed.

**Working state after this slice**: full feature parity with the
terminal-launched Electron dev mode, just double-clickable and fully
self-contained. This is the real "any downloader can use this" bar
being met for the first time.

## Slice 3 — CI build + publish (L5)

A GitHub Actions workflow builds the same `.dmg` Slice 1/2 produced
locally, from a clean CI runner, and publishes it to GitHub Releases —
proves the build is reproducible outside the owner's own machine, the
actual precondition for anyone else ever installing this. Still no
in-app update-check logic yet (deliberately) — this slice is purely
"can we build and ship the artifact," isolated from "can an existing
install find and apply a new one."

**Working state after this slice**: anyone (not just the owner) can
download a real, working `.dmg` from a real GitHub Release and run it
manually. Still no auto-update.

## Slice 4 — Real auto-update (L4)

The in-app updater checks a real published manifest on launch/on
demand, respects the stored dev/prod channel preference, and can
actually apply an update end to end — Slice 3's shipped `.dmg` becomes
a self-updating install, closing the epic's own north star.

**Working state after this slice**: the epic's stated goal is real —
install once, keep it current automatically, choose dev or prod. L6
(docs) wraps up alongside this slice, documenting what's now true.

## Sequencing note

Slices 1-3 are each independently valuable checkpoints even if Slice 4
(the real signing-key-gated auto-update) stays paused on the Portunus
custody resolution — the owner can be using a real, packaged,
manually-updated app from Slice 3 onward while that's sorted out.
