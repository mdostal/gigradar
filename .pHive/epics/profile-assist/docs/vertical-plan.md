# Vertical plan: profile-assist

Three slices, each a working, demoable state. Ordered by risk: the
persistent-session primitive (new to this codebase) gets proven under
the SIMPLEST mode first, before the tool-use loop (also new) is built
on top of it, before that loop is trusted to act unsupervised.

## Slice 1 — Persistent session + Manual/copy-paste mode

Proves the core new primitive (`assist-session.ts`) end to end under
the lowest-risk mode: no LLM browser control at all, just a real
open window + one-shot suggested-copy generation.

- `src/lib/auth/assist-session.ts`: `startAssistSession()`/
  `endAssistSession()`, `globalThis`-pinned session map, idle-timeout
  sweep — mirrors `session-capture.ts`'s exact concurrency idiom.
- `src/lib/apply/profile-suggest.ts`: one non-agentic Anthropic call
  (same shape as `draft.ts`'s existing usage) — reads a page snapshot
  (accessibility tree) + `Config.profile`/`applyProfile`, returns
  suggested copy per field.
- `/profile-assist` page (new nav link), Manual tab only: source
  picker, Start/Done, suggested-copy panel + refresh.
- Per-source profile-edit URL config (small, explicit, alongside each
  source's existing registration — not scraped/guessed).

**Working state:** the owner can open a real GoFractional/A.Team/
Wellfound profile page from inside gigradar, and get LLM-suggested
copy to paste in themselves. Full auto/Guided tabs don't exist yet.

## Slice 2 — Guided mode (the tool-use loop, human-gated)

Builds the tool-use loop for the first time, but every mutating action
requires human approval before it executes — the safest way to prove
the loop's mechanics work before trusting it unsupervised.

- The tool-use loop: `click`/`fill`/`read`/`ask_human` tool schema,
  turn-by-turn Server Action execution against the live `page` from
  Slice 1's session.
- Approval gate in front of `click`/`fill`: proposed action surfaced
  in the UI, Approve/Reject/Edit before it runs.
- Guided tab: transcript panel, pending-approval cards.
- Hard per-session turn cap (config constant).

**Working state:** the owner can watch the LLM propose profile-fill
actions one at a time and approve/reject/edit each before it touches
the page. Full-auto tab doesn't exist yet.

## Slice 3 — Full-auto mode

Reuses Slice 2's loop verbatim, removes the approval gate for
`click`/`fill`, keeps `ask_human` as the mandatory escape hatch.

- Full-auto tab: same transcript panel as Guided, no approval cards —
  actions execute immediately; `ask_human` questions still pause and
  surface in the transcript, blocking only that turn.
- Live-verified end to end against a real source with the owner
  watching, same bar every browser-session-auth mechanism in this
  codebase has cleared before shipping.

**Working state:** all three tabs on `/profile-assist` work. Epic
complete.
