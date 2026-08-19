# Design Discussion: llm-provider-harness

Supersedes the oauth-token half of `llm-credential-modes` (epic docs at
`.pHive/epics/llm-credential-modes/`). That epic's `api-key`-mode plumbing
(`Config.llmCredentialKind`, `resolveLlmCredential()`, the raw-vs-resolved
secret discipline) is the right shape and is kept — but its `oauth-token`
mechanism (extract a `claude setup-token` value, pass it as
`Anthropic({authToken})`) is **proven non-functional by a live test** and
needs full replacement, not a patch. Scope also grew: the owner wants the
`api-key` path generalized across providers, not just Anthropic.

**Status: design doc only, per owner's explicit instruction ("just the
design doc first"). No vertical-plan.md, no story YAMLs, no code changes
yet.**

## 1. Goal (owner, verbatim, across this session)

> "we cannot use the harness subscription of claude code y[et via a raw
> token]" (confirming the live-test finding below)
>
> "use the vercel agent sdk so it auto is across them for API Keys and we
> build the local subscription for dealing with codex, claude, etc as well
> -- figure out OR see if we can use HEIMDALL for this as well and package
> it together so that we have heimdall for setting up routes, portunus for
> the secrets and then push this across"

Concretely: two independent axes, not one.
- **Axis 1 — which provider** (Anthropic, OpenAI, Google/Gemini, ...).
- **Axis 2 — how authenticated**: a raw API key (BYOK) vs. the owner's own
  already-authenticated local CLI subscription (BYOSubscription — Claude
  Code, Codex, etc.).

Optionally, WHICH provider+lane to pick can be advised by the owner's own
Heimdall (lane-health router), with Portunus resolving whatever secret
that pick requires — but that composition happens **outside gigradar's
core**, per the constraints in §2.4.

## 2. Research (done before designing, each item live-verified this
session, not assumed)

### 2.1 The live test that killed the original `oauth-token` design

Pulled the owner's real `claude-code-oauth` Portunus secret into an
isolated 0600 file (never printed to any transcript), constructed
`new Anthropic({authToken: token, defaultHeaders: {"anthropic-beta":
"oauth-2025-04-20"}})` (the exact mechanism `createAnthropicClient()`
ships today), and called `messages.create()` against the real
`api.anthropic.com`. Result, consistent across 4 attempts over ~15s:
`429 rate_limit_error`, a real unique `request_id` each time (so it's a
genuine server round-trip, not a local failure), generic non-descriptive
message, no `retry-after` header. A `claude setup-token` long-lived token
is **rejected** when extracted and reused as a bare Bearer credential
outside the real `claude` process.

### 2.2 T3 Code (github.com/pingdotgg/t3code) proves the correct mechanism

The owner pointed at this as an existence proof — it drives Claude Code
(and Codex, Cursor, Grok Build, OpenCode) subscriptions from mobile/web/
desktop apps. Verified directly in its source (cloned, read, deleted the
clone):

- **Does not extract or reuse tokens at all.** Uses
  `@anthropic-ai/claude-agent-sdk`'s `query()` with
  `pathToClaudeCodeExecutable` pointed at the locally-installed `claude`
  binary — **spawns the real, already-authenticated CLI as a subprocess**
  and drives it through the SDK's own protocol. No token ever crosses the
  process boundary. This is the exact package this session rejected
  earlier in `llm-credential-modes` — rejected on tool-interface-mismatch
  grounds, never tested for whether it solves the auth problem. It does.
- **Custom tools**: exposed via an MCP server registered through the
  SDK's `mcpServers` option, as an **HTTP-type** entry (bearer-authed
  endpoint T3 Code's own backend hosts) — because T3 Code drives *remote*
  machines. Tool approval flows through the SDK's `canUseTool` callback +
  `permissionMode`.
- **Remote sessions**: confirmed local-daemon + thin-relay shape. The
  process holding the real subprocess/auth runs on the owner's own
  machine; a Cloudflare Worker relay is control-plane-only ("intentionally
  not in the hot path... regular API/WebSocket traffic goes directly
  between client and the selected environment" — its own README). Directly
  answers the owner's "remote sessions" question: yes, this generalizes,
  and it's the same local-daemon-holds-the-real-auth shape gigradar's
  Electron/Tauri modes already assume.
- **Provider abstraction**: real driver-per-provider pattern
  (`ClaudeDriver`/`CodexDriver`/`OpenCodeDriver`/... implementing a common
  interface), but each driver's actual subprocess/SDK plumbing is
  provider-specific (Codex uses its own app-server protocol, not the same
  mechanism as Claude) — confirms a shared interface is realistic, a
  shared *implementation* is not.

### 2.3 `@anthropic-ai/claude-agent-sdk` — live-verified on this machine

All four claims below were actually run, not read from docs:

1. **Raw `claude -p` uses harness auth with zero API key** — confirmed
   (`ANTHROPIC_API_KEY` unset, `claude -p "..." --output-format json`
   succeeded with real usage/cost fields).
2. **`--json-schema` gives real, harness-authenticated structured output**
   — confirmed (`structured_output` field matched a real schema exactly).
   Directly covers `prep.ts`/`draft.ts`/`extract.ts`'s forced-JSON need —
   *for the raw CLI*; see the open question in §5 about whether `query()`
   itself exposes an equivalent, or whether harness-mode structured output
   has to rely on the single-allowed-tool trick from point 4 instead.
3. **`query()` spawns the real local `claude` binary and inherits its
   auth** — confirmed. `options.pathToClaudeCodeExecutable` pointed at
   `/Users/mdostal/.local/bin/claude`, **no `apiKey`/`authToken` passed at
   all**, returned a real successful result. This is the load-bearing fact
   the original epic's rejection never checked.
4. **Custom multi-turn tool-use, in-process, no separate server** —
   confirmed. `tool()` + `createSdkMcpServer()` registers a typed custom
   tool (e.g. a `mark_applied`-shaped tool) **in-process** (no HTTP hop —
   simpler than T3 Code's version, which only needs HTTP because it
   controls *remote* machines; gigradar's case is single-machine). The
   model correctly called it with typed args.
5. **Session resume** (`options.resume: sessionId`) is a documented,
   real API surface — not live-tested, but consistent with the session_id
   every `query()` call returns.

### 2.4 Heimdall — live-verified, and it does NOT integrate with Portunus

Located at `~/Documents/work/pantheon/heimdall`. It's a **lane
health-sensor + advisory router** for the owner's Pantheon multi-agent
ecosystem, not a network/LLM router in the OpenRouter/LiteLLM sense. A
"lane" is a `provider × account × runtime` triple; it watches up/down/
out-of-credit/degraded state and answers `GET /available-route?task-
type=...` with a lane pick plus a `credential_ref` — **never a raw
secret**, by its own `CredentialSource` abstraction's stated design intent
("swapping in Portunus later doesn't touch calling code").

**Critical constraint, the owner's own recent, explicit ruling** (5 days
before this research, `docs/decisions/DEC-hdl-portunus-deferral.md` in
that repo): *"no plugin should be directly implementing another plugin...
for standalone, no portunus, have a local .env and just do that, don't
overthink shit."* A prior `PortunusCredentialSource` was built, rejected,
and removed. Today Heimdall reads secrets from a local gitignored `.env`
only, via `EnvCredentialSource`.

**What this means for gigradar**: Heimdall can only ever be a
*which-provider-should-I-use* advisor that hands back a reference, never
a secret. Composing it with Portunus is explicitly not Heimdall's job (per
the owner's own ruling) and is **absolutely not gigradar's job either** —
per CLAUDE.md's core/user-layer boundary, gigradar core must know nothing
about the owner's personal infrastructure (Heimdall, Portunus, or any
other private tool). Both would only ever plug in from *outside* the repo,
config-driven, the same shape BYOK/BYOSubscription credential *sources*
already use. See §4 for the concrete boundary.

### 2.5 Vercel AI SDK — live-verified fit against gigradar's real requirements

Installed-package inspection (`ai@7.0.67`, `@ai-sdk/anthropic@4.0.39`,
`@ai-sdk/openai@4.0.42`, `@ai-sdk/google@4.0.45`), not stale training-data
assumptions about the API shape (which has changed across major versions).
Checked against gigradar's actual four hard requirements, one per real
call site:

| Requirement | Real call site | Verdict |
|---|---|---|
| Forced structured JSON (never free text) | `draft.ts`, `prep.ts`, `extract.ts` | **Fit.** `generateText({..., toolChoice: {type:'tool', toolName}})` forces one named tool, same shape as today's `tool_choice`. **`generateObject()` is deprecated in v7** — use `generateText({..., output: Output.object({schema})})`, not the older pattern. |
| Multi-turn custom tool-use with a human-approval gate | `agent-chat-loop.ts`, `profile-assist-loop.ts` | **Fit, and better than gigradar's current hand-rolled loop.** v7's `toolApproval` config (`'not-applicable' \| 'approved' \| 'denied' \| 'user-approval'`, static or per-call function) natively pauses the loop at `state: 'approval-requested'` and resumes on an explicit approval/denial with an HMAC-signed `approvalId`. Worth adopting as a real upgrade, not just a port. |
| Native PDF resume input | `extract.ts` | **Fit.** Generic `FilePart` (`{type:'file', data, mediaType, filename?}`) — not Anthropic-specific, same shape as `buildResumeContentBlock()` already uses. |
| Per-call, caller-resolved credential (never module-scope) | every site | **Fit.** `createAnthropic({apiKey})` is a normal per-call constructor — matches gigradar's existing discipline exactly. |

Recommendation from that research: adopt the AI SDK for the `api-key`
path. Not just "no worse than raw `@anthropic-ai/sdk`" — `toolApproval` is
a genuinely better primitive than gigradar's current approve/reject
plumbing, independent of the multi-provider win.

Scope boundary the research fork itself flagged: this covers ONLY the
`api-key` credential path. It does not touch harness/subscription mode —
that's `@anthropic-ai/claude-agent-sdk` territory (§2.3), and the two
mechanisms compose at gigradar's client-factory boundary, they don't
merge into one.

## 3. Design decisions

### 3.1 `LlmCredential` is now a discriminated union across TWO real kinds, not a flat `{kind, value}`

The `llm-credential-modes` epic's shape (`{kind: "api-key" | "oauth-
token"; value: string}`) assumed both kinds carry a secret string. Harness
mode carries **no secret material at all** — gigradar never resolves,
stores, or even sees a token for it; the local `claude` binary's own
already-authenticated session is used directly. Proposed shape:

```ts
type LlmCredential =
  | { kind: "api-key"; provider: "anthropic" | "openai" | "google"; value: string }
  | { kind: "claude-code-harness" };
```

`resolveLlmCredential()` returns `{kind: "claude-code-harness"}` when
`Config.llmCredentialKind === "claude-code-harness"` — no env-var read at
all for that branch, which is a real simplification over the current
(broken) design.

### 3.2 API-key mode routes through the Vercel AI SDK; harness mode routes through `@anthropic-ai/claude-agent-sdk`

These are two genuinely different client mechanisms, not one factory with
a branch inside it the way `createAnthropicClient()` currently is. Every
call site's actual invocation code needs a real per-kind branch:

- `kind: "api-key"` → `generateText()`/`streamText()` via the AI SDK, model
  instance chosen by `credential.provider` (`anthropic(...)`/
  `openai(...)`/`google(...)`).
- `kind: "claude-code-harness"` → `query()` from `@anthropic-ai/claude-
  agent-sdk`, `pathToClaudeCodeExecutable` resolved once (likely via the
  same `claude --help`-confirmed local install path), custom tools
  registered in-process via `createSdkMcpServer()`.

This means **every one of Slice 1/2's 9 call sites gets touched again** —
not a regression, a real consequence of the mechanism actually changing
underneath both credential kinds (api-key moves off raw
`@anthropic-ai/sdk` too, to gain the multi-provider win and the
`toolApproval` upgrade).

### 3.3 Provider selection needs a real `Config` field

`Config.llmCredentialKind` currently only distinguishes *how* to
authenticate. A new `Config.llmProvider?: "anthropic" | "openai" |
"google"` (default `"anthropic"`, byte-identical for existing installs)
is needed to pick *which* provider's API-key mode uses — each with its own
env-var slot (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, alongside the existing
`ANTHROPIC_API_KEY`), resolved through the same `resolveLlmCredential()`-
style mechanism generalized to read the right slot for the chosen
provider. Harness mode (`claude-code-harness`) is Anthropic-only for now
(§3.5) — `llmProvider` is not meaningful in that branch.

### 3.4 Heimdall/Portunus composition boundary (hard constraint, not a preference)

gigradar core (`src/lib/*`, `src/app/*`) **never** imports, calls, or
knows about Heimdall or Portunus — this is CLAUDE.md's core/user-layer
contract, and independently the exact anti-pattern the owner just banned
Heimdall itself from doing ("no plugin should be directly implementing
another plugin"). If the owner wants Heimdall-advised provider selection:
that composition lives entirely **outside this repo** — e.g. an
owner-authored script/cron that queries Heimdall's `/available-route`,
resolves the returned `credential_ref` via `portunus resolve`/`inject`,
and writes the result into gigradar's own public, documented surfaces
(`config.json`'s `llmProvider`/`llmCredentialKind` fields via
`saveConfig()`, and the resolved secret via `setEnvVar()` — both already
public, already the mechanism BYOK uses). gigradar's job is to keep those
surfaces stable and config-driven; it is not gigradar's job to speak
Heimdall's or Portunus's protocol.

### 3.5 Harness mode ships Claude-only this round; the interface stays provider-shaped

T3 Code's own driver-per-provider split (§2.2) proves a shared
*interface* ("harness-drive this provider's local CLI") is realistic, but
each provider's actual subprocess/SDK plumbing is genuinely different
(Codex's own app-server protocol, unverified for Gemini CLI). Building
Codex/Gemini harness drivers now would be scope creep with unverified
groundwork. This epic ships ONE concrete harness driver
(`claude-code-harness`, via `@anthropic-ai/claude-agent-sdk`), shaped so a
second driver can slot in later (a `HarnessDriver` interface with one
implementation, not a single hardcoded Claude-only function) — matching
the owner's "design the abstraction now, implement Anthropic only"
instruction.

## 4. Real open questions (not resolved by research — flagged honestly, not guessed)

1. **RESOLVED (Slice C spike, live-verified).** `query()` exposes a real
   structured-output-forcing mechanism: `options.outputFormat: {type:
   "json_schema", schema}`, read off the final `result`-type message's
   `structured_output` field — no single-allowed-tool trick needed. One
   real gotcha found and fixed: `zod` v4's `z.toJSONSchema()` always
   includes a top-level `"$schema"` meta key, which the `claude` CLI's own
   `--json-schema` validator rejects outright; `generateHarnessObject()`
   (`src/lib/config/llm-client.ts`) strips it before passing the schema
   through. The same mechanism accepts either a plain string prompt or a
   one-shot async-generator `SDKUserMessage` carrying real Anthropic-shaped
   content blocks (including a `{type:"document", source:{...}}` block for
   native PDF input) — live-verified both shapes, so Slice C's single
   `generateHarnessObject()` function covers every single-shot call site,
   PDF-attachment ones included.
2. **Still open — deferred to Slice D.** Does harness mode support a
   genuine pause-for-human-approval gate the way the AI SDK's
   `toolApproval` does, or only `canUseTool`'s allow/deny-at-call-time
   model (T3 Code's usage, §2.2)? Not touched by Slice C, which is
   single-shot/forced-structured-output only — no tool-use loop involved.
3. **Partially resolved.** Live-verified on this dev machine that omitting
   `pathToClaudeCodeExecutable` entirely still resolves and authenticates
   correctly — the SDK's own built-in resolution finds and uses the local
   `claude` CLI, simpler and more portable than hardcoding a path. NOT yet
   verified inside an actual packaged Tauri/Electron `.app` bundle — if the
   SDK's default resolution logic ever doesn't hold there (e.g. `claude`
   not on the bundled app's PATH), that's a real, still-open gap. Revisit
   if it's hit in practice.
4. **Partially addressed.** `generateHarnessObject()` wraps every failure
   mode — the query throwing (CLI not installed/not authenticated), no
   result message received, an error result, or a missing
   `structured_output` field — in a specific `HarnessQueryError` with an
   actionable message ("is the claude CLI installed and authenticated?"),
   never a raw, unexplained exception. NOT yet live-tested against a real
   "claude CLI genuinely not installed" machine state (only unit-tested via
   a mocked `query()` throw) — the actual CLI-uninstalled UX is still
   unverified in practice.

## 5. Scale assessment

Large — genuinely bigger than `llm-credential-modes`. Every real LLM call
site's actual invocation code changes (not just its credential parameter
type), a new provider-selection config field is added, and one new
subprocess-driving mechanism is introduced. Proposed slice shape for the
eventual vertical-plan.md (not written yet, per the owner's "design doc
first" instruction):

- **Slice A — `api-key` mode → Vercel AI SDK**, multi-provider
  (Anthropic/OpenAI/Google), single-shot call sites first
  (`draft.ts`/`prep.ts`/`extract.ts`/`capture-guidance.ts`), matching this
  session's own established incremental-call-site precedent.
- **Slice B — `api-key` mode → Vercel AI SDK**, the two multi-turn
  tool-loop call sites (`agent-chat-loop.ts`/`profile-assist-loop.ts`),
  adopting `toolApproval` as a real behavioral upgrade over the current
  hand-rolled approve/reject plumbing.
- **Slice C — `claude-code-harness` mode**, single-shot call sites only,
  once open question 1 (§4) is resolved by a real test.
- **Slice D (maybe deferred to its own epic)** — harness mode for the
  multi-turn tool-loop call sites, once open questions 2–4 are resolved.
- **Explicitly out of scope**: Heimdall integration (owner-side, outside
  this repo, §3.4); Codex/Gemini-CLI harness drivers (§3.5); the
  `Source.fetch()` public-plugin-interface call sites
  (`custom-llm-source.ts`/`gmail-digest-source.ts`/`custom-source-
  recipe.ts`), which stay on their own deliberately-deferred path per the
  original epic's boundary decision — unaffected either way.
