# Vertical Plan: embedded-profile-assist

Two independently-shippable slices. Each leaves the app in a genuinely
working state; Slice 2 depends on Slice 1's plumbing.

## Slice 1: `embedded-view-readonly`

**What ships:** a new "Embedded" view option in `/profile-assist`, alongside
the existing Manual/Guided/Full-auto tabs. Selecting it (for any active
session) shows a two-column layout: left pane renders a live screenshot of
the session's page (auto-refreshing after every agent turn, plus a manual
"Refresh" button), right pane keeps rendering the SAME chat/suggestion UI
Guided mode already uses — completely unchanged, no agent-toggle yet, no
click/type forwarding yet.

**Why this is a real, working slice on its own:** even before any human
click-forwarding exists, this alone fixes a genuinely broken experience —
today, running Guided/Full-auto mode on a headless-feeling remote/tool-driven
session (like this one) leaves the human unable to SEE what the agent is
looking at unless they can see the separately-opened native window. A
read-only live view is real, immediate value.

**New surface:**
- `getSessionScreenshotAction(sessionId): ActionResult<{dataUrl: string}>` —
  reads `getAssistSessionPage(sessionId)`, calls `page.screenshot({type:
  "jpeg", quality: 70})`, returns as a data URL.
- `profile-assist-client.tsx`: new `viewMode: "native" | "embedded"` state,
  a toggle control, and (when `embedded`) a two-column layout rendering an
  `<img>` fed by the new action, refreshed after every `advanceLoopTurnAction`/
  `resolveApprovalAction` call already in the component.

**Explicitly deferred to Slice 2:** click/type forwarding (Slice 1's
embedded pane is READ-ONLY — agent-driven turns update it, but a human
can't yet act directly inside it); the mid-session agent-engaged toggle
(Slice 1 only wires the embedded VIEW, reusing Guided mode's existing
propose/approve loop as-is).

## Slice 2: `embedded-view-interactive`

**What ships:** the embedded pane becomes genuinely interactive — a human
click/type on the left pane acts on the real page, and a per-session
"Agent engaged" toggle lets the human flip between driving directly and
letting the agent propose/act (Guided-mode style), same session, no restart.

**New surface:**
- `clickSessionAtAction(sessionId, xRatio, yRatio): ActionResult<{dataUrl}>`
  — Server Action wrapping `page.mouse.click()` on the coordinates
  translated from the click, then returns a fresh screenshot.
- `typeIntoSessionAction(sessionId, text): ActionResult<{dataUrl}>` — wraps
  `page.keyboard.type()`, same refresh-and-return shape.
- `profile-assist-client.tsx`: `<img>` gets an `onClick` handler computing
  `xRatio/yRatio` from `event.nativeEvent.offsetX/Y` divided by the
  rendered image's `clientWidth/Height`; a small text input for typed
  input; the new `agentEngaged: boolean` toggle, gating whether
  `advanceLoopTurnAction` keeps auto-firing after each screenshot refresh
  (mirrors Guided mode's existing loop, just conditional now) or the
  session sits idle waiting for the next human click/type.

**Depends on Slice 1:** reuses its screenshot action, layout, and refresh
wiring directly.

## Explicitly out of scope for both slices

- Capture Login's own native-window flow (see design-discussion.md §4.4) —
  untouched.
- CDP video streaming (design-discussion.md §3(b)) — deferred, not part of
  either slice.
