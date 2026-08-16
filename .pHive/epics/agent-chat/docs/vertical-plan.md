# Vertical plan: agent-chat

Three independently-shippable slices.

## Slice 1 — Core loop + read-only tools + chat page

`src/lib/chat/agent-chat-loop.ts`: the multi-turn tool-use loop
(`globalThis`-pinned, `MAX_TURNS`), `advanceLoopTurn()`/`answerHumanQuestion()`.
Three auto-executing tools: `list_gigs`, `get_gig`, `get_status_summary`.
No `pendingApproval` mechanism needed yet — nothing mutates. `/chat` page
+ Server Actions (`startChatAction`/`sendChatMessageAction`) + a real chat
UI (message list, text input). Ships a genuinely useful "ask questions
about my pipeline" experience with zero write-risk, provable end to end
before any mutation capability is added.

## Slice 2 — Propose/approve write tools

Adds `pendingApproval` to the loop (mirrors `profile-assist-loop.ts`'s
exact mechanism) and 4 tools: `update_gig_status`, `generate_draft`,
`generate_prep_packet`, `run_scan`. Chat UI gains the "the agent wants
to: ___ [Approve] [Reject]" card. `resolveApprovalAction(sessionId,
approve)`.

## Slice 3 — Source-connection tools + screenshots

`start_capture_login`/`finish_capture_login`/`cancel_capture_login`,
`start_gmail_connect`/`disconnect_gmail`, and `take_screenshot` (read-
only, works against whichever live session — capture/verification-
copilot/profile-assist — is currently open). Chat UI gains inline image
rendering for screenshot results.

## Where owner input is unavoidable

None structurally — every tool wraps an already-shipped mechanism. Live
UAT of the actual chat experience (does propose/approve feel right in
practice, are screenshots useful) is the owner's own pass, same as
everything else this session.
