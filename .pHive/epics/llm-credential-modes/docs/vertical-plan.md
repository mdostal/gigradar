# Vertical Plan: llm-credential-modes

## Slice 1: `credential-core`

Ships the real, working infrastructure end to end for ONE real call site
(`custom-llm-source.ts`'s extraction path via `custom-source-recipe.ts` --
the most-used LLM path in the app) plus the config UI to set it -- a
genuinely working state: an owner can flip to oauth-token mode, paste a
`claude setup-token` token, and successfully run a real scan.

- `Config.llmCredentialKind` schema field.
- `resolveLlmCredential()` (`env-store.ts`).
- `createAnthropicClient()` (`llm-client.ts`, new file).
- `/config` UI: kind selector next to the Anthropic API key field.
- `custom-source-recipe.ts` migrated to the new credential/factory.

## Slice 2: `credential-everywhere`

Migrates the remaining 8 lib call sites and their ~11 Server
Action/scheduler/runner resolution call sites to the same
`resolveLlmCredential()`/`createAnthropicClient()` pair. Mechanical per
call site (swap `apiKey: string` param for `credential: LlmCredential`,
swap `readEnvVar("ANTHROPIC_API_KEY")` for `resolveLlmCredential()`) --
same pattern proven in Slice 1, applied everywhere else in one pass since
splitting further just adds coordination overhead for no real risk
reduction (every site follows the identical existing discipline already).

Call sites: `profile-suggest.ts`, `profile-assist-loop.ts`, `draft.ts`,
`prep.ts`, `agent-chat-loop.ts`, `capture-guidance.ts`,
`gmail-digest-source.ts`, `extract.ts`, plus their Server Action callers
(`src/app/actions.ts`, `src/app/chat/actions.ts`, `src/app/config/actions.ts`,
`src/app/issues/actions.ts`, `src/app/profile-assist/actions.ts`) and the
cron path (`src/scheduler/index.ts`, `src/lib/apply/runner.ts`).
