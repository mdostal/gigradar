# Vertical plan: oauth-session-capture-v2

Three slices. Slice 1 is the actual fix (the real, live problem the
owner hit) — it alone closes out this epic's core ask. Slices 2-3 are
the two named enhancements, each independently valuable and
independently shippable on top of Slice 1.

## Slice 1 — Spawn-then-attach real Chrome (the actual OAuth fix)

- `src/lib/auth/real-chrome.ts`: `spawnRealChrome()`/
  `attachToRealChrome()`/`closeRealChrome()` — direct `child_process`
  spawn of the real Chrome binary with `--remote-debugging-port` + a
  fresh isolated `--user-data-dir`, never `playwright.chromium.launch()`.
- `session-capture.ts`'s `startCapture()`/`finishCapture()`/
  `cancelCapture()` rewired to use it — same globalThis-pinned map,
  idle timeout, origin-scoping, atomic encrypted write, all unchanged.
- `assist-session.ts`'s `startAssistSession()`/`endAssistSession()`
  rewired the same way.

**Working state:** Capture Login and profile-assist's "Start" both open
a real, independently-launched Chrome that passes Google's real OAuth
sign-in — live-verified against the owner's own real GoFractional
account, the exact failure this epic exists to fix.

## Slice 2 — Portunus as an optional session-vault backend

- `src/lib/auth/session-backend.ts`: `isPortunusAvailable()`,
  `writeSessionViaPortunus()`, `readSessionViaPortunus()`.
- New `sources[].settings.sessionBackend` config field (`"local"` |
  `"portunus"`, default `"local"`).
- `/config`'s Capture Login control shows a backend picker ONLY when
  `isPortunusAvailable()` is true.

**Working state:** an owner with Portunus installed can choose to vault
a captured session there instead of the local encrypted file; every
other OSS user sees no change at all.

## Slice 3 — LLM-guided capture readiness check

- `src/lib/auth/capture-guidance.ts`: `checkCaptureReadiness()` — one
  single-shot Anthropic call, same delimiting discipline as
  `profile-suggest.ts`, read-only (no click/fill tool schema at all).
- Capture Login's "waiting" UI state gets an optional "Check if I'm
  ready" button that surfaces the plain-language readiness note next to
  the existing "I'm done" button — advisory only, never auto-triggers
  finish.

**Working state:** all three slices done — epic complete.
