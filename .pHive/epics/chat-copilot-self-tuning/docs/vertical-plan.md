# Vertical Plan: Chat Co-Pilot + Self-Tuning

Minimum cross-stack increments — each slice leaves gigradar in a genuinely
working, live-verifiable state.

## Slice 1 — Persistent memory + the gated config-edit tool, on the existing /chat page

**What ships**: `chat_messages`/`chat_preferences` tables, `memory.ts`,
chat-loop rehydration (a restart no longer loses history), the
`propose_config_edit` tool (same `pendingApproval`/approval-card pattern
`add_source` already has), and the `/chat` page rendering both persisted
history and the new proposal type. Also: the short confirmation pass on
the existing draft-graduation flow (autofire.ts), documented, not
rebuilt.

**Working state at the end of this slice**: the owner can have a real
conversation on `/chat` ("that Interim Finance Director match was wrong,
add CFO-adjacent titles to the CTO group's redKeywords"), the agent
proposes the exact `ConfigEdits` change, the owner approves it on the SAME
card UI `add_source` already uses, `saveConfig()` writes it for real — and
if the server restarts mid-conversation, the history and any preference
notes recorded so far are still there. This is the full "plan cycle, gives
us the approval changes it would make, we approve and submit" loop the
owner asked for, just not yet reachable from anywhere but the dedicated
`/chat` page.

**Why first**: this is the actual value the owner asked for (memory +
gated self-tuning) — the hover-contextual UI in Slice 2 is a second,
convenient ENTRY POINT into the exact same mechanism, not a different
mechanism. Shipping Slice 1 alone already closes the loop end-to-end.

## Slice 2 — Contextual hover chat across pages

**What ships**: the reusable hover/interact trigger + panel component,
wired into the Dashboard (per gig row), Drafts (per draft), and Config
(per source row) — each opening a Slice-1 chat session pre-seeded with
that row's real data via the same trusted-data-block pattern
`draft.ts`/`ai-verify.ts` use.

**Working state at the end of this slice**: the owner can hover a gig on
the dashboard and immediately ask "why did this match" without navigating
to `/chat` and re-describing which gig they mean — the full owner-
described UI ("both... extend the chat page... AND... hover over and
interact depending on the page you're on").

**Why second**: genuinely new UI surface area (design-discussion.md §6a)
with no working-mechanism dependency Slice 1 doesn't already provide —
this is presentation/entry-point work layered on a fully working Slice 1,
same "2 is additive UI over data 1 already produces" relationship
multi-group-architecture's Slices 2-4 had to its Slice 1.

## Explicitly deferred, not part of this epic

- **Mnemosyne integration.** design-discussion.md §6.1's whole point:
  `memory.ts`'s narrow interface is the seam a future epic swaps behind,
  not something this epic builds. Still blocked on the unresolved
  graph-tools-vs-knowledge-graph mismatch (see
  `project_gigradar_needs_own_memory_ground_truth` memory) — a separate
  decision, not implicitly bundled here.
- **Automatic (ungated) preference-driven matching changes.** The owner's
  answer was explicit: preferences are recorded, but any actual behavior
  change still goes through `propose_config_edit`'s approve step. A future
  epic could revisit "should a sufficiently-confirmed preference
  auto-apply" — not this one.

## Sequencing notes

- Slice 1 and Slice 2 are sequenced (2 depends on 1's chat-loop/memory
  layer existing) — unlike multi-group-architecture's Slices 2/3, these
  are NOT independent, since Slice 2 is explicitly "the same mechanism,
  new entry points."
- Each slice gets its own PR(s) into `dev`, verify-then-merge per standing
  process.
