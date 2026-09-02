# embedded-browser-and-guided-session — design discussion

Follow-on epic 3 of 4 (platform-aware drafting, **embedded browser/focus**,
deep memory, UI overhaul) scoped in
`deep-dive-audit-and-testing-framework`'s own design-discussion.md, section
1e ("Focus-stealing browser windows — 'I can hardly use the computer'").

## 1. Confirmed scope (owner decision, this run)

Owner chose the focused fix over the full native-embedding rewrite: try
headless first with an automatic headed fallback, stop popping a fresh
visible window for the default (non-error) scan path when a headed window
IS still required, and finish `embedded-profile-assist`'s already-designed
Slice 2 (interactive click/type forwarding). The full Tauri v2 native
multi-webview side-by-side browser+chat panel is explicitly deferred to a
future epic — it doesn't actually solve the flashing-window problem on its
own (see below) and is a much larger Rust/UI undertaking that overlaps with
Epic 5's UI-overhaul work.

**Why native embedding doesn't solve this**: `embedded-profile-assist`
Slice 1 (already shipped) proved a live screenshot pane can sit *alongside*
a real OS window, but does not suppress it — the real window still pops and
still steals focus regardless of whether an embedded view also exists. Full
native `WebviewBuilder`/`add_child` embedding hits the same clickjacking/CSP
wall the original design already found for `<iframe>` on login-gated pages
— the browser still needs its own real, focusable OS surface for
authentication to work at all. The actual levers that control
flashing/focus-stealing are orthogonal to embedding: (a) whether a visible
window exists at all (headless vs. headed), and (b) when one must exist,
whether it steals focus (a fresh, activated pop-up vs. a window that's
immediately minimized).

## 2. Stories

### Story A: `headless-first-with-headed-fallback`

The default scan path (`acquireViaStorageStateSnapshot()` in
`src/lib/auth/browser-session.ts`) launches a fresh, visible
`headless: false` window on **every single scan**, because GoFractional and
A.Team were found (at `browser-session.ts`'s original design time) to fail
auth in headless mode. That finding has never been re-tested since. Rather
than a one-off manual re-test (stale the moment browser fingerprinting
changes again), make the system self-discovering: attempt a headless launch
first; only on `SessionAuthError`/`VerificationChallengeError` does it fall
through to the existing headed path. This is a strictly additive new first
attempt — the existing headed fast-path and the existing
persistent-real-chrome self-heal fallback are both unchanged as the second
and third tiers. No caching of "headless works for source X" across runs —
correctness over a marginal speed win; a failed headless attempt costs a
few seconds, not a window.

### Story B: `minimize-headed-window-immediately`

When headless does fail and a headed window is genuinely required (either
tier 2 or tier 3 above), immediately minimize it via `osascript` right
after the page navigates — macOS-only (this module is already macOS-gated
via `real-chrome.ts`'s `resolveRealChromePath()`), best-effort, never
throws, same `execFile`-argv-level-no-shell discipline
`src/lib/notify/desktop.ts` already established. The window still exists
(automation still works against it via CDP — Playwright screenshots/clicks
operate on the render tree, not physical on-screen pixels) but never stays
focused/visible on the owner's desktop for the scan's duration.

Two different treatments depending on whether a human is expected to be
present, per owner clarification mid-epic (wants a real, positioned window
usable side-by-side with the app for guided work — not just hidden away —
while still ruling out flashing/focus-stealing):

- **Unattended scheduled scans** (`browser-session.ts`'s tiers 2/3, no
  human watching by definition): minimize immediately, exactly as
  originally scoped above.
- **Guided/full-auto `startAssistSession()` calls**
  (`src/lib/auth/assist-session.ts`): instead of minimizing, POSITION the
  window to a fixed, predictable half of the primary display (right half)
  via the same `osascript`/`execFile` mechanism, `set bounds of front
  window to {...}` rather than `set miniaturized to true`. This gives a
  real, glanceable, directly-usable side-by-side window immediately —
  complementary to the embedded pane (Story C), not a replacement for it —
  without stealing focus by popping centered/maximized. `manual` mode is
  unaffected either way: "a real browser window is open on your desktop,
  use it directly" (`profile-assist-client.tsx`'s own manual-mode copy) is
  the intended UX there, so neither treatment applies to it.

**Explicitly out of scope, flagged not silently dropped**: TRUE cross-app
docking (the gigradar app window and the Chrome window snapping edge-to-
edge and re-adjusting live as either moves) is an OS window-manager-level
feature that would require coordinating both windows' positions — the
gigradar app's own window is owned by a different runtime entirely
(Electron's main process / the Tauri Rust shell), not by this module. A
fixed-half-of-screen position is the buildable version of "side by side"
this story ships; live-tracking dock behavior is a reasonable future ask
for whichever epic next touches the Electron/Tauri window-chrome layer.

### Story C: `embedded-view-interactive`

Already fully speced as `embedded-profile-assist`'s own Slice 2 story
(`.pHive/epics/embedded-profile-assist/stories/embedded-view-interactive.yaml`)
— built, not redesigned, here. `clickSessionAtAction`/`typeIntoSessionAction`
Server Actions forwarding ratio-scaled clicks/keystrokes into the real held
`Page`, plus an `agentEngaged` toggle so the embedded pane can be
human-driven, LLM-driven, or switched between mid-session without ending
the assist session.

## 3. Explicitly out of scope this run (documented, not silently dropped)

- **Full native Tauri v2 multi-webview embedding** for a true in-app
  side-by-side panel — deferred; doesn't solve the actual pain point (see
  §1), large Rust/UI scope, natural fit for a dedicated future epic.
- **SimMan** (`firefly-events/simman`) — a selectorless, vision-grounded
  Playwright *test-authoring* tool, not a browser-embedding/computer-use
  tool. Doesn't address window-flashing at all. Left as a possible future
  reasoning backend for `profile-assist-loop.ts` on ARIA-broken pages, a
  separate decision from this epic's scope.
- **A new "skills + approval wrapper"** system for browser-automation
  actions. The `graduated-auto-fire-trust` epic already built exactly this
  pattern (3-approval/source/tier trust + owner-configurable checks) for
  submit actions — the right move is extending that existing mechanism to
  future browser-automation actions as they're built, not standing up a
  parallel system. No new code this run; `embedded-view-interactive`'s own
  `agentEngaged` toggle (OFF by default, human approves every LLM-proposed
  action in Guided mode) already provides the approval gate this epic's
  actual surface (profile-assist) needs.
