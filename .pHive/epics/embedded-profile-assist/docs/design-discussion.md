# Design Discussion: embedded-profile-assist

## 0. Prelude

No `.pHive/CONTEXT.md`-scale glossary conflicts here; this epic extends
existing, already-shipped mechanisms (`assist-session.ts`,
`profile-assist-loop.ts`) rather than introducing new domain vocabulary. No
prior KG decisions to reconcile (no `hive/lib` tooling installed in this
repo — planning docs here are authored directly, matching this session's
established practice for ats-navigator/career-documents/agent-chat).

## 1. Goal

Owner, verbatim, from a screenshot of `/profile-assist`'s Manual mode
showing only "GoFractional" selectable:

> "because we can always have it open the web in a frame below this start
> with the web on the left and the agent on the right capable of reading
> the screen and chatting and working through it with you"

Clarified via direct follow-up (already answered, not re-litigated here):

1. **Agent involvement**: both observe-and-suggest and observe-and-act must
   be supported, toggleable by the human mid-session — "you should be able
   to toggle off the agent working on it."
2. **Scope**: additive. The existing native-OS-window flow (a real Chrome
   window on the user's own desktop, `real-chrome.ts`'s spawn-then-attach)
   keeps working unchanged. This is a new alternative, never a replacement.

Concretely: add an **embedded split-view** mode to `/profile-assist` — the
live target page rendered inline (left pane) alongside the existing
agent-chat/approval UI (right pane) — as a second way to run a
Manual/Guided/Full-auto assist session, without retiring the current
native-window mode.

## 2. Existing building blocks (reused, not reinvented)

- **`src/lib/auth/assist-session.ts`** — `startAssistSession()` already
  spawns a real, independent Chrome (`real-chrome.ts`'s spawn-then-attach,
  never `playwright.chromium.launch()` directly — see that file's own
  rationale) and holds a persistent `Page` across many Server Action calls
  until the human clicks Done or the idle timeout fires. The embedded view
  renders THIS SAME `page` object's content — it is a second way to *look
  at and act on* an existing session, not a second browser.
- **`src/lib/apply/profile-assist-loop.ts`** — the existing Guided/Full-auto
  tool-use loop. Read closely for this epic's core technical question: the
  agent does **not** read the page via screenshot today — it reads a text
  **ARIA accessibility snapshot** (`page.locator("body").ariaSnapshot({mode:
  "ai"})`), which is cheaper and more precise for the LLM's own click/fill
  targeting than parsing a rendered image would be. This loop's existing
  propose → human-approve (Guided) / propose → auto-execute (Full-auto)
  machinery is exactly the "toggle whether the agent acts" mechanism the
  owner asked for — this epic extends it (adds a per-turn toggle), it does
  not replace it with a new approval system.
- **`src/lib/chat/agent-chat-loop.ts`'s `TAKE_SCREENSHOT_TOOL`/
  `ChatScreenshot`** (agent-chat epic, already shipped) — a working
  precedent for "capture a Playwright screenshot, base64-encode it, render
  it inline in this app's own React UI." Different epic, same shape; this
  epic's left pane reuses that shape, not that code (agent-chat's tool is
  scoped to the chat's own capture-session flows, not assist-session's).
- **Playwright's own `page.mouse.click(x, y)` / `page.keyboard.type(text)`**
  — NOT explored in the original framing of this problem (which reached for
  raw CDP `Input.dispatchMouseEvent`), but already available on the exact
  `Page` object `assist-session.ts` holds. This turns out to matter a lot —
  see §4.1.

## 3. Real research: what actually gets browser content into a web page

Three real alternatives, evaluated on their actual engineering cost against
THIS codebase's existing infrastructure (not in the abstract):

### (a) Screenshot-refresh (Playwright `page.screenshot()` → base64 → `<img>`)

Cost: near-zero new infrastructure. `page.screenshot({type: "jpeg",
quality: 70})` already exists on the `Page` object every assist session
already holds. Rendering as a data-URL `<img>` is the exact shape
`agent-chat-loop.ts`'s `ChatScreenshot` already does. A Server Action
triggers a refresh (after every agent turn automatically; on-demand via a
"Refresh" button for the human's own navigation) — this app's entire
existing architecture is Server-Action request/response, not a persistent
socket, so this fits the grain rather than fighting it.

Human interactivity gap, and its resolution: a static `<img>` can't be
clicked-through by the browser natively. But it doesn't need raw CDP to
fix — **Playwright's own `page.mouse.click(x, y)`/`page.keyboard.type()`**
already exist on the held `Page`. A click on the `<img>` reports
`(offsetX, offsetY)`; scale that by `viewportSize / renderedImageSize` to
get real page coordinates; a Server Action calls `page.mouse.click()` with
them; the response is the next refreshed screenshot. No new transport, no
new server-side protocol handler — just one more Server Action alongside
the ones `profile-assist/actions.ts` already has.

### (b) True live video (CDP `Page.startScreencast` → WebSocket → `<canvas>`)

Real "live remote view" fidelity (Browserbase/Steel.dev-class), but a
substantially different cost profile for this specific app:

- This Next.js app has **no WebSocket/SSE infrastructure anywhere** today
  (confirmed: every real-time-feeling feature in this codebase — dashboard
  refresh, chat, capture-login status — is Server-Action polling, never a
  persistent socket). This would be the first, a genuinely new transport
  layer, not an extension of an existing one.
- Frame-rate/bandwidth tuning and precise CDP input-coordinate mapping are
  real, non-trivial engineering on top of that — the kind of work that pays
  off when sub-second latency actually matters (e.g. drawing/gaming), which
  filling out a profile form does not.
- The human already HAS a truly-live option today: the existing
  native-window mode. Someone who wants zero-latency direct control can
  already pick that. The embedded view's actual job (per the owner's own
  framing — "reading the screen and chatting... working through it with
  you") is agent-and-human COLLABORATION on one page, not raw teleoperation
  fidelity.

**Decision: (a).** It is a strict evolution of code this repo already has
working in two different places (assist-session's held `Page`,
agent-chat's screenshot-render shape), needs no new transport, and Playwright's
own input API removes the one gap (human interactivity) that looked hard
before actually checking what `Page` already exposes. (b) is not rejected
forever — flagged in §7 as a real, deferred option if screenshot-refresh's
latency ever becomes the actual complaint, not a hypothetical one.

### (c) Direct `<iframe>` embed of the target site

Not viable as a real path, not deeply investigated further: every
login-gated job platform this app targets (GoFractional, A.Team, Wellfound,
the new Catalant/Indeed presets) either sets `X-Frame-Options: SAMEORIGIN`/
`deny` or a `frame-ancestors` CSP directive on its login and authenticated
pages specifically BECAUSE embedding a login form in a third-party iframe
is a classic clickjacking vector — sites that care about account security
are the least likely to allow it. Documented here as a rejected option, not
attempted.

## 4. Design decisions

### 4.1 Rendering mechanism: screenshot-refresh + Playwright-native input forwarding

Resolved above (§3(a)). Concretely: a new `getSessionScreenshot(sessionId)`
reads the held `Page` and returns a base64 JPEG; a new
`clickSessionAt(sessionId, xRatio, yRatio)` and
`typeIntoSession(sessionId, text)` forward human input via
`page.mouse`/`page.keyboard`, then both return a fresh screenshot in the
same round trip (so the client never has two separate "did my click land
AND is the picture fresh" round trips).

### 4.2 Agent-involvement toggle

The existing `AssistMode` (`"manual" | "guided" | "full-auto"`,
`profile-assist-client.tsx`) already IS a coarse version of this toggle,
just fixed at session start. This epic makes it a **live, per-turn toggle**
inside an embedded session rather than a second mechanism:

- **Agent off** (human-driven): the embedded pane is purely a live view +
  click/type surface for the human; no LLM call happens unless the human
  explicitly asks the chat side a question.
- **Agent on** (mirrors today's Guided mode): `profile-assist-loop.ts`'s
  existing propose → human-approve loop runs, using its EXISTING
  ARIA-snapshot-based reading (unchanged — the snapshot remains the
  agent's own reasoning input; the screenshot is for the HUMAN's benefit,
  a deliberately decoupled concern, not a shared one) and its EXISTING
  approval gating. The only new wiring is: after an approved/executed
  action, also refresh and push the screenshot into the left pane.
- The toggle is a piece of client state (`agentEngaged: boolean`) alongside
  the existing `mode` state in `profile-assist-client.tsx` — Manual mode
  the toggle is inert (always off); Guided/Full-auto keep working exactly
  as today when the embedded view isn't used at all.

### 4.3 Where this lives in the UI

A new **"Embedded" view toggle** alongside the existing
Manual/Guided/Full-auto tab row in `/profile-assist` — selecting it swaps
the page body to a two-column layout (left: live screenshot + click/type
controls; right: the SAME chat/approval components already rendered for
Guided mode today, reused not duplicated). The native-window flow remains
the default/unmarked option, unchanged in every respect.

### 4.4 Capture Login: explicitly OUT of this epic's scope

The owner's second complaint ("there is no way for me to log in still
using this, so we need to fix that") was the `settings.loginUrl` /
`settings.allowedOrigins` gap for custom-llm-source presets — already
fixed directly (see `fix(sources): browser-session presets need loginUrl +
allowedOrigins` and `fix(profile-assist): offer every configured
browser-session source`, both merged to `dev` ahead of this epic). This
epic is scoped to profile-assist's embedded VIEW only. Capture Login stays
native-window-only for now — it's a short-lived, one-time flow (log in,
click Done) where the native window's simplicity is a good fit; nothing in
this design blocks bringing the same embedded pattern to Capture Login
later if wanted, but it is not this epic's job.

## 5. Open questions

None blocking — the one real open technical question (§3) is resolved with
reasoning above. Deferred, not blocking:

- **Screenshot cadence tuning** (JPEG quality/resolution trade-off) is a
  during-implementation judgment call, not a design decision worth
  pre-litigating.
- **CDP video streaming (§3(b))** stays a real, documented future option if
  screenshot-refresh's latency becomes an actual (not hypothetical)
  complaint.

## 6. Scale assessment

**Medium.** Multi-file (new Server Actions in `profile-assist/actions.ts`,
new client UI in `profile-assist-client.tsx`, no changes needed to
`assist-session.ts`'s core session lifecycle since it already exposes the
held `Page` via `getAssistSessionPage()`), single conceptual layer (all
within the existing profile-assist feature), no new external infra. Full
H/V slicing below, no structured-outline/elicitation ceremony needed at
this scale.
