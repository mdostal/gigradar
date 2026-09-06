# Embedded-automation proof-of-concept, 2026-09-06

Real, standalone Swift command-line tools, compiled and ad-hoc-signed
the same way gigradar's own packaged `.app` is signed
(`codesign --sign "-" --force --options runtime --entitlements
src-tauri/entitlements.plist`), run against gigradar's own real, live
PID to validate the mechanisms behind `embedded-automation-bridge` and
`embedded-vision-automation-mode` BEFORE committing to building them.
See `../design-discussion.md` §6/§7 for the full narrative and the
owner's own real-time findings while watching this run.

Not wired into the app in any way — reference-only, kept here so the
validated API shapes/gotchas aren't lost once `/tmp` gets cleared.

## `poc.swift` — scoped read + capture

Compile: `swiftc poc.swift -o poc`. Run: `./poc <pid>`.

- `AXUIElementCreateApplication(pid)` — real, precise accessibility-tree
  read, scoped to exactly one process. Confirmed: a bare Swift CLI
  crashes on `CGS_REQUIRE_INIT` unless `NSApplication.shared` is
  referenced first (moot inside Tauri's own already-initialized
  process — see the file's own comment).
- `SCContentFilter(desktopIndependentWindow:)` (ScreenCaptureKit) —
  confirmed to capture ONLY the target window's content, verified by
  inspection. Ad-hoc signing did NOT block this on this machine/macOS
  version, contrary to a more cautious secondhand research finding —
  re-verify empirically if this ever targets a different macOS
  version/signing setup.

## `dump.swift` — full accessibility tree dump

Needed because the real nav content lives much deeper than expected
(16 levels, inside the WKWebView's own `AXWebArea` subtree) — a
shallower depth limit silently missed it. Filtered to avoid printing
anything but the target PID's own tree.

## `click.swift` — the click mechanism, and the real negative/positive split

Two dispatch modes, toggled by a second CLI arg:

- `CGEvent.postToPid(pid)` — dispatched with no error, but produced NO
  real effect. Real negative result, not fully explained (likely
  WebKit's hit-testing depends on real mouse/cursor state that
  `postToPid` never touches).
- `CGEvent.post(tap: .cghidEventTap)` (default) — WORKED, live-confirmed
  by the owner watching their own screen navigate. **But this visibly
  moves the owner's real OS mouse cursor** — the reason
  `embedded-vision-automation-mode` is a foreground-only, explicitly
  toggled fallback rather than the default, and why
  `embedded-automation-bridge`'s `webview.eval()`-based DOM dispatch
  (which never touches the OS cursor at all) is the real default.
