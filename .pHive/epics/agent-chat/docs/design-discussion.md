# Design discussion: agent-chat

## 0. Prelude

**NORTH STAR**: task raised directly by the owner mid-UAT: "we have to be
able to run the updates to the accounts and stuff and have a solid agent
chat bar in the app, as i'll be having it run through and update some
things... it'll need screenshots and the gamut." Clarified via 2 direct
questions:

1. **Autonomy: propose then approve, always.** Every mutating action the
   agent wants to take is proposed in the chat UI and requires an explicit
   click before it executes — never auto-writes. Matches this repo's
   existing posture everywhere else (drafts, auto-fire, profile-assist
   guided mode).
2. **Scope: the 5 existing MCP-tool capabilities (list/get/update-status/
   status-summary/run-scan) + the newer draft/prep-packet actions, PLUS
   managing source connections (Capture Login, Gmail connect/disconnect)
   from chat** — a genuinely broad tool surface, not a narrow Q&A bot.
   Screenshots requested explicitly: when a tool touches a live browser
   session, the chat should be able to show what's actually on the page.

## 1. What already exists to build on (not reinvent)

- **`profile-assist-loop.ts`** is THE established multi-turn LLM tool-use
  loop in this repo, and already solves the exact "propose then approve"
  mechanic this epic needs: a mutating tool call sets
  `entry.pendingApproval` and the loop returns without executing; a
  separate `resolveApproval(sessionId, approve, editedValue?)` call later
  executes (or rejects) it and feeds the result back into
  `entry.history` so the loop continues. This epic reuses the SAME
  pause/resume shape for every mutating tool, not a new mechanism.
- **`src/mcp/server.ts`**'s 5 tools are thin wrappers directly over
  `src/lib` functions (`listGigs`/`getGig`/`setStatus`/`runRadar`/
  `computeStatusStrip`) — this epic's own read/write tools wrap the SAME
  underlying functions. Not a code-sharing relationship with the MCP
  server itself (different transport: stdio vs. an in-app loop), but zero
  duplicated business logic — both are thin shells over the same `src/lib`
  surface.
- **`generatePrepPacket()`/`generateDraft()`** (career-crm, assisted-
  apply-drafting epics) — reused directly for the draft/prep-packet
  tools, same as every other consumer.
- **`openCopilotSession`/`getCopilotPage`/`closeCopilotSession`**
  (verification-copilot), **`startCapture`/`getCapturePage`/
  `finishCapture`/`cancelCapture`** (session-capture-ui), **`buildAuthorizationUrl`/
  `startGmailOAuthAction`/`disconnectGmailAction`** (email-digest-ingestion)
  — all reused as-is for the source-connection-management tools; this
  epic adds a chat-shaped front door to already-built mechanisms, not new
  session-management logic.

## 2. The tool-use loop: a new module, not a fork of profile-assist-loop.ts

Genuinely a different domain (gigradar's own data/actions vs. driving a
live third-party page), so this is a NEW module,
`src/lib/chat/agent-chat-loop.ts`, but reuses profile-assist-loop.ts's
proven SHAPE exactly: `globalThis`-pinned session map (HMR survival),
`MAX_TURNS` cap, `advanceLoopTurn(sessionId, apiKey, ...)` /
`resolveApproval(sessionId, approve)` / `answerHumanQuestion(...)` (if a
tool needs to ask a clarifying question), forced tool-use per turn
(`tool_choice: {type: "any"}`), BEGIN/END-delimited framing for any
untrusted content a tool result carries (a gig's own `description` field,
same discipline as every other LLM call site).

## 3. The tool surface (design-discussion, not final code)

**Auto-executing (read-only, never mutates, no approval needed):**
- `list_gigs(filter)` — wraps `listGigs()`.
- `get_gig(key)` — wraps `getGig()`.
- `get_status_summary()` — wraps `computeStatusStrip()`.
- `take_screenshot(sessionKind, sessionId)` — captures the current page of
  an ACTIVE browser session (capture-login / verification-copilot /
  profile-assist — whichever the user has open) via `page.screenshot()`,
  returned as an `image` content block the chat renders inline. Read-only
  by construction — cannot mutate anything, so no approval gate.

**Propose-then-approve (every one of these sets `pendingApproval` and
waits for an explicit click):**
- `update_gig_status(key, status)` — wraps `setStatus()`.
- `generate_draft(key)` — wraps `stageApplication()`.
- `generate_prep_packet(key)` — wraps `generatePrepPacket()` +
  `saveInterviewPrep()`.
- `run_scan()` — wraps `runRadar()`. Given this can take real time
  (network-bound, same caveat the MCP tool's own description already
  carries — "don't call it repeatedly in a tight loop"), approval here
  also functions as a "yes, I really want to kick off a scan right now"
  gate, not just a mutation guard.
- `start_capture_login(sourceId)` / `finish_capture_login(sessionId)` /
  `cancel_capture_login(sessionId)` — wraps the existing session-capture
  functions. `start` opens a REAL browser window (same "this is a real,
  visible action, not invisible background work" reasoning every other
  approval-gated tool shares).
- `start_gmail_connect(sourceId)` / `disconnect_gmail(sourceId)` — wraps
  the existing Gmail OAuth actions.

## 4. Screenshots: read-only, always available mid-flow

`take_screenshot` is the ONE tool the agent can call freely, including
immediately after proposing (but before approval of) a browser-opening
action like `start_capture_login` — once that's approved and the session
exists, the agent can screenshot it on the next turn to show the user
what the real browser window currently looks like, without them needing
to alt-tab. Returned as a `image/png` base64 content block — Anthropic's
Messages API supports image content blocks natively in tool results, same
mechanism this epic's chat UI renders directly (an `<img>` from a data
URI, no new infra).

## 5. Chat UI: a new page, not a floating overlay (v1 decision)

A dedicated `/chat` page (nav item added), not a persistent docked panel
over every other page — simpler v1 scope (no cross-page state/portal
concerns), matches how `/profile-assist` already gets its own page for a
similar "real, focused interaction" reason. A floating global chat bar is
explicitly a possible v2, not ruled out, just not this epic's v1 scope.

UI shape: a message list (user/assistant turns, tool calls rendered as
distinct "the agent looked something up" or "the agent wants to: ___,
[Approve] [Reject]" cards — never silently folded into prose), a text
input, and inline image rendering for screenshot results.

## 6. Safety (non-negotiable, per this repo's existing convention)

- Every mutating tool is approval-gated — no exceptions, no "trusted"
  fast path. This is the epic's entire premise per the owner's own
  explicit answer.
- `apiKey` resolved fresh per call via `readEnvVar()` (Server Action
  context), never module-scope — same discipline every LLM call site in
  this repo already follows.
- A gig's own `description`/title (untrusted, scraped content) reaching
  the model via `get_gig`'s result is BEGIN/END-delimited the same way
  every other LLM call site treats scraped content — a prompt-injection
  attempt embedded in a job listing must not be able to get the agent to
  silently approve/execute anything; the approval gate itself is the
  actual defense (even a successfully-injected instruction can only ever
  produce a PROPOSAL, never an executed action).
- Screenshots never captured/sent without the user having a live,
  intentionally-opened session already — `take_screenshot` throws a
  specific "no active session" error otherwise, never silently returns a
  stale/wrong-session image.

## 7. Scale assessment: **Large**

A new multi-turn tool-use loop (second one in the codebase), ~10 tools
spanning read/write/browser-session domains, a new page, and real UX for
propose/approve + inline images. Full H/V slicing.

## 8. Where owner input is genuinely unavoidable

None for the mechanism itself — every tool wraps an already-built,
already-tested function. Live verification of the full chat experience
(does approval UX feel right, are screenshots actually useful in
practice) is the owner's own UAT, same as everything else this session.
