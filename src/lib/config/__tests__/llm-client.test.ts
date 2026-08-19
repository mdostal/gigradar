// Tests for src/lib/config/llm-client.ts's harness-mode pieces
// (generateHarnessObject/toHarnessContentBlocks) -- llm-provider-harness
// epic, Slice C. createAiSdkModel()/createAnthropicClient() are already
// exercised indirectly by every api-key-mode call site's own test suite
// (draft.test.ts, prep.test.ts, etc.) -- not re-tested here.
//
// Mocks @anthropic-ai/claude-agent-sdk's query() -- ZERO real subprocess
// spawns in this automated suite, same "never a real LLM call" discipline
// every other LLM-calling test in this repo follows.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mockQuery }));

import { generateHarnessObject, toHarnessContentBlocks } from "../llm-client.js";

afterEach(() => {
  mockQuery.mockReset();
});

/** Builds a fake query() result: an async generator yielding a single result-type message. */
function fakeQueryResult(overrides: Partial<{ is_error: boolean; subtype: string; structured_output: unknown }> = {}) {
  return (async function* () {
    yield {
      type: "result",
      subtype: overrides.subtype ?? "success",
      is_error: overrides.is_error ?? false,
      result: "ok",
      structured_output: "structured_output" in overrides ? overrides.structured_output : { ok: true },
    };
  })();
}

const SCHEMA = z.object({ ok: z.boolean() });

describe("generateHarnessObject: structured output", () => {
  it("returns the schema-validated structured_output from the final result message", async () => {
    mockQuery.mockReturnValueOnce(fakeQueryResult({ structured_output: { ok: true } }));

    const result = await generateHarnessObject(SCHEMA, "a prompt");

    expect(result).toEqual({ ok: true });
  });

  it("ignores non-result messages, using only the LAST result-type message", async () => {
    mockQuery.mockReturnValueOnce(
      (async function* () {
        yield { type: "assistant", message: {} };
        yield { type: "system" };
        yield { type: "result", subtype: "success", is_error: false, result: "ok", structured_output: { ok: true } };
      })(),
    );

    const result = await generateHarnessObject(SCHEMA, "a prompt");

    expect(result).toEqual({ ok: true });
  });

  it("throws a clear error when query() itself throws (e.g. claude CLI not installed)", async () => {
    mockQuery.mockImplementationOnce(() => {
      throw new Error("spawn claude ENOENT");
    });

    await expect(generateHarnessObject(SCHEMA, "a prompt")).rejects.toThrow(/is the claude CLI installed and authenticated/);
  });

  it("throws a clear error when the async generator itself rejects mid-stream", async () => {
    mockQuery.mockReturnValueOnce(
      (async function* () {
        throw new Error("subprocess crashed");
      })(),
    );

    await expect(generateHarnessObject(SCHEMA, "a prompt")).rejects.toThrow(/is the claude CLI installed and authenticated/);
  });

  it("throws a clear error when no result message is ever received", async () => {
    mockQuery.mockReturnValueOnce(
      (async function* () {
        yield { type: "system" };
      })(),
    );

    await expect(generateHarnessObject(SCHEMA, "a prompt")).rejects.toThrow(/produced no result/);
  });

  it("throws a clear error when the result is an error result", async () => {
    mockQuery.mockReturnValueOnce(fakeQueryResult({ is_error: true, subtype: "error_max_turns" }));

    await expect(generateHarnessObject(SCHEMA, "a prompt")).rejects.toThrow(/query failed \(error_max_turns\)/);
  });

  it("throws a clear error when structured_output is missing from a successful result", async () => {
    mockQuery.mockReturnValueOnce(fakeQueryResult({ structured_output: undefined }));

    await expect(generateHarnessObject(SCHEMA, "a prompt")).rejects.toThrow(/did not include the expected structured output/);
  });

  it("re-validates structured_output through the real schema -- a shape mismatch throws, never silently returns wrong data", async () => {
    mockQuery.mockReturnValueOnce(fakeQueryResult({ structured_output: { ok: "not-a-boolean" } }));

    await expect(generateHarnessObject(SCHEMA, "a prompt")).rejects.toThrow();
  });
});

describe("generateHarnessObject: outputFormat schema construction", () => {
  it("passes a JSON Schema with the top-level $schema key stripped (the claude CLI rejects it)", async () => {
    mockQuery.mockReturnValueOnce(fakeQueryResult());

    await generateHarnessObject(SCHEMA, "a prompt");

    const call = mockQuery.mock.calls[0]?.[0] as { options?: { outputFormat?: { schema?: Record<string, unknown> } } };
    expect(call.options?.outputFormat?.schema).toBeDefined();
    expect(call.options?.outputFormat?.schema).not.toHaveProperty("$schema");
  });

  it("sets outputFormat.type to \"json_schema\"", async () => {
    mockQuery.mockReturnValueOnce(fakeQueryResult());

    await generateHarnessObject(SCHEMA, "a prompt");

    const call = mockQuery.mock.calls[0]?.[0] as { options?: { outputFormat?: { type?: string } } };
    expect(call.options?.outputFormat?.type).toBe("json_schema");
  });
});

describe("generateHarnessObject: prompt shape -- string passthrough vs. content-block async generator", () => {
  it("passes a string prompt straight through as query()'s prompt", async () => {
    mockQuery.mockReturnValueOnce(fakeQueryResult());

    await generateHarnessObject(SCHEMA, "the exact prompt text");

    const call = mockQuery.mock.calls[0]?.[0] as { prompt?: unknown };
    expect(call.prompt).toBe("the exact prompt text");
  });

  it("wraps a content-block array in a one-shot async generator yielding a real SDKUserMessage", async () => {
    mockQuery.mockReturnValueOnce(fakeQueryResult());
    const content = [{ type: "text" as const, text: "hello" }];

    await generateHarnessObject(SCHEMA, content);

    const call = mockQuery.mock.calls[0]?.[0] as { prompt?: AsyncIterable<unknown> };
    expect(typeof call.prompt).not.toBe("string");
    const messages: unknown[] = [];
    for await (const m of call.prompt as AsyncIterable<unknown>) messages.push(m);
    expect(messages).toEqual([{ type: "user", message: { role: "user", content }, parent_tool_use_id: null }]);
  });
});

describe("toHarnessContentBlocks: AI-SDK content parts -> Anthropic-shaped content blocks", () => {
  it("passes a text part through unchanged (aside from re-literalling type)", () => {
    const blocks = toHarnessContentBlocks([{ type: "text", text: "hello world" }]);
    expect(blocks).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("converts a string-data file part to a base64 document block, unchanged", () => {
    const blocks = toHarnessContentBlocks([{ type: "file", data: "already-base64==", mediaType: "application/pdf" }]);
    expect(blocks).toEqual([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "already-base64==" } }]);
  });

  it("converts a Uint8Array-data file part to a base64-encoded document block", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 test");
    const blocks = toHarnessContentBlocks([{ type: "file", data: bytes, mediaType: "application/pdf" }]);
    expect(blocks).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(bytes).toString("base64") } },
    ]);
  });

  it("converts an ArrayBuffer-data file part to a base64-encoded document block", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 test").buffer;
    const blocks = toHarnessContentBlocks([{ type: "file", data: bytes, mediaType: "application/pdf" }]);
    expect(blocks).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(new Uint8Array(bytes)).toString("base64") } },
    ]);
  });

  it("throws a clear error for an unsupported file data shape (a URL)", () => {
    expect(() => toHarnessContentBlocks([{ type: "file", data: new URL("https://example.test/resume.pdf"), mediaType: "application/pdf" }])).toThrow(
      /only supports string\/Uint8Array\/ArrayBuffer/,
    );
  });

  it("preserves ordering across a mixed array of text and file blocks", () => {
    const blocks = toHarnessContentBlocks([
      { type: "text", text: "first" },
      { type: "file", data: "abc==", mediaType: "application/pdf" },
      { type: "text", text: "last" },
    ]) as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "document", "text"]);
  });
});
