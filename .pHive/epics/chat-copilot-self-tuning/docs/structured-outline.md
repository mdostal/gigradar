# Structured Outline: Chat Co-Pilot + Self-Tuning (Slice 1)

Builds on `design-discussion.md` (revised) and `horizontal-plan.md`/`vertical-plan.md`. Slice 1 only — persistent memory + the gated `propose_config_edit` tool on the existing `/chat` page. Slice 2 (contextual hover chat) is deliberately left lighter here; it builds on Slice 1's chat-loop/memory layer, which doesn't exist yet.

## Part 1 — Detailed approach, Slice 1

### 1a. Store schema (`src/lib/store/schema.ts`, `db.ts`)

Two new `STRICT` tables, mirroring existing conventions exactly
(`application_drafts`'s single-row-per-key-JSON-blob pattern for sessions;
`autofire_decisions`'s append-only audit-log pattern for preferences):

```sql
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id  TEXT PRIMARY KEY,
  history     TEXT NOT NULL,      -- JSON-stringified Anthropic.MessageParam[]
  updated_at  TEXT NOT NULL       -- ISO datetime, set on every save
) STRICT;

CREATE TABLE IF NOT EXISTS chat_preferences (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,               -- nullable: which session this came from, for traceability
  note        TEXT NOT NULL,      -- free-text preference, e.g. "CFO/Finance titles are never a fit for the CTO group"
  created_at  TEXT NOT NULL       -- ISO datetime
) STRICT;

CREATE INDEX IF NOT EXISTS idx_chat_preferences_created ON chat_preferences(created_at);
```

Both are genuinely NEW tables (no `ensureColumn()` migration needed — `CREATE TABLE IF NOT EXISTS` in the shared `SCHEMA_SQL` string is enough, same as every other table in this file).

### 1b. Memory module (`src/lib/chat/memory.ts`, new)

The narrow seam design-discussion.md §6.1 calls for — `agent-chat-loop.ts` never touches these tables directly:

```ts
export function loadSessionHistory(sessionId: string, opts: DbOption = {}): Anthropic.MessageParam[] | undefined;
export function saveSessionHistory(sessionId: string, history: Anthropic.MessageParam[], opts: DbOption = {}): void;
export function deleteSessionHistory(sessionId: string, opts: DbOption = {}): void;
export function recordPreference(note: string, sessionId: string | undefined, opts: DbOption = {}): void;
export function listPreferences(limit?: number, opts: DbOption = {}): { note: string; sessionId: string | null; createdAt: string }[];
```

Plain SQLite reads/writes today (same `getDb()`/`DbOption` convention as `src/lib/store/*`) — a future Mnemosyne-backed implementation swaps this ONE file's internals, nothing else in the epic changes.

### 1c. Chat loop wiring (`src/lib/chat/agent-chat-loop.ts`)

- `startChatSession(sessionId)` — UNCHANGED (still an explicit fresh-start, discarding prior history; this is the existing, correct contract for a real "New chat" action).
- New `resumeChatSession(sessionId): boolean` — calls `memory.loadSessionHistory()`; if found, seeds `sessions.set(sessionId, {history: loaded})` and returns `true`; if not, returns `false` (caller falls back to `startChatSession()`). Additive, non-breaking.
- `endChatSession(sessionId)` — gains one line, `memory.deleteSessionHistory(sessionId)`, alongside the existing in-memory `sessions.delete()`.
- `sendMessage()`/`resolveApproval()` — both already `async function ... Promise<ChatLoopEvent>`; each gains ONE call, `memory.saveSessionHistory(sessionId, entry.history)`, immediately before their `return` (whole-history upsert per public call — simpler and more robust than hooking each of the 7 internal `entry.history.push()` call sites individually, and cheap at this app's real scale: single-user, `MAX_TURNS=20` per call).
- New tool constant `PROPOSE_CONFIG_EDIT_TOOL = "propose_config_edit"`, added to the tool-definitions array (same shape as `ADD_SOURCE_TOOL`'s entry):
  ```ts
  {
    name: PROPOSE_CONFIG_EDIT_TOOL,
    description: "Propose a specific, concrete change to gigradar's own config (rate floors, coreTitles/keywords/redKeywords, group aiVerify toggle, source settings, etc.). Requires explicit user approval before it's written. Never propose a vague change -- name the exact field(s) and old/new value(s) in `summary`.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One human-readable line naming the EXACT change, e.g. \"Add 'cfo', 'chief financial' to the CTO group's redKeywords\". Shown verbatim on the approval card." },
        edits: { type: "object", description: "The exact ConfigEdits-shaped partial object to pass to saveConfig() on approval -- e.g. {\"groups\":[{...the whole edited group...}]} (groups/sources are always sent as a COMPLETE replacement array, same shallow-merge convention every other config write already follows)." },
        reason: { type: "string", description: "Why -- becomes a durable preference note (memory.ts) once approved, so gigradar remembers the REASONING behind the change, not just the change itself." },
      },
      required: ["summary", "edits", "reason"],
      additionalProperties: false,
    },
  }
  ```
- New tool constant `NOTE_PREFERENCE_TOOL = "note_preference"` — runs IMMEDIATELY, no approval (see Decision Point 1: this is a memory write, not a `config.json` write, so it sits outside the "all gigradar changes require approval" gate). Input: `{ note: string }`. Handler calls `memory.recordPreference(input.note, sessionId)`, returns a plain acknowledgment tool_result — added to the SAME read-only-tools-chain-freely dispatch as `list_gigs`/`get_gig`/`get_status_summary`, not the write-tool switch.
- `describeProposal()` gains one case: `case PROPOSE_CONFIG_EDIT_TOOL: return String(input.summary);`
- `executeWriteTool()` gains one branch (mirrors `ADD_SOURCE_TOOL`'s existing branch immediately below it):
  ```ts
  if (tool === PROPOSE_CONFIG_EDIT_TOOL) {
    const saveResult = saveConfig(input.edits as ConfigEdits);
    if (!saveResult.ok) throw new Error(saveResult.error);
    const reason = String(input.reason ?? "");
    if (reason) recordPreference(reason, sessionId);
    return `Applied: ${String(input.summary)}`;
  }
  ```
  `executeWriteTool()`'s signature gains a `sessionId: string` parameter (threaded from `resolveApproval()`, which already has it) purely to pass through to `recordPreference()` — no other existing branch needs it, all pass it through unused.

### 1d. `/chat` page (`src/app/chat/`)

- `actions.ts`'s session-start Server Action calls `resumeChatSession()` first, falls back to `startChatSession()` — mirrors the lib-level fallback exactly, one new branch, not a new action.
- `chat-client.tsx` — on mount, if resumed, render the rehydrated history (the message-shape mapping from `Anthropic.MessageParam[]` to this component's own `{role, ...}` display shape already exists for the live turn-by-turn case in `sendMessage()`'s response handling; reused for the bulk initial render, not reimplemented).
- The proposal card itself needs ZERO changes — confirmed in research: `chat-client.tsx`'s proposal rendering is generic (`{role:"proposal", tool: string, description: string}`, approve/reject buttons), never hardcoded per tool name. `propose_config_edit` renders on the exact same card `add_source` already uses.

### 1e. Confirming the existing draft-graduation flow (no code)

Read `src/lib/apply/autofire.ts` + the config UI's Auto-fire section against design-discussion.md §1 item 1's description. Expected finding (already researched this session): matches exactly — `minApprovals` (config-UI default 3) + `approvedCount()`/`isGraduated()` per `(sourceId, tier)` pair. Document the confirmation in the epic's completion notes; do not touch the code unless a genuine gap surfaces (see Decision Point 2).

## Part 2 — File manifest (Slice 1 only)

| File | Change |
|---|---|
| `src/lib/store/schema.ts` | Add `chat_sessions`, `chat_preferences` tables |
| `src/lib/chat/memory.ts` (new) | `loadSessionHistory`/`saveSessionHistory`/`deleteSessionHistory`/`recordPreference`/`listPreferences` + its own test file |
| `src/lib/chat/agent-chat-loop.ts` | `resumeChatSession()`, `endChatSession()`'s new line, `sendMessage()`/`resolveApproval()`'s new persistence line each, `PROPOSE_CONFIG_EDIT_TOOL`/`NOTE_PREFERENCE_TOOL` definitions + dispatch + `describeProposal()` case + `executeWriteTool()` branch |
| `src/lib/chat/__tests__/agent-chat-loop.test.ts` | New tests for the above; existing tests largely unaffected (memory.ts is mockable the same way other lib calls already are in this file's existing tests, if any exist — else new coverage) |
| `src/lib/types.ts` | `Config.chatAutoApproveConfigEdits?: boolean` |
| `src/lib/config/schema.ts` | `chatAutoApproveConfigEdits: z.boolean().optional()` |
| `src/app/chat/actions.ts` | Session-start action tries `resumeChatSession()` first |
| `src/app/chat/chat-client.tsx` | Render rehydrated history on mount; render the new `"auto_applied"` event as a distinct warning banner |
| `src/app/config/config-client.tsx` | New `chatAutoApproveConfigEdits` checkbox, round-tripped through `configToDraft()`/`draftToEdits()` |
| `src/app/chat/__tests__/*`, `src/app/config/__tests__/*` | Update/add coverage for resume-vs-fresh-start and the new checkbox round-trip |

## Part 3 — Risk registry

| # | Risk | Severity | Mitigation | Owner |
|---|---|---|---|---|
| R1 | A vague `propose_config_edit.summary` reaches the approval card, owner approves something they didn't fully understand | High | Tool description explicitly instructs "name the exact field(s) and old/new value(s)"; `saveConfig()`'s own field-level zod validation is still the final backstop — a malformed `edits` object fails loudly, never silently partially applies | developer |
| R2 | `edits.groups`/`edits.sources` sent as a PARTIAL array by the model, silently dropping other groups/sources (the exact shallow-merge footgun multi-group-architecture's own R2 already flagged) | High | Tool description explicitly states "always sent as a COMPLETE replacement array"; add a dedicated test proving a partial `groups` edit is rejected/doesn't silently drop siblings | developer |
| R3 | `note_preference` running ungated (no approval) is scope creep past "all gigradar changes require approval" | Medium | Explicit Decision Point 2 below — a memory note is not a `config.json`/behavior change; document this boundary clearly so it's a deliberate call, not an oversight | owner (decision), developer (implement) |
| R4 | Whole-history upsert on every `sendMessage()`/`resolveApproval()` call could get slow/large over a very long single-session conversation | Low | `MAX_TURNS=20` per call already bounds a single call's growth; single-user local SQLite; not a real concern at this app's scale — flagged, not mitigated with new code | developer |
| R5 | A resumed session's stale `pendingApproval` (owner closed the tab mid-approval, server restarted) leaves the UI in a confusing state | Medium | `resumeChatSession()` restores `history` only, never a stale `pendingApproval` (that field is never persisted) — a resumed session always starts able to accept a new message; document as explicit resumed-session semantics, not an edge case that's merely "probably fine" | developer |
| R6 | Recording a preference note on EVERY approved `propose_config_edit` (1c) could flood `chat_preferences` with near-duplicate notes over time | Low | Accepted for v1 ("start simple" per the owner's own resolution) — a future Mnemosyne-backed `memory.ts` implementation is exactly where de-duplication/summarization would live; not solved here | developer |

## Part 4 — Elicitation (adversarial stress-test)

**Q: Why does `propose_config_edit` take a raw `edits: object` from the model instead of a more constrained, field-specific schema (e.g. separate `addRedKeyword`/`setRateFloor` tools)?**
A: Considered and rejected — a family of narrow tools would need to grow every time a new `Config`/`GroupConfig` field is added (already true of `roleArea`, `aiVerify`, per-source `groupIds`, autoFire rules...), duplicating `ConfigSchema`'s own job of defining what's valid. One generic tool + `saveConfig()`'s existing validation as the real backstop is the same "don't build a second source of truth for what's a valid Config" discipline this session already applied to `matchGroups()` (new orchestration, zero duplication of `gate()`/`tier()`'s own logic).

**Q: Should `note_preference` really run ungated, given the owner's own words were "ALL gigradar changes require approval"?**
A: Genuinely arguable — flagged as Decision Point 2 below rather than silently assumed. The reading this outline takes: "changes" means `config.json`/behavior changes (what actually affects future scans/matches/drafts), and a preference note is inert until a HUMAN-approved `propose_config_edit` acts on it — closer to the chat bot writing itself a note than to it changing gigradar. But this is a real judgment call the owner should explicitly confirm or override before Part 1c is implemented.

**Q: Does resuming a session with a stale conversation risk the model acting on outdated gigradar state (e.g. discussing a gig that's since changed status)?**
A: No new risk beyond what already exists — every tool call in this loop (`list_gigs`, `get_gig`, etc.) re-reads live state at call time, never trusts anything cached in `history`. A resumed conversation's OLD messages are just conversational context, exactly as stale as a same-session conversation that's been open a while already is.

**Q: Is `chat_sessions` (whole-blob-per-session) the right shape, or should it be one-row-per-message like a "real" chat history table?**
A: Whole-blob is deliberately simpler for v1 (owner's own "start simple" direction) — `LoopEntry.history` is already an in-memory array serialized/deserialized as one unit everywhere it's used; a one-row-per-message table would need to reconstruct that array on every read anyway, for no benefit at this app's scale. This is exactly the kind of internal-shape decision `memory.ts`'s narrow interface (1b) is designed to let a future Mnemosyne swap change without touching any caller.

## Part 5 — Decision points — RESOLVED by the owner, 2026-09-02

1. **`edits` shape validation strictness** (Risk R1/R2): ship with the two-layer approach (plain-English tool instructions + `saveConfig()`'s zod backstop); add a stricter pre-flight only if real usage shows the model actually proposes malformed/partial edits often enough to be annoying.
2. **`note_preference` approval gate**: **confirmed ungated.** Owner's own words: "only the config and impactful changes -- changing a resume, helping you find things, etc -- [need approval]." Memory notes are never gated; `propose_config_edit` (and any other future write tool touching `config.json`/real state) always is.
3. **NEW scope surfaced by this decision — a per-proposal auto-fire toggle with a mandatory warning banner.** Owner's own words: "we should have a toggle enabling it to auto fire with a popup warning, but by default, it does a plan, says -- i'm going to change your preferences to x,y,z, and add the indeed channel -- go? and you say approve and it goes." Concretely, added to Slice 1 (same tool, small additive scope, not a new slice):
   - New `Config.chatAutoApproveConfigEdits?: boolean` — **off by default** (the "by default, it does a plan... you say approve" case is the unchanged, already-designed `pendingApproval` flow above).
   - When `true`: `propose_config_edit`'s handler still builds the exact same proposal (summary/edits/reason), but `agent-chat-loop.ts` immediately auto-executes it (the same `executeWriteTool()` call `resolveApproval(approve:true, ...)` would have made) instead of pausing on `pendingApproval` — mirrors `graduated-auto-fire-trust`'s existing "a toggle lets a normally-gated action skip the gate" precedent (`autoFire.killSwitch`/per-pair `enabled`), same shape, different tool.
   - The returned event is a NEW, distinct `ChatLoopEvent` variant — `{ type: "auto_applied"; tool: string; input: Record<string, unknown>; description: string }` — never silently folded into the plain `"message"` event, so `chat-client.tsx` can render a visually distinct "⚠ Auto-approved: {description}" banner (the owner's own "popup warning" requirement) instead of a normal chat bubble. This is the ONE new UI element Slice 1 needs (small: a styled banner variant on the existing message-list rendering, not a new page/modal).
   - A config-UI toggle for `chatAutoApproveConfigEdits` (in the same `/config` Settings area other opt-in behavior flags like `autoDraftOnScan` already live) is in scope for Slice 1 — same `CheckboxField` pattern, no new UI paradigm.
4. **Confirming vs. re-verifying the existing draft-graduation flow (1e)**: read-only confirmation pass, not new code, unless it surfaces a genuine gap (e.g. "drafts all above a certain rating score" implying a numeric threshold the current tier-only gate doesn't have) — if so, that gap gets its own follow-up, never silently folded into this epic's scope.

### Part 1f — `chatAutoApproveConfigEdits` (added after Decision Point 3)

- `src/lib/types.ts`: `Config.chatAutoApproveConfigEdits?: boolean`, doc comment mirrors `autoDraftOnScan`'s "omitted/false are identical, no tri-state" pattern exactly.
- `src/lib/config/schema.ts`: `chatAutoApproveConfigEdits: z.boolean().optional()` on `ConfigSchema`.
- `src/lib/chat/agent-chat-loop.ts`: the `PROPOSE_CONFIG_EDIT_TOOL` branch in the internal turn-loop (where a `pendingApproval` would normally be set, alongside every other write tool) gains a branch: if `config.chatAutoApproveConfigEdits === true` for this specific tool, skip setting `pendingApproval` and instead call `executeWriteTool()` immediately, returning the new `"auto_applied"` event. Every OTHER write tool (`update_gig_status`, `generate_draft`, etc.) is explicitly UNCHANGED — the toggle only ever applies to `propose_config_edit`, per the owner's own "only the config and impactful changes" framing being specifically about config edits, not gig-status/draft actions (which already have their own separate, existing tier/applyProfile guardrails, not this toggle).
- `src/app/config/config-client.tsx`: one new `CheckboxField` near the other opt-in scan/draft toggles, `draft.chatAutoApproveConfigEdits` round-tripped through `configToDraft()`/`draftToEdits()` the same way `autoDraftOnScan` already is.
- `src/app/chat/chat-client.tsx`: handle the new `"auto_applied"` event type — render as a distinct warning-styled banner (not the plain message bubble, not the approve/reject proposal card — a third, new visual state).
