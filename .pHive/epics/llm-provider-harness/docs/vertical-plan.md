# Vertical Plan: llm-provider-harness

Slices A/B ship the `api-key` credential kind's migration to the Vercel AI
SDK (multi-provider). Slices C/D ship the `claude-code-harness` kind
(replacing the non-functional `oauth-token` kind from `llm-credential-modes`).
See `docs/design-discussion.md` for the full research behind each choice.

## Slice A: `ai-sdk-single-shot`

Migrates the `api-key` path's single-shot (non-tool-loop) call sites off
raw `@anthropic-ai/sdk` onto the Vercel AI SDK, multi-provider-ready.
Ships `Config.llmProvider` (`"anthropic" | "openai" | "google"`, default
`"anthropic"`) alongside the existing `llmCredentialKind`.

- `src/lib/config/llm-client.ts`: new `createAiSdkModel(credential)` —
  returns an AI SDK model instance (`anthropic(...)`/`openai(...)`/
  `google(...)`) from `credential.provider`, replacing
  `createAnthropicClient()` for the `api-key` kind. `LlmCredential`
  becomes the discriminated union from design-discussion.md §3.1.
- `resolveLlmCredential()` (`env-store.ts`): reads the right env slot per
  `Config.llmProvider` (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/
  `GOOGLE_API_KEY`), returns `{kind:"api-key", provider, value}` or
  `{kind:"claude-code-harness"}`.
- `/config` UI: a provider selector next to the existing credential-kind
  radio, each with its own key field.
- Call sites migrated (single-shot, forced structured output via
  `generateText({output: Output.object({schema})})`):
  `draft.ts`, `prep.ts`, `extract.ts`, `capture-guidance.ts`,
  `profile-suggest.ts`.
- `Source.fetch()`-boundary call sites
  (`custom-source-recipe.ts`/`custom-llm-source.ts`/
  `gmail-digest-source.ts`) stay on the raw-string path, unchanged —
  same deliberate boundary as `llm-credential-modes`.

## Slice B: `ai-sdk-tool-loops`

Migrates the two multi-turn tool-use call sites, adopting `toolApproval`
as a real upgrade over the current hand-rolled approve/reject plumbing.

- `agent-chat-loop.ts`, `profile-assist-loop.ts`: re-architected around
  `generateText()`'s `tools`/`toolApproval` (`'user-approval'` for
  write-tools, matching the existing pause-for-human-approval UX) instead
  of Anthropic's raw `tool_use`/`tool_result` message loop.
- Their Server Action callers (`src/app/chat/actions.ts`,
  `src/app/profile-assist/actions.ts`) updated for whatever shape change
  results (approval resolution, session/state handling).

## Slice C: `claude-code-harness-single-shot`

Ships the `claude-code-harness` credential kind for the single-shot call
sites only — resolves design-discussion.md §4 open question 1
(structured-output forcing) with a real test before scoping stories in
detail.

- Spike/story 0: verify whether `query()` exposes a schema-forcing option,
  or whether harness-mode forced-JSON relies on the single-allowed-tool
  trick (§2.3 point 4). Decides this slice's actual mechanism.
- `src/lib/config/llm-client.ts`: `createHarnessClient()`/equivalent —
  wraps `query({options: {pathToClaudeCodeExecutable}})`, no credential
  value at all.
- `/config` UI: `claude-code-harness` becomes a real, selectable
  credential kind (currently `oauth-token` exists but is non-functional —
  this slice replaces it).
- Same single-shot call sites as Slice A get a `kind`-branch to the
  harness path.
- Clear, actionable error when `claude` isn't installed/authenticated
  (design-discussion.md §4 open question 4).

## Slice D: `claude-code-harness-tool-loops` (possibly its own follow-up epic)

Harness mode for the two multi-turn tool-loop call sites — gated on
resolving design-discussion.md §4 open questions 2 (approval-gating via
`canUseTool`) and 3 (packaged-build `pathToClaudeCodeExecutable`
resolution). Scoped in detail once Slice C's spike lands.

## Sequencing

A → B → C → D, each independently shippable and mergeable (matching this
project's established per-slice PR-into-dev pattern). Slice A is the
foundation every other slice's config/resolution plumbing builds on.
