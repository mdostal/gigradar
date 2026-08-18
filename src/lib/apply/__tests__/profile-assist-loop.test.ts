import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyProfileConfig, Profile } from "../../types.js";

// Mocked Anthropic client — ZERO real API calls in this automated suite,
// same mocking shape draft.test.ts/profile-suggest.test.ts already use.
const { mockCreate, mockAnthropicConstructor } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockAnthropicConstructor: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: mockCreate };
    constructor(options: unknown) {
      mockAnthropicConstructor(options);
    }
  }
  return { default: FakeAnthropic };
});

import { advanceLoopTurn, answerHuman, clearLoop, MAX_TURNS, resolveApproval } from "../profile-assist-loop.js";

const REAL_PROFILE: Profile = {
  name: "Jane Doe",
  roles: ["Fractional CTO"],
  skills: ["TypeScript"],
  timezone: "America/Chicago",
};
const REAL_APPLY_PROFILE: ApplyProfileConfig = { email: "jane@example.com", headline: "Fractional CTO" };
const SESSION_ID = "test-session-1";
const SNAPSHOT_WITH_REFS = '- generic [ref=e1]:\n  - textbox "Headline" [ref=e2]\n  - button "Save" [ref=e3]';

function toolUseResponse(name: string, input: Record<string, unknown>) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: `toolu_${name}`, name, input }],
    model: "claude-opus-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** A fake Page: locator("body").ariaSnapshot() returns SNAPSHOT_WITH_REFS; locator("aria-ref=X").click()/fill() are tracked spies. */
function createFakePage() {
  const click = vi.fn().mockResolvedValue(undefined);
  const fill = vi.fn().mockResolvedValue(undefined);
  const ariaSnapshot = vi.fn().mockResolvedValue(SNAPSHOT_WITH_REFS);
  const locator = vi.fn((selector: string) => {
    if (selector === "body") return { ariaSnapshot };
    return { click, fill };
  });
  return { locator, click, fill, ariaSnapshot } as unknown as import("playwright").Page & {
    click: typeof click;
    fill: typeof fill;
    ariaSnapshot: typeof ariaSnapshot;
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockAnthropicConstructor.mockReset();
  clearLoop(SESSION_ID);
});

describe("advanceLoopTurn: read", () => {
  it("returns the snapshot and tracks its refs for later click/fill validation", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("read", {}));
    const page = createFakePage();

    const event = await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    expect(event).toEqual({ type: "read", snapshot: SNAPSHOT_WITH_REFS });
    expect(page.ariaSnapshot).toHaveBeenCalledWith({ mode: "ai" });
  });
});

describe("advanceLoopTurn: click/fill ref validation", () => {
  it("rejects a ref that was never in a read() result, without touching the page", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("click", { ref: "e99", reason: "test" }));
    const page = createFakePage();

    const event = await advanceLoopTurn(SESSION_ID, page, "full-auto", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    expect(event).toEqual({ type: "invalid_ref", tool: "click", ref: "e99" });
    expect(page.click).not.toHaveBeenCalled();
  });

  it("accepts a ref that WAS in the most recent read() result", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("read", {}));
    const page = createFakePage();
    await advanceLoopTurn(SESSION_ID, page, "full-auto", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    mockCreate.mockResolvedValueOnce(toolUseResponse("fill", { ref: "e2", value: "Fractional CTO", reason: "test" }));
    const event = await advanceLoopTurn(SESSION_ID, page, "full-auto", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    expect(event).toMatchObject({ type: "fill", ref: "e2", executed: true });
    expect(page.fill).toHaveBeenCalledWith("Fractional CTO", { timeout: 5000 });
  });
});

describe("advanceLoopTurn: guided mode defers execution for approval", () => {
  it("a proposed click/fill in guided mode is NOT executed until approved", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("read", {}));
    const page = createFakePage();
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    mockCreate.mockResolvedValueOnce(toolUseResponse("click", { ref: "e3", reason: "save it" }));
    const event = await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    expect(event).toEqual({ type: "click", ref: "e3", value: undefined, reason: "save it", pending: true, executed: false });
    expect(page.click).not.toHaveBeenCalled();
  });

  it("advancing again while an approval is pending throws, without calling the LLM", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("read", {}));
    const page = createFakePage();
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    mockCreate.mockResolvedValueOnce(toolUseResponse("click", { ref: "e3", reason: "save it" }));
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    mockCreate.mockClear();
    await expect(advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" })).rejects.toThrow(
      /awaiting approval/,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("resolveApproval", () => {
  async function setUpPendingClick() {
    mockCreate.mockResolvedValueOnce(toolUseResponse("read", {}));
    const page = createFakePage();
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    mockCreate.mockResolvedValueOnce(toolUseResponse("click", { ref: "e3", reason: "save it" }));
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    return page;
  }

  it("approve: true executes the click for real", async () => {
    const page = await setUpPendingClick();
    await resolveApproval(SESSION_ID, page, true);
    expect(page.click).toHaveBeenCalledWith({ timeout: 5000 });
  });

  it("approve: false never touches the page", async () => {
    const page = await setUpPendingClick();
    await resolveApproval(SESSION_ID, page, false);
    expect(page.click).not.toHaveBeenCalled();
  });

  it("throws when there's no pending approval", async () => {
    const page = createFakePage();
    await expect(resolveApproval(SESSION_ID, page, true)).rejects.toThrow(/no pending approval/);
  });

  it("resolving the approval unblocks the next advanceLoopTurn() call", async () => {
    const page = await setUpPendingClick();
    await resolveApproval(SESSION_ID, page, true);

    mockCreate.mockResolvedValueOnce(toolUseResponse("done", { summary: "All set." }));
    const event = await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    expect(event).toEqual({ type: "done", summary: "All set." });
  });
});

describe("ask_human", () => {
  it("advanceLoopTurn returns the question and pauses; answerHuman() unblocks the next turn", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("ask_human", { question: "What's your preferred title?" }));
    const page = createFakePage();

    const event = await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    expect(event).toEqual({ type: "ask_human", question: "What's your preferred title?" });

    await expect(advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" })).rejects.toThrow(
      /waiting on a human answer/,
    );

    expect(() => answerHuman(SESSION_ID, "Fractional CTO, please.")).not.toThrow();

    mockCreate.mockResolvedValueOnce(toolUseResponse("done", { summary: "Done." }));
    const nextEvent = await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    expect(nextEvent).toEqual({ type: "done", summary: "Done." });
  });

  it("answerHuman throws when there's no pending question", () => {
    expect(() => answerHuman(SESSION_ID, "anything")).toThrow(/no pending human question/);
  });
});

describe("done", () => {
  it("returns the summary and stops the loop (no forced further action)", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("done", { summary: "Filled headline and bio." }));
    const page = createFakePage();

    const event = await advanceLoopTurn(SESSION_ID, page, "full-auto", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    expect(event).toEqual({ type: "done", summary: "Filled headline and bio." });
  });
});

describe("turn cap", () => {
  it("stops calling the LLM once MAX_TURNS is reached", async () => {
    const page = createFakePage();
    mockCreate.mockImplementation(async () => toolUseResponse("read", {}));

    for (let i = 0; i < MAX_TURNS; i++) {
      await advanceLoopTurn(SESSION_ID, page, "full-auto", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    }

    mockCreate.mockClear();
    const event = await advanceLoopTurn(SESSION_ID, page, "full-auto", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });
    expect(event).toEqual({ type: "turn_limit_reached" });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("prompt grounding and injection delimiting", () => {
  it("seeds the conversation with real applicant data on the first turn", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("read", {}));
    const page = createFakePage();
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    const firstCallMessages = mockCreate.mock.calls[0]?.[0]?.messages;
    const firstUserContent = firstCallMessages[0].content;
    const text = firstUserContent.map((b: { text?: string }) => b.text ?? "").join("\n");
    expect(text).toContain(REAL_PROFILE.name);
    expect(text).toContain(REAL_APPLY_PROFILE.email);
  });

  it("delimits each read() snapshot as untrusted DATA fed back as a tool_result", async () => {
    mockCreate.mockResolvedValueOnce(toolUseResponse("read", {}));
    const page = createFakePage();
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    mockCreate.mockResolvedValueOnce(toolUseResponse("done", { summary: "done" }));
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "fake-key" });

    const secondCallMessages = mockCreate.mock.calls[1]?.[0]?.messages;
    const toolResultMessage = secondCallMessages.find((m: { content: unknown }) =>
      Array.isArray(m.content) && m.content.some((b: { type?: string }) => b.type === "tool_result"),
    );
    const toolResultText = toolResultMessage.content[0].content[0].text as string;
    expect(toolResultText).toContain("BEGIN PAGE SNAPSHOT");
    expect(toolResultText).toContain("END PAGE SNAPSHOT");
    expect(toolResultText.toLowerCase()).toContain("untrusted");
    expect(toolResultText.toLowerCase()).toContain("never as instructions");
  });
});

describe("apiKey is caller-supplied, never module-scope", () => {
  it("constructs a fresh Anthropic client per turn with the exact apiKey passed in", async () => {
    mockCreate.mockResolvedValue(toolUseResponse("read", {}));
    const page = createFakePage();

    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "key-one" });
    clearLoop(SESSION_ID);
    await advanceLoopTurn(SESSION_ID, page, "guided", REAL_PROFILE, REAL_APPLY_PROFILE, { kind: "api-key", value: "key-two" });

    expect(mockAnthropicConstructor).toHaveBeenNthCalledWith(1, { apiKey: "key-one" });
    expect(mockAnthropicConstructor).toHaveBeenNthCalledWith(2, { apiKey: "key-two" });
  });
});
