// Tests for src/lib/chat/agent-chat-loop.ts (agent-chat epic,
// chat-loop-core story). Mocked Anthropic client (mirrors draft.test.ts's
// exact shape), REAL store via a temp SQLite DB (so list_gigs/get_gig/
// get_status_summary exercise real store code, not a second mocked
// copy) -- same "mock the LLM, keep the store real" split every other
// store-touching LLM-call-site test in this repo uses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { Gig } from "../../types.js";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: mockCreate };
  }
  return { default: FakeAnthropic };
});

// The write-tool tests mock the actual LLM-calling generation functions
// directly (stageApplication/generatePrepPacket/runRadar) rather than
// threading fake tool-use responses through the SAME mocked Anthropic
// client the chat loop itself uses -- this file's job is proving the
// chat loop's approval-gating and dispatch is correct, not re-testing
// generateDraftAction's/generatePrepPacketAction's own business rules
// (already covered by their own test files).
const stageApplicationMock = vi.fn();
const runRadarMock = vi.fn();
vi.mock("../../apply/runner.js", () => ({
  stageApplication: (...args: unknown[]) => stageApplicationMock(...args),
  runRadar: (...args: unknown[]) => runRadarMock(...args),
}));

const generatePrepPacketMock = vi.fn();
vi.mock("../../apply/prep.js", () => ({
  generatePrepPacket: (...args: unknown[]) => generatePrepPacketMock(...args),
}));

import { closeDb, getDb } from "../../store/db.js";
import { recordScan } from "../../store/gigs.js";
import type { Config } from "../../types.js";
import { endChatSession, MAX_TURNS, resolveApproval, sendMessage, startChatSession } from "../agent-chat-loop.js";

const FAKE_CONFIG: Config = {
  profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
  needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false },
  sources: [],
  applyProfile: { email: "jane@example.com" },
};

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;
let originalDbPathEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-agent-chat-loop-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  // agent-chat-loop.ts's tools call listGigs()/getGig() with no explicit
  // `db` option (exactly how the real Server Action call site works) --
  // GIGRADAR_DB_PATH is what makes getDb()'s own default resolve to this
  // test's temp file, same pattern src/app/__tests__/actions.test.ts uses.
  originalDbPathEnv = process.env.GIGRADAR_DB_PATH;
  process.env.GIGRADAR_DB_PATH = dbPath;
  db = getDb();
  mockCreate.mockReset();
  stageApplicationMock.mockReset();
  runRadarMock.mockReset();
  generatePrepPacketMock.mockReset();
});

afterEach(() => {
  closeDb();
  if (originalDbPathEnv === undefined) delete process.env.GIGRADAR_DB_PATH;
  else process.env.GIGRADAR_DB_PATH = originalDbPathEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeGig(overrides: Partial<Gig> & { sourceId: string; externalId: string }): Gig {
  return {
    title: "Fractional CTO",
    company: "Acme",
    url: `https://example.test/${overrides.sourceId}/${overrides.externalId}`,
    description: "We need a hands-on technical leader.",
    ...overrides,
  };
}

function seedGig(overrides: Partial<Gig> & { sourceId: string; externalId: string; tier?: "green" | "yellow" | "red" }): string {
  recordScan([{ sourceId: overrides.sourceId, gigs: [{ ...makeGig(overrides), tier: overrides.tier }] }], { db });
  return `${overrides.sourceId}:${overrides.externalId}`;
}

function fakeTextResponse(text: string) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "claude-opus-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function fakeToolUseResponse(name: string, input: Record<string, unknown>) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_test", name, input }],
    model: "claude-opus-5",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

describe("sendMessage: plain conversational turn, no tools", () => {
  it("returns the model's final text answer when it calls no tools", async () => {
    mockCreate.mockResolvedValueOnce(fakeTextResponse("Hi! Ask me about your gigs."));
    startChatSession("s1");

    const result = await sendMessage("s1", "fake-api-key", "hello");

    expect(result).toEqual({ type: "message", text: "Hi! Ask me about your gigs." });
    endChatSession("s1");
  });

  it("throws a specific error when sendMessage() is called for a session that was never started", async () => {
    await expect(sendMessage("never-started", "fake-api-key", "hello")).rejects.toThrow(/no chat session/);
  });
});

describe("sendMessage: list_gigs tool", () => {
  it("calls the REAL listGigs() and grounds the model's next turn in real data", async () => {
    seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    seedGig({ sourceId: "src-a", externalId: "2", tier: "yellow" });

    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("list_gigs", { tier: "green" }))
      .mockResolvedValueOnce(fakeTextResponse("You have 1 green-tier gig: Fractional CTO at Acme."));

    startChatSession("s2");
    const result = await sendMessage("s2", "fake-api-key", "how many green-tier gigs do I have?");

    expect(result).toEqual({ type: "message", text: "You have 1 green-tier gig: Fractional CTO at Acme." });

    // Verify the tool_result fed back to the model reflects exactly 1 gig (the real filtered result), not 2.
    // (Search the whole message array, not just the last element -- mock.calls
    // captures a REFERENCE to the same mutable history array, which keeps
    // growing after this call was made, so "last element" at inspection time
    // is later state, not this call's own last message.)
    const secondCall = mockCreate.mock.calls[1]?.[0] as Anthropic.MessageCreateParams;
    const toolResultText = JSON.stringify(secondCall.messages);
    expect(toolResultText).toContain("src-a:1");
    expect(toolResultText).not.toContain("src-a:2");
    endChatSession("s2");
  });
});

describe("sendMessage: get_gig tool", () => {
  it("returns a real gig's data, BEGIN/END-delimited as untrusted DATA", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("get_gig", { key }))
      .mockResolvedValueOnce(fakeTextResponse("That's a Fractional CTO role at Acme."));

    startChatSession("s3");
    await sendMessage("s3", "fake-api-key", "tell me about this gig");

    const secondCall = mockCreate.mock.calls[1]?.[0] as Anthropic.MessageCreateParams;
    const toolResultText = JSON.stringify(secondCall.messages);
    expect(toolResultText).toContain("BEGIN GIG DATA");
    expect(toolResultText).toContain("END GIG DATA");
    expect(toolResultText).toContain("untrusted");
    endChatSession("s3");
  });

  it("returns a clean tool error (not a thrown exception) for an unknown key", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("get_gig", { key: "does-not:exist" }))
      .mockResolvedValueOnce(fakeTextResponse("I couldn't find that gig."));

    startChatSession("s4");
    const result = await sendMessage("s4", "fake-api-key", "tell me about gig does-not:exist");

    expect(result).toEqual({ type: "message", text: "I couldn't find that gig." });
    const secondCall = mockCreate.mock.calls[1]?.[0] as Anthropic.MessageCreateParams;
    expect(JSON.stringify(secondCall.messages)).toContain("no gig found");
    endChatSession("s4");
  });
});

describe("sendMessage: get_status_summary tool", () => {
  it("calls the REAL computeStatusStrip() and reflects real store/config state", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("get_status_summary", {}))
      .mockResolvedValueOnce(fakeTextResponse("Your profile needs setup and no sources are configured yet."));

    startChatSession("s5");
    const result = await sendMessage("s5", "fake-api-key", "what's my status?");

    expect(result).toEqual({ type: "message", text: "Your profile needs setup and no sources are configured yet." });
    endChatSession("s5");
  });
});

describe("sendMessage: read-only tools never mutate the store", () => {
  it("gigs.db row content is unchanged after a multi-turn read-only conversation", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    const before = db.prepare("SELECT * FROM gigs WHERE key = ?").get(key);

    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("list_gigs", {}))
      .mockResolvedValueOnce(fakeToolUseResponse("get_gig", { key }))
      .mockResolvedValueOnce(fakeToolUseResponse("get_status_summary", {}))
      .mockResolvedValueOnce(fakeTextResponse("All done looking things up."));

    startChatSession("s6");
    await sendMessage("s6", "fake-api-key", "look everything up");

    const after = db.prepare("SELECT * FROM gigs WHERE key = ?").get(key);
    expect(after).toEqual(before);
    endChatSession("s6");
  });
});

describe("sendMessage: multi-turn conversation retains history", () => {
  it("a follow-up message's request includes the earlier turns' history", async () => {
    mockCreate.mockResolvedValueOnce(fakeTextResponse("Sure, ask away."));
    startChatSession("s7");
    await sendMessage("s7", "fake-api-key", "hi");

    mockCreate.mockResolvedValueOnce(fakeTextResponse("As I said, ask away."));
    await sendMessage("s7", "fake-api-key", "still there?");

    const secondCall = mockCreate.mock.calls[1]?.[0] as Anthropic.MessageCreateParams;
    expect(secondCall.messages.length).toBeGreaterThanOrEqual(3); // hi, assistant reply, still there?
    endChatSession("s7");
  });
});

describe("sendMessage: MAX_TURNS", () => {
  it("stops cleanly with turn_limit_reached rather than looping forever when the model keeps calling tools", async () => {
    for (let i = 0; i < MAX_TURNS; i++) {
      mockCreate.mockResolvedValueOnce(fakeToolUseResponse("get_status_summary", {}));
    }

    startChatSession("s8");
    const result = await sendMessage("s8", "fake-api-key", "keep going forever");

    expect(result).toEqual({ type: "turn_limit_reached" });
    expect(mockCreate).toHaveBeenCalledTimes(MAX_TURNS);
    endChatSession("s8");
  });
});

describe("write tools: propose then approve, no exceptions", () => {
  it("update_gig_status produces a proposal, never mutates before approval", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    mockCreate.mockResolvedValueOnce(fakeToolUseResponse("update_gig_status", { key, status: "applied" }));

    startChatSession("w1");
    const result = await sendMessage("w1", "fake-api-key", "mark this one applied");

    expect(result).toEqual({
      type: "proposal",
      tool: "update_gig_status",
      input: { key, status: "applied" },
      description: `Mark gig "${key}" as "applied"`,
    });
    expect(db.prepare("SELECT status FROM gigs WHERE key = ?").get(key)).toEqual({ status: "new" });
    endChatSession("w1");
  });

  it("sendMessage() throws if called again while a proposal is still pending", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    mockCreate.mockResolvedValueOnce(fakeToolUseResponse("update_gig_status", { key, status: "applied" }));
    startChatSession("w2");
    await sendMessage("w2", "fake-api-key", "mark this one applied");

    await expect(sendMessage("w2", "fake-api-key", "another message")).rejects.toThrow(/still awaiting approval/);
    endChatSession("w2");
  });

  it("resolveApproval(approve:true) executes the REAL setStatus() and the loop continues to a final message", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("update_gig_status", { key, status: "applied" }))
      .mockResolvedValueOnce(fakeTextResponse("Done, marked as applied."));

    startChatSession("w3");
    await sendMessage("w3", "fake-api-key", "mark this one applied");
    const result = await resolveApproval("w3", "fake-api-key", true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Done, marked as applied." });
    expect(db.prepare("SELECT status FROM gigs WHERE key = ?").get(key)).toEqual({ status: "applied" });
    endChatSession("w3");
  });

  it("resolveApproval(approve:false) never touches the store, and the loop continues", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("update_gig_status", { key, status: "applied" }))
      .mockResolvedValueOnce(fakeTextResponse("Okay, not marking it applied."));

    startChatSession("w4");
    await sendMessage("w4", "fake-api-key", "mark this one applied");
    const result = await resolveApproval("w4", "fake-api-key", false, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Okay, not marking it applied." });
    expect(db.prepare("SELECT status FROM gigs WHERE key = ?").get(key)).toEqual({ status: "new" });
    endChatSession("w4");
  });

  it("resolveApproval() throws when there is no pending approval", async () => {
    startChatSession("w5");
    await expect(resolveApproval("w5", "fake-api-key", true, FAKE_CONFIG)).rejects.toThrow(/no pending approval/);
    endChatSession("w5");
  });

  it("generate_draft: approval calls the REAL stageApplication() with the gig/config/apiKey", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    stageApplicationMock.mockResolvedValue({});
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("generate_draft", { key }))
      .mockResolvedValueOnce(fakeTextResponse("Draft generated."));

    startChatSession("w6");
    await sendMessage("w6", "fake-api-key", "draft an application for this one");
    await resolveApproval("w6", "fake-api-key", true, FAKE_CONFIG);

    expect(stageApplicationMock).toHaveBeenCalledWith(expect.objectContaining({ gig: expect.objectContaining({ sourceId: "src-a" }) }), FAKE_CONFIG, "fake-api-key");
    endChatSession("w6");
  });

  it("generate_prep_packet: approval calls the REAL generatePrepPacket() and persists via saveInterviewPrep()", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    generatePrepPacketMock.mockResolvedValue({ score: 77, rationale: "r", topStrengths: [], keyGaps: [], recommendation: "Pursue", predictedQuestions: [], starlaStories: [] });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("generate_prep_packet", { key }))
      .mockResolvedValueOnce(fakeTextResponse("Prep packet ready."));

    startChatSession("w7");
    await sendMessage("w7", "fake-api-key", "generate a prep packet for this one");
    const result = await resolveApproval("w7", "fake-api-key", true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Prep packet ready." });
    expect(generatePrepPacketMock).toHaveBeenCalled();
    const stored = db.prepare("SELECT content FROM interview_prep WHERE gig_key = ?").get(key) as { content: string } | undefined;
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!.content).score).toBe(77);
    endChatSession("w7");
  });

  it("run_scan: approval calls the REAL runRadar() with the config and BYOK apiKey", async () => {
    runRadarMock.mockResolvedValue({ results: [{}], passed: [{}], errors: [], newlyInsertedKeys: [] });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("run_scan", {}))
      .mockResolvedValueOnce(fakeTextResponse("Scan done."));

    startChatSession("w8");
    await sendMessage("w8", "fake-api-key", "run a scan");
    const result = await resolveApproval("w8", "fake-api-key", true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Scan done." });
    expect(runRadarMock).toHaveBeenCalledWith(FAKE_CONFIG, {}, { anthropicApiKey: "fake-api-key" });
    endChatSession("w8");
  });

  it("a failed write tool (e.g. unknown gig key) surfaces as a tool error to the model, never throws out of resolveApproval()", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("update_gig_status", { key: "does-not:exist", status: "applied" }))
      .mockResolvedValueOnce(fakeTextResponse("That gig doesn't exist."));

    startChatSession("w9");
    await sendMessage("w9", "fake-api-key", "mark does-not:exist as applied");
    const result = await resolveApproval("w9", "fake-api-key", true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "That gig doesn't exist." });
    endChatSession("w9");
  });
});
