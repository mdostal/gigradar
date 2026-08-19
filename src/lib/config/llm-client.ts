// llm-provider-harness epic. The shared factories every LLM call site uses
// to construct a real model client, instead of each hand-rolling its own.
// Lives alongside env-store.ts (LlmCredential's own home) rather than
// under apply/ or sources/ — this is consumed across apply/, sources/,
// chat/, auth/, and profile-ingestion/, so config/ is the neutral home,
// not any one of its callers.
//
// THREE real mechanisms, not one factory with a branch inside it (see
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
//   - generateHarnessObject(schema, content) — `kind: "claude-code-harness"`
//     only. Drives the REAL LOCAL, already-authenticated `claude` CLI via
//     @anthropic-ai/claude-agent-sdk's `query()` — never extracts or reuses
//     a token (that was the original, now-abandoned `oauth-token` design;
//     live-tested and found rejected by api.anthropic.com when a
//     `claude setup-token` value is reused as a bare Bearer credential
//     outside the real `claude` process). Zero credential VALUE is ever
//     read or passed here — the local CLI's own session is used directly.
//     Both live-verified this session (see design-discussion.md §4,
//     resolved open question 1): `query()`'s `outputFormat: {type:
//     "json_schema", schema}` forces real structured output (read off the
//     final `result`-type message's `structured_output` field) — no
//     single-allowed-tool trick needed — and the same mechanism accepts
//     either a plain string prompt OR a one-shot async-generator
//     `SDKUserMessage` carrying real Anthropic-shaped content blocks
//     (`{type:"document", source:{...}}` for native PDF input, the exact
//     same block shape `createAnthropicClient()`'s callers used to build
//     pre-migration) — so this ONE function covers every single-shot call
//     site, PDF-attachment ones included, not just the plain-text ones.
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogle } from "@ai-sdk/google";
import type { FilePart, LanguageModel, TextPart } from "ai";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { z } from "zod";
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

/**
 * Converts the Vercel AI SDK's `TextPart`/`FilePart` content-block shape
 * (what `extract.ts`/`prep.ts` already build for `generateText()`) to the
 * real Anthropic-shaped blocks `generateHarnessObject()` needs — the two
 * SDKs use different field names/nesting for a PDF block
 * (`{type:"file", data, mediaType}` vs `{type:"document",
 * source:{type:"base64", media_type, data: base64string}}`) even though
 * both ultimately reach the same underlying Messages API shape. Exported
 * so the two call sites with PDF-attachment support share ONE conversion,
 * not two duplicated ones.
 */
export function toHarnessContentBlocks(blocks: Array<TextPart | FilePart>): MessageParam["content"] {
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text" as const, text: b.text };
    if (typeof b.data === "string") {
      return {
        type: "document" as const,
        source: { type: "base64" as const, media_type: b.mediaType as "application/pdf", data: b.data },
      };
    }
    if (b.data instanceof Uint8Array) {
      return {
        type: "document" as const,
        source: { type: "base64" as const, media_type: b.mediaType as "application/pdf", data: Buffer.from(b.data).toString("base64") },
      };
    }
    if (b.data instanceof ArrayBuffer) {
      return {
        type: "document" as const,
        source: { type: "base64" as const, media_type: b.mediaType as "application/pdf", data: Buffer.from(new Uint8Array(b.data)).toString("base64") },
      };
    }
    // Every real call site (extract.ts/prep.ts) always builds FilePart.data
    // as a Buffer/base64-string, never a URL or provider-reference -- see
    // buildResumeContentBlock() in extract.ts, the sole constructor.
    throw new Error("gigradar: toHarnessContentBlocks() only supports string/Uint8Array/ArrayBuffer FilePart.data, not a URL or provider reference.");
  });
}

/**
 * A specific, actionable error for `generateHarnessObject()` — never a raw
 * exception from `query()`/the spawned subprocess bubbling up unexplained.
 * Distinguishes "the CLI itself couldn't run" (ENOENT-shaped failures —
 * `claude` isn't installed, or isn't on PATH in a packaged build) from a
 * genuine in-session failure (auth expired, no structured output produced),
 * per design-discussion.md §4 open question 4.
 */
class HarnessQueryError extends Error {}

/**
 * Runs one single-shot, forced-structured-output query against the LOCAL,
 * already-authenticated `claude` CLI — never a raw API credential, never a
 * token extracted from anywhere. `content` is either a plain string prompt
 * (the common case) or a real Anthropic-shaped content-block array (e.g.
 * including a `{type:"document", ...}` block for native PDF input) for the
 * two call sites that need it (extract.ts/prep.ts) — both live-verified
 * this session (design-discussion.md §4, resolved open question 1).
 *
 * `schema`'s JSON Schema form (via zod's native `z.toJSONSchema()` — no
 * extra dependency) is passed as `outputFormat: {type:"json_schema",
 * schema}`; the result is read off the final `result`-type message's
 * `structured_output` field, then re-validated through `schema` itself
 * (never trusted as already-correctly-shaped) before returning.
 *
 * No `pathToClaudeCodeExecutable` override — live-verified this session
 * that omitting it entirely still resolves and authenticates correctly
 * (the SDK's own built-in resolution), which is simpler and more portable
 * than hardcoding a path; packaged-build resolution (design-discussion.md
 * §4 open question 3) stays an open, real gap if the SDK's own default
 * resolution ever doesn't hold for a Tauri/Electron bundle — not yet
 * hit in practice, revisit if it is.
 */
export async function generateHarnessObject<T>(schema: z.ZodType<T>, content: string | MessageParam["content"]): Promise<T> {
  // z.toJSONSchema() always includes a top-level "$schema" meta key — the
  // claude CLI's own --json-schema validator rejects it outright ("not a
  // valid JSON Schema: no schema with key or ref ..."), live-verified this
  // session. Strip it; the schema is fully self-contained without it.
  const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;

  const prompt: string | AsyncIterable<SDKUserMessage> =
    typeof content === "string"
      ? content
      : (async function* (): AsyncGenerator<SDKUserMessage> {
          yield {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
          };
        })();

  // Typed loosely (not the SDK's full SDKResultMessage union) -- only the
  // fields this function actually reads, checked at runtime via `.type`.
  let result: { type: "result"; subtype: string; is_error: boolean; result: string; structured_output?: unknown } | undefined;

  try {
    for await (const message of query({ prompt, options: { outputFormat: { type: "json_schema", schema: jsonSchema } } })) {
      if (message.type === "result") {
        result = message as typeof result;
      }
    }
  } catch (e) {
    throw new HarnessQueryError(
      `gigradar: claude-code-harness query failed to run — is the claude CLI installed and authenticated? (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  if (!result) {
    throw new HarnessQueryError("gigradar: claude-code-harness query produced no result.");
  }
  if (result.is_error) {
    throw new HarnessQueryError(`gigradar: claude-code-harness query failed (${result.subtype}).`);
  }
  if (result.structured_output === undefined) {
    throw new HarnessQueryError(
      "gigradar: claude-code-harness query did not include the expected structured output.",
    );
  }

  return schema.parse(result.structured_output);
}
