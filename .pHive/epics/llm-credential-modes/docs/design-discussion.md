# Design Discussion: llm-credential-modes

## 1. Goal

Owner, verbatim, across several messages (settled, not up for debate):

> "you need to realize we also have localized claude code and other ways of
> working, so we have to allow for more than just the key"
> "i have a system wide key with claude code -- that should suffice, it
> should be able to use it -- ... it is still BYOK or BYOSubscription"
> "i also have long term tokens with claude and it is different than an API
> key"

Concretely: gigradar's LLM calls currently REQUIRE a raw `ANTHROPIC_API_KEY`
pasted into `/config`. Add a second, equally-first-class credential kind: a
long-lived OAuth token (the exact thing `claude setup-token` -- a real
subcommand on this machine's own `claude` CLI, confirmed via `claude
--help` -- generates) so the owner's existing Claude subscription/Claude
Code auth can be used instead of provisioning a separate raw API key.

## 2. Research (done before designing, not assumed)

- **`@anthropic-ai/claude-agent-sdk` -- rejected.** Downloaded and inspected
  its real `.d.ts` (`sdk.d.ts`) directly, not just its README. It is an
  agentic-loop wrapper: `query()` spawns/drives a full `claude` CLI-style
  session with its own permission model (`canUseTool`, `permissionMode`),
  its own MCP-server-shaped custom-tool mechanism, and its own message
  protocol. There is no simple "give me one structured response" call
  compatible with what gigradar's 9 real LLM call sites already do (a
  single `messages.create()` with a forced `tool_choice` for JSON
  extraction, or gigradar's OWN hand-rolled multi-turn loops in
  `agent-chat-loop.ts`/`profile-assist-loop.ts` -- which already work,
  tested, and shipped). Adopting the Agent SDK would mean rewriting every
  call site's control flow for zero functional gain over what already
  exists, just to reach the SAME underlying credential problem that has a
  much smaller real fix (below).
- **The real fix: `@anthropic-ai/sdk`'s own client already supports this.**
  Read `node_modules/@anthropic-ai/sdk/client.d.ts` directly: the `Anthropic`
  constructor takes EITHER `apiKey` (sent as `x-api-key`) OR `authToken`
  (sent as a Bearer token, `Authorization: Bearer ...`), and even defaults
  `authToken` to `process.env['ANTHROPIC_AUTH_TOKEN']` when neither is
  passed explicitly. This is exactly the shape of a `claude setup-token`
  long-lived OAuth token -- a Bearer credential, not an `x-api-key` one.
  **Zero changes needed to any of the 9 call sites' actual LLM logic**
  (tools, structured output, multi-turn loops all keep working exactly as
  written) -- this is a pure credential-resolution-and-client-construction
  change.
- **All 9 real call sites, grepped directly** (not assumed from the
  original epic-request's guessed list): `src/lib/apply/profile-suggest.ts`,
  `src/lib/apply/profile-assist-loop.ts`, `src/lib/apply/draft.ts`,
  `src/lib/apply/prep.ts`, `src/lib/chat/agent-chat-loop.ts`,
  `src/lib/auth/capture-guidance.ts`, `src/lib/sources/custom-source-recipe.ts`,
  `src/lib/sources/gmail-digest-source.ts`, `src/lib/profile-ingestion/extract.ts`.
  Every single one already follows the IDENTICAL discipline: `apiKey:
  string` is a REQUIRED parameter resolved by the caller, `new
  Anthropic({apiKey})` constructed fresh inside the function, never at
  module scope. This uniformity is what makes a single shared factory
  function a clean, low-risk swap across all 9 -- the pattern was already
  centralized in spirit, just not in one shared helper.
- **11 further call sites resolve the credential itself** (Server
  Actions calling `readEnvVar("ANTHROPIC_API_KEY")`, plus
  `scheduler/index.ts` and `runner.ts` reading `process.env.ANTHROPIC_API_KEY`
  directly for the cron path) -- these all need to resolve a credential
  *kind* now, not just a raw string.

## 3. Design decisions

### 3.1 Config shape

New top-level `Config.llmCredentialKind?: "api-key" | "oauth-token"`
(default/absent = `"api-key"`, byte-identical to today's only behavior --
zero migration needed for existing installs). The env-var reference itself
stays the SAME single slot (`env:ANTHROPIC_API_KEY` in `.env`, resolved via
the existing `env-store.ts` convention) regardless of kind -- a user
storing an OAuth token pastes it into the SAME field the raw key used to
go, just flips the kind selector next to it. This deliberately mirrors
`session-backend.ts`'s existing "local vs Portunus" selector shape (an
owner-picked mode, config-driven, both paths real) rather than inventing a
third pattern.

### 3.2 One shared client factory

New `src/lib/apply/llm-client.ts`: `createAnthropicClient(credential:
{kind: "api-key" | "oauth-token"; value: string}): Anthropic` -- passes
`value` as `apiKey` or `authToken` based on `kind`. All 9 call sites swap
`new Anthropic({apiKey})` for `createAnthropicClient(credential)`, and
their own `apiKey: string` parameter becomes `credential: LlmCredential`
(a tiny, mechanical, low-risk change per site -- the surrounding
prompt/tool/parsing logic is completely untouched).

### 3.3 One shared resolution helper

New `resolveLlmCredential()` in `env-store.ts` (alongside the existing
`readEnvVar()`/`setEnvVar()`): reads `Config.llmCredentialKind` (raw config,
same raw-vs-resolved discipline as everywhere else) plus the SAME
`ANTHROPIC_API_KEY` env slot, returns `{kind, value} | undefined`. Every
Server Action / scheduler / runner call site that currently does `const
apiKey = readEnvVar("ANTHROPIC_API_KEY")` swaps to `const credential =
resolveLlmCredential()`.

### 3.4 Config UI

`/config`'s existing "Anthropic API key" field gains a small kind selector
(radio: "API key" / "Long-lived OAuth token (`claude setup-token`)") right
next to it -- same input field either way, just a label/kind flip, plus a
one-line hint pointing at running `claude setup-token` in a terminal and
pasting the printed token.

### 3.5 Failure behavior

An `oauth-token`-kind credential that the API rejects (expired, malformed,
wrong kind) surfaces the SAME actionable error path every other LLM call
already has (`actionErr(e)` from the real Anthropic SDK's own thrown
error) -- no silent fallback to a different mode, no swallowed failure.

## 4. Scale assessment

**Medium.** Two new small files (`llm-client.ts` factory,
`resolveLlmCredential()` in existing `env-store.ts`), one config schema
field, then a mechanical (not architecturally risky) swap across ~20 real
call sites. No new external dependency, no new runtime concept beyond
"pick which of two ways this one credential gets sent." Vertical slices
below.
