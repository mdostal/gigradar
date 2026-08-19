// llm-provider-harness epic. The shared factories every LLM call site uses
// to construct a real model client, instead of each hand-rolling its own.
// Lives alongside env-store.ts (LlmCredential's own home) rather than
// under apply/ or sources/ — this is consumed across apply/, sources/,
// chat/, auth/, and profile-ingestion/, so config/ is the neutral home,
// not any one of its callers.
//
// TWO real mechanisms, not one factory with a branch inside it (see
// design-discussion.md §3.2 for why):
//
//   - createAiSdkModel(credential) — `kind: "api-key"` only. Routes to the
//     Vercel AI SDK's per-provider factory (@ai-sdk/anthropic/openai/
//     google) based on `credential.provider`, for use with `generateText()`
//     at every SINGLE-SHOT call site (see design-discussion.md §2.5's
//     live-verified fit-check: forced structured output via
//     `output: Output.object(...)`, never the deprecated `generateObject()`;
//     native PDF input via `FilePart`).
//   - createAnthropicClient(credential) — the ORIGINAL raw-@anthropic-ai/sdk
//     factory, kept ONLY for the two multi-turn tool-loop call sites
//     (agent-chat-loop.ts/profile-assist-loop.ts) not yet migrated to the AI
//     SDK (that's Slice B, `ai-sdk-tool-loops`) — still Anthropic-`api-key`
//     -only, so it throws a clear error for any other credential shape
//     rather than silently misusing e.g. an OpenAI key as an Anthropic one.
//
// Neither function handles `kind: "claude-code-harness"` yet — that's
// Slice C (`claude-code-harness-single-shot`), which drives the real local
// `claude` CLI via @anthropic-ai/claude-agent-sdk's `query()`, never a raw
// client construction at all. Both functions throw a clear, actionable
// error for that kind today rather than silently misbehaving.
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogle } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { LlmCredential } from "./env-store.js";

/**
 * Model IDs are deliberately NOT user-configurable (yet) — every call site
 * already picks a fixed, tested model per provider. Anthropic's stays
 * "claude-opus-5" (unchanged from every pre-existing call site, live-used
 * throughout this codebase). The OpenAI/Google IDs are NOT live-verified —
 * no OpenAI/Google credential was available to test against during this
 * story; update these to whatever's actually current before relying on
 * either provider for real.
 */
const PROVIDER_MODEL_IDS = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.1",
  google: "gemini-3-pro",
} as const;

/**
 * Constructs a Vercel AI SDK `LanguageModel` from a resolved `api-key`
 * credential, routing to the right provider factory + model ID. Never logs
 * `credential.value`. Throws a clear, specific error for a
 * `claude-code-harness` credential — that kind is driven through a
 * completely different mechanism (Slice C), never this function.
 */
export function createAiSdkModel(credential: LlmCredential): LanguageModel {
  if (credential.kind === "claude-code-harness") {
    throw new Error(
      "gigradar: createAiSdkModel() was called with a claude-code-harness credential — that kind drives the local claude CLI directly and has no AI SDK model. This call site hasn't been migrated to harness mode yet.",
    );
  }

  switch (credential.provider) {
    case "anthropic":
      return createAnthropic({ apiKey: credential.value })(PROVIDER_MODEL_IDS.anthropic);
    case "openai":
      return createOpenAI({ apiKey: credential.value })(PROVIDER_MODEL_IDS.openai);
    case "google":
      return createGoogle({ apiKey: credential.value })(PROVIDER_MODEL_IDS.google);
  }
}

/**
 * Constructs a real Anthropic client (raw @anthropic-ai/sdk) from a
 * resolved `api-key`/`anthropic` credential — the two remaining tool-loop
 * call sites' mechanism until Slice B migrates them to the AI SDK. Throws
 * a clear error for any other credential shape (a non-Anthropic provider,
 * or claude-code-harness) rather than silently misusing the wrong key or
 * constructing a client with no credential at all.
 */
export function createAnthropicClient(credential: LlmCredential): Anthropic {
  if (credential.kind === "claude-code-harness") {
    throw new Error(
      "gigradar: createAnthropicClient() was called with a claude-code-harness credential — this call site hasn't been migrated to harness mode yet.",
    );
  }
  if (credential.provider !== "anthropic") {
    throw new Error(
      `gigradar: createAnthropicClient() only supports the Anthropic provider, got "${credential.provider}" — this call site hasn't been migrated to multi-provider support yet.`,
    );
  }
  return new Anthropic({ apiKey: credential.value });
}
