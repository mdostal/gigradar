# Design Discussion: Chat Co-Pilot + Self-Tuning

## 0. Trigger

Owner's own words, 2026-09-02, immediately after the ai-match-verification
epic shipped (which itself was triggered by a live false-positive the owner
caught while reviewing real matches):

> "Then you need to fix how we match so we do job position and type better
> and flag things like that -- you also have the full claude AI so we
> should have a toggle to overlay that on top to do AI matching on top of
> heuristic and it should go through and double check that sort of shit and
> verify -- because some product ones may work, but not things like CFO
> unless we decide that fits me"

(that half shipped as ai-match-verification). Then, immediately after:

> "And we had the way we work up to FULL AUTO to be enabled required it to
> craft drafts and then we have to review them, and send them out -- and we
> need to do at least 3 of those before we can enable full auto -- I want
> to leave the draft at semi-auto where it drafts all above a certain
> rating score for me (after I review and approve that) and then will
> review drafts and approve those, until good.
>
> HOWEVER, we have to get the memory plugged in AND the in line chat bot
> that works WITH us so we can say what we don't like, what needs to be
> edited, what should be changed etc -- AND it has to have full skills to
> interact with gig-radar to help tweak and fix BUT all gigradar changes
> require approval before the skill can fire -- it does a plan cycle,
> gives us the approval changes it would make, we approve and submit
>
> all of that is another set of tasks and it requires we run the whole
> thing through the plan execute phases"

## 1. Goal

Two distinct things, and the first is **already built**:

1. **Semi-auto-to-full-auto draft graduation.** Confirm the EXISTING
   `graduated-auto-fire-trust` epic (`src/lib/apply/autofire.ts`,
   `Config.autoFire`) already implements exactly what the owner described:
   draft everything at/above a tier (today: green, via `autoDraftOnScan`),
   human reviews + approves/rejects each one, and once a `(sourceId, tier)`
   pair accumulates `minApprovals` (config-UI default: 3) approved/submitted
   drafts, that pair "graduates" and auto-fire unlocks for it
   (`isGraduated()`). This is real, shipped, tested code — **no new
   scope here**, just a confirmation pass (see Part 4).

2. **A chat co-pilot with real memory and a gated self-tuning skill.** New
   scope. The owner wants to be able to talk to gigradar about *why* a
   match/draft was wrong and have that conversation:
   - **persist** (survive a server restart — today it does not, see Part 2),
   - **propose concrete gigradar config changes** in response (e.g. "add
     'CFO' to redKeywords", "lower the CTO group's rate floor to $175/hr",
     "turn on aiVerify for the drone-photography group"),
   - **never write anything without an explicit approve step** — the owner's
     own words: "it does a plan cycle, gives us the approval changes it
     would make, we approve and submit."

## 2. Current state (researched this session)

`src/lib/chat/agent-chat-loop.ts` (697 lines) is further along than a
first read suggests:

- **The propose-then-approve mechanism already exists and is already used
  for a config-write tool.** `ADD_SOURCE_TOOL` (`add_source`) is one of
  four tools (`update_gig_status`, `generate_draft`, `generate_prep_packet`,
  `run_scan`, `add_source` — five, not four) gated behind the exact
  `pendingApproval` pause/resume pattern the owner is describing:
  a mutating tool call sets `entry.pendingApproval` and the loop returns a
  `{type:"proposal"}` event instead of executing; the UI renders
  this as "the agent wants to: ___ [Approve] [Reject]"; a separate
  `resolveApproval()` call later actually runs (or discards) it. This is
  copied deliberately from `profile-assist-loop.ts`'s identical mechanism.
  **Extending this to cover config edits (redKeywords, rate floors, group
  toggles) is incremental — the propose/approve plumbing, the UI card, and
  `saveConfig()` as the actual write path all already exist and are
  already proven for one config-writing tool.** This significantly
  descopes item 3 in the owner's ask — it is NOT new architecture.

- **There is currently ZERO persistent memory.** `const sessions: Map<string,
  LoopEntry> = ((globalThis as any).__gigradarAgentChatSessions ??= new
  Map())` — an in-process `Map`, pinned to `globalThis` only to survive
  Next.js dev-mode HMR reloads. A real server restart (or the packaged
  Tauri app quitting) loses every chat session and every message in it.
  There is also no separate "learned preference" store of any kind — the
  owner's past feedback ("that's not a CTO role", "I don't want anything
  under $175/hr") currently has nowhere to persist once a chat session
  ends, other than whatever the owner manually re-types into `/config`
  themselves.

- **The dashboard's own reporting confirmed this gap is real, not
  theoretical**: earlier this session, live review of the owner's actual
  matches surfaced a real false positive ("Interim Finance Director"
  green-tiered on the word "interim") that the owner had to catch by eye
  — there was no mechanism for the owner to just *say* "that's wrong" in
  chat and have it become a durable, applied config change.

- **LLM call mechanisms already available** (`src/lib/config/llm-client.ts`):
  `createAiSdkModel()` (multi-provider api-key), `createAnthropicClient()`
  (the raw SDK client `agent-chat-loop.ts` already uses for its multi-turn
  tool loop), `generateHarnessObject()` (local `claude` CLI, no stored
  secret). The chat loop already uses `createAnthropicClient()` — no new
  LLM-calling mechanism is needed for this epic, only new tools on the
  existing loop.

## 3. Proposed approach

### 3a. Confirm the existing draft-graduation flow (no new code, Part 4)

Read `autofire.ts` + the config UI's Auto-fire section end-to-end against
the owner's description; if it matches (expected — it does, based on this
session's research), document that explicitly rather than silently
re-describing it as new scope. If a genuine gap exists (e.g. "drafts all
above a certain rating score" implying a numeric `MatchResult.score`
threshold rather than a green/yellow/red tier gate), surface it as an
explicit, separately-scoped follow-up — never silently absorbed into this
epic's other two slices.

### 3b. Persistent memory (real design fork, Part 5)

Two genuinely separable things the owner's single word "memory" could mean:

1. **Conversation persistence** — a chat session (and its message history)
   survives a server restart, so context isn't lost. Mechanical: a new
   SQLite table (mirrors the existing `application_drafts`/`interview_prep`
   pattern in `src/lib/store/`), written on each `sendMessage()`/
   `resolveApproval()` call, read back to rehydrate `sessions` on first
   access after a restart instead of erroring "no such session."
2. **Learned preferences** — a structured (or semi-structured) record of
   what the owner has said they do/don't want, that FEEDS BACK into
   matching/verification/drafting decisions going forward, not just
   something the chat bot can recall in conversation. This is a much
   bigger design surface (where does a "preference" live — a new table? Is
   it just accumulated redKeywords/coreTitles via the SAME propose/approve
   config-edit tool from 3c, so there's no second parallel "preferences"
   concept? Or free-text notes injected into `ai-verify.ts`'s prompt as
   extra context?).

   This document does NOT pre-decide item 2's shape — see Part 6, Open
   Question 1.

### 3c. Gated self-tuning tool(s) on the existing chat loop (Part 5)

Extend `agent-chat-loop.ts`'s existing tool set with a generic
**"propose a config edit"** tool (not five narrow new tools) —
mirrors `add_source`'s existing shape exactly:

- The model calls it with a structured description of the change (which
  section, what changes) and a plain-language reason.
- Same `pendingApproval` pause: the loop returns a proposal event, never
  executes.
- On approval, `resolveApproval()` runs the SAME `saveConfig()`/
  `ConfigEdits` write path every other config mutation in this codebase
  already uses (config UI, setup wizard, `add_source`) — **no new write
  path, no new validation surface**. `ConfigSchema.safeParse()` still owns
  correctness; a malformed proposed edit fails validation and is reported
  back exactly like a bad `saveConfig()` call from the UI already does.
- Scope boundary (see Open Question 2): this tool edits **gigradar's own
  `config.json`-backed settings only** (rate floors, coreTitles/keywords/
  redKeywords, group toggles like `aiVerify`, source `groupIds`, etc.) —
  it does **not** edit gigradar's source code. The core/user-layer
  boundary in `CLAUDE.md` already forbids the reverse (core code
  hardcoding one user's criteria) — this tool is squarely on the
  config side of that line, never the code side.

## 4. Risks

- **A vague/underspecified proposed edit reaching the approval card.** The
  tool's input schema and system prompt must force the model to name the
  EXACT field(s) changing and to (or old→new value, e.g. "redKeywords: add
  'cfo', 'chief financial'" not "make CFO roles filtered out") — the
  approval card is only trustworthy if the owner can read exactly what
  will change before clicking Approve, mirroring `add_source`'s already-
  concrete input schema (`presetId`/`sourceId`+`url`, never a vague "add a
  source").
- **Preference memory silently drifting matching behavior without the
  owner noticing.** If Open Question 1 resolves toward "preferences feed
  back automatically," every such feedback loop must still go through the
  SAME propose/approve gate as any other config edit — this epic must
  never introduce a second, ungated write path "because it's just
  memory."
- **Conversation-history persistence leaking secrets.** Chat messages may
  reference source ids/settings the owner discusses in plain language —
  never gig-listing scraped content that resembles a credential — but the
  persisted table must never store a resolved `env:` secret value, same
  discipline as every other persistence surface in this codebase
  (`CLAUDE.md`'s Secrets section). In practice: chat messages are
  free-text the owner types plus the model's own text/tool-call summaries
  — no resolved credential value is ever a tool ARGUMENT or RESULT in this
  loop today (config edits pass through unresolved `ConfigEdits`/
  `saveConfig()`, never `loadConfig()`'s resolved secrets) — persisting
  the conversation verbatim carries the same "no secrets in it" guarantee
  the existing plaintext-string chat messages already have.

## 5. Dependencies

- Builds on `graduated-auto-fire-trust` (existing, unchanged) and
  `ai-match-verification` (shipped this session — `GroupConfig.aiVerify`,
  `Gig.aiFlags`) — a future "propose a config edit" call could plausibly
  toggle `aiVerify` itself, closing a real loop (owner says "double-check
  this group's matches with AI" in chat → agent proposes flipping
  `aiVerify: true` → owner approves).
- No dependency on the still-unplanned Mnemosyne integration or
  multi-group-architecture Slices 2-4 — this epic operates on
  `config.groups[0]` under the same single-primary-group convention every
  other pre-Slice-2 UI surface already uses.

## 6. Open questions — RESOLVED (owner's answers, 2026-09-02)

1. **Memory scope — RESOLVED: start simple, design for a future Mnemosyne
   handoff.** Owner's own words: "the memory first version can be simple,
   but if we pull in mnemosyne, it'll help us break out decisions,
   preferences, and conversation history and we can session it etc as we
   go as well." Reading: v1 ships real, working, LOCAL persistence
   (conversation history + a lightweight, gated preferences record — nothing
   silently automatic, per the config-edit tool's own propose/approve
   discipline) — but the storage boundary is drawn so a later Mnemosyne
   integration can absorb/replace it (session breakdown, richer
   decision/preference modeling) without this epic's other pieces (the
   chat loop, the config-edit tool, the UI) needing to change. Concretely:
   memory access goes through a small, dedicated module
   (`src/lib/chat/memory.ts`, Part 5) with a narrow read/write interface
   — never `agent-chat-loop.ts` reading/writing SQLite directly — so
   swapping the SQLite-backed implementation for a Mnemosyne-backed one
   later is a one-file change. Mnemosyne itself is explicitly OUT of
   scope for this epic (see `project_gigradar_needs_own_memory_ground_truth`
   memory: gigradar should be ground truth other agents defer to, and the
   prior Mnemosyne mismatch — its graph tools are code-dependency graphs,
   not a knowledge graph — was never resolved; that resolution is a
   separate, still-unplanned piece of work).
2. **Scope boundary — RESOLVED: config-only.** Confirmed, no source-code
   editing. The tool from 3c only ever calls `saveConfig()`.
3. **UI placement — RESOLVED: BOTH, bigger than originally scoped.**
   Owner's own words: "both, extend the chat page functionality and then
   we need to make it a hover over and interact depending on the page
   you're on with some data around that." Two real surfaces, not one:
   (a) the existing `/chat` page gains persistence + the config-edit tool
   (straightforward extension of what exists); (b) a NEW, genuinely
   separate contextual affordance — a hover/interact trigger available
   on other pages (Dashboard, Drafts, Issues) that opens a chat scoped to
   whatever's under the cursor (a gig row, a draft, a source) with that
   context automatically included, distinct from the general `/chat`
   page's global scope. (b) is real, additional UI surface area — see
   Part 3d.
4. **Scale — RESOLVED: Large.** Full H/V plan + structured outline, same
   rigor as multi-group-architecture — the hover-contextual UI (3d) alone
   is a genuinely new UI pattern this codebase doesn't have yet, not a
   small extension.

## 6a. Part 3d — Contextual hover chat (added after owner's UI answer)

A new, page-aware chat entry point: hovering/interacting with a piece of
data (a gig row on `/`, a draft on `/drafts`, a source row on `/config`,
an issue on `/issues`) surfaces a way to open a chat scoped to THAT
context — the opened session is seeded with the relevant
gig/draft/source's real data (same "trusted data block" framing
`ai-verify.ts`/`draft.ts` already use for untrusted listing content)
so the owner can say "why did this match" or "this rate looks off" without
re-explaining which gig they mean. This reuses the SAME underlying
`agent-chat-loop.ts` session mechanism (Part 5) as the general `/chat`
page — a contextual session is still a real, persisted chat session, just
one that starts with a context-seeding system message instead of empty
history. No second chat engine.
