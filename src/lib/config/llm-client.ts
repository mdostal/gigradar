// llm-credential-modes epic, credential-core story. The ONE shared factory
// every LLM call site should use to construct an Anthropic client, instead
// of each hand-rolling its own `new Anthropic({apiKey})`. Lives alongside
// env-store.ts (LlmCredential's own home) rather than under apply/ or
// sources/ — this is consumed across apply/, sources/, chat/, auth/, and
// profile-ingestion/, so config/ is the neutral home, not any one of its
// callers.
//
// Exists purely to route a resolved LlmCredential's two possible shapes to
// the two constructor params the Anthropic SDK already natively supports
// for them — no new dependency, no custom auth transport:
//
//   - "api-key"     -> `apiKey` (sent as the `x-api-key` header) — today's
//                      only behavior, unchanged.
//   - "oauth-token" -> `authToken` (sent as a Bearer token) — confirmed via
//                      node_modules/@anthropic-ai/sdk/client.d.ts: the SDK
//                      already supports this natively (it even defaults to
//                      process.env['ANTHROPIC_AUTH_TOKEN'] when neither is
//                      passed). This is exactly the shape of a long-lived
//                      OAuth token from this machine's own
//                      `claude setup-token` — see design-discussion.md §2.
//
// Deliberately does NOT adopt @anthropic-ai/claude-agent-sdk — that
// package is a full agentic-CLI wrapper (its own permission model, its own
// MCP-shaped custom-tool mechanism, its own message protocol), not a
// drop-in for the single `messages.create()` calls and hand-rolled
// multi-turn loops every one of gigradar's real LLM call sites already
// has working. See design-discussion.md §2 for the real research behind
// this call, not a guess.
import Anthropic from "@anthropic-ai/sdk";
import type { LlmCredential } from "./env-store.js";

/** Constructs a real Anthropic client from a resolved LlmCredential, routing to `apiKey` or `authToken` based on `credential.kind`. Never logs `credential.value`. */
export function createAnthropicClient(credential: LlmCredential): Anthropic {
  if (credential.kind === "oauth-token") {
    return new Anthropic({ authToken: credential.value });
  }
  return new Anthropic({ apiKey: credential.value });
}
