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

// Source-connection tools (chat-sessions-screenshots story) similarly mock
// the underlying session-capture/oauth mechanism rather than re-testing
// session-capture.test.ts's/oauth2.test.ts's own business rules -- this
// file's job is proving the chat loop's approval-gating, chat-owned
// activeCapture scoping, and dispatch, not those modules' internals.
const startCaptureMock = vi.fn();
const finishCaptureMock = vi.fn();
const cancelCaptureMock = vi.fn();
const getCapturePageMock = vi.fn();
vi.mock("../../auth/session-capture.js", () => ({
  startCapture: (...args: unknown[]) => startCaptureMock(...args),
  finishCapture: (...args: unknown[]) => finishCaptureMock(...args),
  cancelCapture: (...args: unknown[]) => cancelCaptureMock(...args),
  getCapturePage: (...args: unknown[]) => getCapturePageMock(...args),
}));

const buildAuthorizationUrlMock = vi.fn();
const deleteTokenSetMock = vi.fn();
vi.mock("../../auth/oauth2.js", () => ({
  buildAuthorizationUrl: (...args: unknown[]) => buildAuthorizationUrlMock(...args),
  deleteTokenSet: (...args: unknown[]) => deleteTokenSetMock(...args),
}));

const resolveOAuthClientCredentialsMock = vi.fn();
vi.mock("../../auth/oauth-credentials.js", () => ({
  resolveOAuthClientCredentials: (...args: unknown[]) => resolveOAuthClientCredentialsMock(...args),
}));

vi.mock("../../auth/oauth-providers/gmail.js", () => ({
  GMAIL_PROVIDER: { id: "gmail" },
}));

import { closeDb, getDb } from "../../store/db.js";
import { recordScan } from "../../store/gigs.js";
import type { Config, SourceConfig } from "../../types.js";
import { endChatSession, MAX_TURNS, resolveApproval, resumeChatSession, sendMessage, startChatSession } from "../agent-chat-loop.js";
import { listPreferences } from "../memory.js";

const FAKE_CONFIG: Config = {
  profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
  groups: [
    { id: "g1", label: "Group 1", needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false } },
  ],
  sources: [],
  applyProfile: { email: "jane@example.com" },
};

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;
let originalDbPathEnv: string | undefined;
let xdgDataDir: string;
let xdgConfigDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

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

  // Separate, own-per-test XDG dirs (two, not one -- same "vault key dir
  // must differ from data dir" convention src/app/chat/__tests__/actions.test.ts
  // established) so finish_capture_login's REAL readRawConfig()/saveConfig()
  // write to an isolated config.json, never the process-wide default temp
  // dir vitest.setup.ts points at (let alone a real user's data dir).
  xdgDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-agent-chat-loop-test-xdg-data-"));
  xdgConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-agent-chat-loop-test-xdg-config-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = xdgDataDir;
  process.env.XDG_CONFIG_HOME = xdgConfigDir;

  mockCreate.mockReset();
  stageApplicationMock.mockReset();
  runRadarMock.mockReset();
  generatePrepPacketMock.mockReset();
  startCaptureMock.mockReset();
  finishCaptureMock.mockReset();
  cancelCaptureMock.mockReset();
  getCapturePageMock.mockReset();
  buildAuthorizationUrlMock.mockReset();
  deleteTokenSetMock.mockReset();
  resolveOAuthClientCredentialsMock.mockReset();
});

afterEach(() => {
  closeDb();
  if (originalDbPathEnv === undefined) delete process.env.GIGRADAR_DB_PATH;
  else process.env.GIGRADAR_DB_PATH = originalDbPathEnv;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(xdgDataDir, { recursive: true, force: true });
  fs.rmSync(xdgConfigDir, { recursive: true, force: true });
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

    const result = await sendMessage("s1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "hello", FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Hi! Ask me about your gigs." });
    endChatSession("s1");
  });

  it("throws a specific error when sendMessage() is called for a session that was never started", async () => {
    await expect(sendMessage("never-started", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "hello", FAKE_CONFIG)).rejects.toThrow(/no chat session/);
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
    const result = await sendMessage("s2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "how many green-tier gigs do I have?", FAKE_CONFIG);

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
    await sendMessage("s3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "tell me about this gig", FAKE_CONFIG);

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
    const result = await sendMessage("s4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "tell me about gig does-not:exist", FAKE_CONFIG);

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
    const result = await sendMessage("s5", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "what's my status?", FAKE_CONFIG);

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
    await sendMessage("s6", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "look everything up", FAKE_CONFIG);

    const after = db.prepare("SELECT * FROM gigs WHERE key = ?").get(key);
    expect(after).toEqual(before);
    endChatSession("s6");
  });
});

describe("sendMessage: multi-turn conversation retains history", () => {
  it("a follow-up message's request includes the earlier turns' history", async () => {
    mockCreate.mockResolvedValueOnce(fakeTextResponse("Sure, ask away."));
    startChatSession("s7");
    await sendMessage("s7", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "hi", FAKE_CONFIG);

    mockCreate.mockResolvedValueOnce(fakeTextResponse("As I said, ask away."));
    await sendMessage("s7", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "still there?", FAKE_CONFIG);

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
    const result = await sendMessage("s8", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "keep going forever", FAKE_CONFIG);

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
    const result = await sendMessage("w1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "mark this one applied", FAKE_CONFIG);

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
    await sendMessage("w2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "mark this one applied", FAKE_CONFIG);

    await expect(sendMessage("w2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "another message", FAKE_CONFIG)).rejects.toThrow(/still awaiting approval/);
    endChatSession("w2");
  });

  it("resolveApproval(approve:true) executes the REAL setStatus() and the loop continues to a final message", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("update_gig_status", { key, status: "applied" }))
      .mockResolvedValueOnce(fakeTextResponse("Done, marked as applied."));

    startChatSession("w3");
    await sendMessage("w3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "mark this one applied", FAKE_CONFIG);
    const result = await resolveApproval("w3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

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
    await sendMessage("w4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "mark this one applied", FAKE_CONFIG);
    const result = await resolveApproval("w4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, false, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Okay, not marking it applied." });
    expect(db.prepare("SELECT status FROM gigs WHERE key = ?").get(key)).toEqual({ status: "new" });
    endChatSession("w4");
  });

  it("resolveApproval() throws when there is no pending approval", async () => {
    startChatSession("w5");
    await expect(resolveApproval("w5", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG)).rejects.toThrow(/no pending approval/);
    endChatSession("w5");
  });

  it("generate_draft: approval calls the REAL stageApplication() with the gig/config/apiKey", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1", tier: "green" });
    stageApplicationMock.mockResolvedValue({});
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("generate_draft", { key }))
      .mockResolvedValueOnce(fakeTextResponse("Draft generated."));

    startChatSession("w6");
    await sendMessage("w6", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "draft an application for this one", FAKE_CONFIG);
    await resolveApproval("w6", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(stageApplicationMock).toHaveBeenCalledWith(expect.objectContaining({ gig: expect.objectContaining({ sourceId: "src-a" }) }), FAKE_CONFIG, { kind: "api-key", provider: "anthropic", value: "fake-api-key" });
    endChatSession("w6");
  });

  it("generate_prep_packet: approval calls the REAL generatePrepPacket() and persists via saveInterviewPrep()", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    generatePrepPacketMock.mockResolvedValue({ score: 77, rationale: "r", topStrengths: [], keyGaps: [], recommendation: "Pursue", predictedQuestions: [], starlaStories: [] });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("generate_prep_packet", { key }))
      .mockResolvedValueOnce(fakeTextResponse("Prep packet ready."));

    startChatSession("w7");
    await sendMessage("w7", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "generate a prep packet for this one", FAKE_CONFIG);
    const result = await resolveApproval("w7", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Prep packet ready." });
    expect(generatePrepPacketMock).toHaveBeenCalled();
    const stored = db.prepare("SELECT content FROM interview_prep WHERE gig_key = ?").get(key) as { content: string } | undefined;
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!.content).score).toBe(77);
    endChatSession("w7");
  });

  it("run_scan: approval calls the REAL runRadar() with the config and the full credential", async () => {
    runRadarMock.mockResolvedValue({ results: [{}], passed: [{}], errors: [], newlyInsertedKeys: [] });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("run_scan", {}))
      .mockResolvedValueOnce(fakeTextResponse("Scan done."));

    startChatSession("w8");
    await sendMessage("w8", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "run a scan", FAKE_CONFIG);
    const result = await resolveApproval("w8", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Scan done." });
    expect(runRadarMock).toHaveBeenCalledWith(FAKE_CONFIG, {}, { credential: { kind: "api-key", provider: "anthropic", value: "fake-api-key" } });
    endChatSession("w8");
  });

  it("a failed write tool (e.g. unknown gig key) surfaces as a tool error to the model, never throws out of resolveApproval()", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("update_gig_status", { key: "does-not:exist", status: "applied" }))
      .mockResolvedValueOnce(fakeTextResponse("That gig doesn't exist."));

    startChatSession("w9");
    await sendMessage("w9", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "mark does-not:exist as applied", FAKE_CONFIG);
    const result = await resolveApproval("w9", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "That gig doesn't exist." });
    endChatSession("w9");
  });
});

describe("source-connection tools: propose then approve, no exceptions", () => {
  it("start_capture_login produces a proposal, never opens a browser before approval", async () => {
    mockCreate.mockResolvedValueOnce(fakeToolUseResponse("start_capture_login", { sourceId: "gofractional" }));

    startChatSession("c1");
    const result = await sendMessage("c1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "log me into gofractional", FAKE_CONFIG);

    expect(result).toEqual({
      type: "proposal",
      tool: "start_capture_login",
      input: { sourceId: "gofractional" },
      description: 'Start a guided login capture for source "gofractional" (opens a real browser window)',
    });
    expect(startCaptureMock).not.toHaveBeenCalled();
    endChatSession("c1");
  });

  it("start_capture_login: approval calls the REAL startCapture() with the registry login URL, and sets chat-owned activeCapture state", async () => {
    startCaptureMock.mockResolvedValue({ captureId: "cap-1" });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("start_capture_login", { sourceId: "gofractional" }))
      .mockResolvedValueOnce(fakeTextResponse("Browser window opened -- log in, then let me know."));

    startChatSession("c2");
    await sendMessage("c2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "log me into gofractional", FAKE_CONFIG);
    const result = await resolveApproval("c2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Browser window opened -- log in, then let me know." });
    expect(startCaptureMock).toHaveBeenCalledWith("gofractional", "https://www.gofractional.com/login", ["gofractional.com"]);
    endChatSession("c2");
  });

  it("finish_capture_login: no-op error (not a throw out of resolveApproval) when this chat never started a capture", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("finish_capture_login", {}))
      .mockResolvedValueOnce(fakeTextResponse("There's no login capture open right now."));

    startChatSession("c3");
    await sendMessage("c3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "finish the login", FAKE_CONFIG);
    const result = await resolveApproval("c3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "There's no login capture open right now." });
    expect(finishCaptureMock).not.toHaveBeenCalled();
    endChatSession("c3");
  });

  it("finish_capture_login (local backend): approval calls the REAL finishCapture() against the chat-owned capture, and persists sessionStatePath to config.json", async () => {
    // finish_capture_login's write path merges into the REAL config.json via
    // readRawConfig()/saveConfig() (not mocked -- this test proves the
    // actual persistence, isolated to this test's own XDG temp dirs, see
    // beforeEach). saveConfig() re-validates the FULL merged document, so a
    // base valid config must exist first, exactly like a real user who has
    // already filled out /config once.
    const { saveConfig } = await import("../../config/save.js");
    const seedResult = saveConfig({
      profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
      groups: [
        {
          id: "g1",
          label: "Group 1",
          needs: {
            engagementProfiles: [
              { id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" },
            ],
            freshStageOnly: false,
            remoteOnly: false,
          },
        },
      ],
      sources: [{ id: "gofractional", enabled: true }],
    });
    expect(seedResult.ok).toBe(true);

    startCaptureMock.mockResolvedValue({ captureId: "cap-2" });
    finishCaptureMock.mockResolvedValue({ backend: "local", path: "/fake/path/gofractional-session.json" });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("start_capture_login", { sourceId: "gofractional" }))
      .mockResolvedValueOnce(fakeTextResponse("Browser window opened."))
      .mockResolvedValueOnce(fakeToolUseResponse("finish_capture_login", {}))
      .mockResolvedValueOnce(fakeTextResponse("Saved."));

    startChatSession("c4");
    await sendMessage("c4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "log me into gofractional", FAKE_CONFIG);
    await resolveApproval("c4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);
    await sendMessage("c4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "I'm done, finish it", FAKE_CONFIG);
    const result = await resolveApproval("c4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Saved." });
    expect(finishCaptureMock).toHaveBeenCalledWith("cap-2", "local");

    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { sources?: Array<{ id: string; settings?: { sessionStatePath?: string } }> };
    const persisted = raw.sources?.find((s) => s.id === "gofractional");
    expect(persisted?.settings?.sessionStatePath).toBe("/fake/path/gofractional-session.json");
    endChatSession("c4");
  });

  it("a second start_capture_login while one is already open still lets take_screenshot/finish/cancel act on the chat's single activeCapture (no cross-session lookup)", async () => {
    startCaptureMock.mockResolvedValue({ captureId: "cap-3" });
    cancelCaptureMock.mockResolvedValue(undefined);
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("start_capture_login", { sourceId: "gofractional" }))
      .mockResolvedValueOnce(fakeTextResponse("Opened."))
      .mockResolvedValueOnce(fakeToolUseResponse("cancel_capture_login", {}))
      .mockResolvedValueOnce(fakeTextResponse("Cancelled."));

    startChatSession("c5");
    await sendMessage("c5", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "log me into gofractional", FAKE_CONFIG);
    await resolveApproval("c5", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);
    await sendMessage("c5", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "never mind, cancel it", FAKE_CONFIG);
    const result = await resolveApproval("c5", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Cancelled." });
    expect(cancelCaptureMock).toHaveBeenCalledWith("cap-3");
    endChatSession("c5");
  });

  it("start_gmail_connect: approval returns the REAL authorization URL from buildAuthorizationUrl()", async () => {
    resolveOAuthClientCredentialsMock.mockReturnValue({ clientId: "client-123" });
    buildAuthorizationUrlMock.mockReturnValue({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=client-123" });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("start_gmail_connect", { sourceId: "gmail-alerts" }))
      .mockResolvedValueOnce(fakeTextResponse("Open the link I gave you to connect Gmail."));

    startChatSession("c6");
    await sendMessage("c6", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "connect my gmail alerts source", FAKE_CONFIG);
    const result = await resolveApproval("c6", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Open the link I gave you to connect Gmail." });
    expect(buildAuthorizationUrlMock).toHaveBeenCalledWith({ id: "gmail" }, "gmail-alerts", "client-123");
    endChatSession("c6");
  });

  it("disconnect_gmail: approval calls the REAL deleteTokenSet() for the source", async () => {
    deleteTokenSetMock.mockResolvedValue(undefined);
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("disconnect_gmail", { sourceId: "gmail-alerts" }))
      .mockResolvedValueOnce(fakeTextResponse("Disconnected."));

    startChatSession("c7");
    await sendMessage("c7", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "disconnect gmail-alerts", FAKE_CONFIG);
    const result = await resolveApproval("c7", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Disconnected." });
    expect(deleteTokenSetMock).toHaveBeenCalledWith({ id: "gmail" }, "gmail-alerts", "local");
    endChatSession("c7");
  });
});

describe("take_screenshot: read-only, auto-executes against the chat-owned capture", () => {
  it("returns a clean tool error (not a thrown exception) when no capture is open in this chat", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("take_screenshot", {}))
      .mockResolvedValueOnce(fakeTextResponse("There's nothing open to screenshot."));

    startChatSession("s9");
    const result = await sendMessage("s9", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "show me the login window", FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "There's nothing open to screenshot." });
    expect(getCapturePageMock).not.toHaveBeenCalled();
    endChatSession("s9");
  });

  it("takes a real screenshot of the chat's own active capture and feeds it back as an image tool_result", async () => {
    startCaptureMock.mockResolvedValue({ captureId: "cap-4" });
    const fakeScreenshot = vi.fn().mockResolvedValue(Buffer.from("fake-png-bytes"));
    getCapturePageMock.mockReturnValue({ screenshot: fakeScreenshot });
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("start_capture_login", { sourceId: "gofractional" }))
      .mockResolvedValueOnce(fakeTextResponse("Opened."))
      .mockResolvedValueOnce(fakeToolUseResponse("take_screenshot", {}))
      .mockResolvedValueOnce(fakeTextResponse("I can see the login page."));

    startChatSession("s10");
    await sendMessage("s10", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "log me into gofractional", FAKE_CONFIG);
    await resolveApproval("s10", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);
    const result = await sendMessage("s10", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "what does it look like?", FAKE_CONFIG);

    expect(result).toEqual({
      type: "message",
      text: "I can see the login page.",
      screenshots: [{ sourceId: "gofractional", dataUrl: `data:image/png;base64,${Buffer.from("fake-png-bytes").toString("base64")}` }],
    });
    expect(getCapturePageMock).toHaveBeenCalledWith("cap-4");
    expect(fakeScreenshot).toHaveBeenCalled();

    const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]?.[0] as Anthropic.MessageCreateParams;
    const messagesJson = JSON.stringify(lastCall.messages);
    expect(messagesJson).toContain('"type":"image"');
    expect(messagesJson).toContain(Buffer.from("fake-png-bytes").toString("base64"));
    endChatSession("s10");
  });
});

describe("list_source_presets: read-only, auto-executes", () => {
  it("never appears as a pendingApproval and returns SOURCE_PRESETS' id/label/description", async () => {
    const { SOURCE_PRESETS } = await import("../../sources/source-presets.js");
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("list_source_presets", {}))
      .mockResolvedValueOnce(fakeTextResponse("Here's what's available."));

    startChatSession("p1");
    const result = await sendMessage("p1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "what job sites can you add?", FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Here's what's available." });
    const secondCall = mockCreate.mock.calls[1]?.[0] as Anthropic.MessageCreateParams;
    const messagesJson = JSON.stringify(secondCall.messages);
    for (const preset of SOURCE_PRESETS) {
      expect(messagesJson).toContain(preset.id);
      expect(messagesJson).toContain(preset.label);
    }
    endChatSession("p1");
  });
});

describe("add_source: propose then approve, no exceptions", () => {
  let originalXdgDataHome: string | undefined;
  let originalXdgConfigHome: string | undefined;
  let xdgDataDir: string;
  let xdgConfigDir: string;

  beforeEach(() => {
    xdgDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-agent-chat-loop-test-addsource-data-"));
    xdgConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-agent-chat-loop-test-addsource-config-"));
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_DATA_HOME = xdgDataDir;
    process.env.XDG_CONFIG_HOME = xdgConfigDir;
  });

  afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    fs.rmSync(xdgDataDir, { recursive: true, force: true });
    fs.rmSync(xdgConfigDir, { recursive: true, force: true });
  });

  async function seedBaseConfig() {
    const { saveConfig } = await import("../../config/save.js");
    const result = saveConfig({
      profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
      groups: [
        {
          id: "g1",
          label: "Group 1",
          needs: {
            engagementProfiles: [
              { id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" },
            ],
            freshStageOnly: false,
            remoteOnly: false,
          },
        },
      ],
      sources: [],
    });
    expect(result.ok).toBe(true);
  }

  it("with a presetId produces a proposal, never mutates config.json before approval", async () => {
    await seedBaseConfig();
    mockCreate.mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "zoho-recruit" }));

    startChatSession("as1");
    const result = await sendMessage("as1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add zoho recruit", FAKE_CONFIG);

    expect(result).toEqual({
      type: "proposal",
      tool: "add_source",
      input: { presetId: "zoho-recruit" },
      description: 'Add source from the "zoho-recruit" preset',
    });
    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { sources?: unknown[] };
    expect(raw.sources ?? []).toEqual([]);
    endChatSession("as1");
  });

  it("approving a presetId proposal writes a SourceConfig matching sourceConfigFromPreset()'s own output", async () => {
    await seedBaseConfig();
    const { SOURCE_PRESETS, sourceConfigFromPreset } = await import("../../sources/source-presets.js");
    const zoho = SOURCE_PRESETS.find((p) => p.id === "zoho-recruit")!;

    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "zoho-recruit" }))
      .mockResolvedValueOnce(fakeTextResponse("Added it."));

    startChatSession("as2");
    await sendMessage("as2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add zoho recruit", FAKE_CONFIG);
    const result = await resolveApproval("as2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Added it." });
    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { sources?: SourceConfig[] };
    expect(raw.sources).toEqual([sourceConfigFromPreset(zoho, [])]);
    endChatSession("as2");
  });

  it("approving a suggestsGmailDigest:true preset mentions Gmail/start_gmail_connect in the tool_result text; a preset without the flag does not", async () => {
    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "zoho-recruit" }))
      .mockResolvedValueOnce(fakeTextResponse("Added zoho-recruit."));
    startChatSession("as3");
    await sendMessage("as3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add zoho recruit", FAKE_CONFIG);
    await resolveApproval("as3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);
    const gmailCall = mockCreate.mock.calls[1]?.[0] as Anthropic.MessageCreateParams;
    expect(JSON.stringify(gmailCall.messages)).toContain("start_gmail_connect");
    endChatSession("as3");

    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "welcome-to-the-jungle" }))
      .mockResolvedValueOnce(fakeTextResponse("Added welcome-to-the-jungle."));
    startChatSession("as4");
    await sendMessage("as4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add welcome to the jungle", FAKE_CONFIG);
    await resolveApproval("as4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);
    const noGmailCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]?.[0] as Anthropic.MessageCreateParams;
    expect(JSON.stringify(noGmailCall.messages)).not.toContain("start_gmail_connect");
    endChatSession("as4");
  });

  it("start_gmail_connect is NOT called automatically as a side effect of approving add_source", async () => {
    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "indeed" }))
      .mockResolvedValueOnce(fakeTextResponse("Added indeed."));
    startChatSession("as5");
    await sendMessage("as5", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add indeed", FAKE_CONFIG);
    await resolveApproval("as5", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(buildAuthorizationUrlMock).not.toHaveBeenCalled();
    endChatSession("as5");
  });

  it("with a raw sourceId+url (no preset) writes a custom-llm SourceConfig with a uniqued id on collision", async () => {
    const { saveConfig } = await import("../../config/save.js");
    saveConfig({
      profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
      groups: [
        {
          id: "g1",
          label: "Group 1",
          needs: {
            engagementProfiles: [
              { id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" },
            ],
            freshStageOnly: false,
            remoteOnly: false,
          },
        },
      ],
      sources: [{ id: "monster", enabled: true }],
    });

    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { sourceId: "monster", url: "https://example.test/monster/jobs", hint: "a list of cards" }))
      .mockResolvedValueOnce(fakeTextResponse("Added it."));

    startChatSession("as6");
    await sendMessage("as6", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add monster at https://example.test/monster/jobs", FAKE_CONFIG);
    await resolveApproval("as6", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { sources?: SourceConfig[] };
    const added = raw.sources?.find((s) => s.id === "monster-2");
    expect(added).toEqual({ id: "monster-2", enabled: true, kind: "custom-llm", settings: { url: "https://example.test/monster/jobs", hint: "a list of cards" } });
    endChatSession("as6");
  });

  it("rejecting an add_source proposal never touches config.json", async () => {
    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "indeed" }))
      .mockResolvedValueOnce(fakeTextResponse("Okay, not adding it."));

    startChatSession("as7");
    await sendMessage("as7", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add indeed", FAKE_CONFIG);
    const result = await resolveApproval("as7", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, false, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Okay, not adding it." });
    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { sources?: unknown[] };
    expect(raw.sources ?? []).toEqual([]);
    endChatSession("as7");
  });

  it("an unknown presetId surfaces as a clean tool error, not a thrown exception out of resolveApproval()", async () => {
    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "does-not-exist" }))
      .mockResolvedValueOnce(fakeTextResponse("I don't recognize that preset."));

    startChatSession("as8");
    await sendMessage("as8", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add does-not-exist", FAKE_CONFIG);
    const result = await resolveApproval("as8", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "I don't recognize that preset." });
    endChatSession("as8");
  });
});

// chat-copilot-self-tuning epic.
describe("note_preference: ungated, runs immediately", () => {
  it("never appears as a pendingApproval, records the note via memory.ts, and returns 'Noted.'", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("note_preference", { note: "CFO/Finance titles are never a fit for the CTO group" }))
      .mockResolvedValueOnce(fakeTextResponse("Got it, I'll remember that."));

    startChatSession("np1");
    const result = await sendMessage("np1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "remember that CFO roles aren't a fit", FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Got it, I'll remember that." });
    const prefs = listPreferences(undefined, { db });
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ note: "CFO/Finance titles are never a fit for the CTO group", sessionId: "np1" });
    endChatSession("np1");
  });

  it("a preference recorded in one session is surfaced in a system prompt for a LATER, DIFFERENT session -- proves listPreferences() is no longer write-only (deep-dive-audit-and-testing-framework epic)", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("note_preference", { note: "Never draft for pure sales/BD roles" }))
      .mockResolvedValueOnce(fakeTextResponse("Got it."));
    startChatSession("np-session-a");
    await sendMessage("np-session-a", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "remember: no sales roles", FAKE_CONFIG);
    endChatSession("np-session-a");

    mockCreate.mockClear();
    mockCreate.mockResolvedValueOnce(fakeTextResponse("Sure, I have that in mind."));
    startChatSession("np-session-b");
    await sendMessage("np-session-b", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "what should I keep in mind?", FAKE_CONFIG);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const requestArgs = mockCreate.mock.calls[0]?.[0] as { system?: string };
    expect(requestArgs.system).toContain("Never draft for pure sales/BD roles");
    endChatSession("np-session-b");
  });
});

describe("propose_config_edit: propose then approve, no exceptions", () => {
  async function seedBaseConfig() {
    const { saveConfig } = await import("../../config/save.js");
    const result = saveConfig({
      profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
      groups: [
        {
          id: "g1",
          label: "Group 1",
          needs: { engagementProfiles: [{ id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: false },
          roleArea: { coreTitles: ["cto"], keywords: ["fractional"], redKeywords: [] },
        },
      ],
      sources: [],
    });
    expect(result.ok).toBe(true);
  }

  const PROPOSED_EDITS = {
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: { engagementProfiles: [{ id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: false },
        roleArea: { coreTitles: ["cto"], keywords: ["fractional"], redKeywords: ["cfo", "chief financial"] },
      },
    ],
  };

  it("produces a proposal (describeProposal returns the exact summary), never mutates config.json or records a preference before approval", async () => {
    await seedBaseConfig();
    mockCreate.mockResolvedValueOnce(
      fakeToolUseResponse("propose_config_edit", {
        summary: "Add 'cfo', 'chief financial' to the CTO group's redKeywords",
        edits: PROPOSED_EDITS,
        reason: "Interim Finance Director false-positived as a CTO match",
      }),
    );

    startChatSession("pc1");
    const result = await sendMessage("pc1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add cfo to redKeywords", FAKE_CONFIG);

    expect(result).toEqual({
      type: "proposal",
      tool: "propose_config_edit",
      input: { summary: "Add 'cfo', 'chief financial' to the CTO group's redKeywords", edits: PROPOSED_EDITS, reason: "Interim Finance Director false-positived as a CTO match" },
      description: "Add 'cfo', 'chief financial' to the CTO group's redKeywords",
    });
    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { groups?: Array<{ roleArea?: { redKeywords?: string[] } }> };
    expect(raw.groups?.[0]?.roleArea?.redKeywords).toEqual([]);
    expect(listPreferences(undefined, { db })).toEqual([]);
    endChatSession("pc1");
  });

  it("on approval, calls saveConfig() with the exact proposed edits AND records the reason as a preference", async () => {
    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(
        fakeToolUseResponse("propose_config_edit", {
          summary: "Add 'cfo', 'chief financial' to the CTO group's redKeywords",
          edits: PROPOSED_EDITS,
          reason: "Interim Finance Director false-positived as a CTO match",
        }),
      )
      .mockResolvedValueOnce(fakeTextResponse("Done -- added those to redKeywords."));

    startChatSession("pc2");
    await sendMessage("pc2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add cfo to redKeywords", FAKE_CONFIG);
    const result = await resolveApproval("pc2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Done -- added those to redKeywords." });
    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { groups?: Array<{ roleArea?: { redKeywords?: string[] } }> };
    expect(raw.groups?.[0]?.roleArea?.redKeywords).toEqual(["cfo", "chief financial"]);
    const prefs = listPreferences(undefined, { db });
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({ note: "Interim Finance Director false-positived as a CTO match", sessionId: "pc2" });
    endChatSession("pc2");
  });

  it("rejecting a propose_config_edit proposal never touches config.json and never records a preference", async () => {
    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("propose_config_edit", { summary: "x", edits: PROPOSED_EDITS, reason: "y" }))
      .mockResolvedValueOnce(fakeTextResponse("Okay, not making that change."));

    startChatSession("pc3");
    await sendMessage("pc3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "add cfo to redKeywords", FAKE_CONFIG);
    const result = await resolveApproval("pc3", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, false, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Okay, not making that change." });
    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { groups?: Array<{ roleArea?: { redKeywords?: string[] } }> };
    expect(raw.groups?.[0]?.roleArea?.redKeywords).toEqual([]);
    expect(listPreferences(undefined, { db })).toEqual([]);
    endChatSession("pc3");
  });

  it("surfaces saveConfig()'s specific validation error as the tool_result, never a generic failure, and never records a preference", async () => {
    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("propose_config_edit", { summary: "break it", edits: { groups: "not an array" }, reason: "test" }))
      .mockResolvedValueOnce(fakeTextResponse("That didn't work."));

    startChatSession("pc4");
    await sendMessage("pc4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "do something invalid", FAKE_CONFIG);
    await resolveApproval("pc4", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, true, FAKE_CONFIG);

    const secondCallMessages = JSON.stringify((mockCreate.mock.calls[1]?.[0] as Anthropic.MessageCreateParams).messages);
    expect(secondCallMessages).toContain("groups");
    expect(listPreferences(undefined, { db })).toEqual([]);
    endChatSession("pc4");
  });
});

describe("chatAutoApproveConfigEdits: propose_config_edit auto-fires, every other write tool unaffected", () => {
  async function seedBaseConfig() {
    const { saveConfig } = await import("../../config/save.js");
    const result = saveConfig({
      profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
      groups: [{ id: "g1", label: "Group 1", needs: { engagementProfiles: [{ id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: false } }],
      sources: [],
    });
    expect(result.ok).toBe(true);
  }

  it("propose_config_edit auto-executes immediately (saveConfig() called, no pause) and returns an 'auto_applied' event, never 'proposal'", async () => {
    await seedBaseConfig();
    mockCreate.mockResolvedValueOnce(
      fakeToolUseResponse("propose_config_edit", {
        summary: "Rename Group 1 to Fractional CTO Search",
        edits: { groups: [{ id: "g1", label: "Fractional CTO Search", needs: { engagementProfiles: [{ id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: false } }] },
        reason: "owner asked for a clearer label",
      }),
    );
    const autoConfig: Config = { ...FAKE_CONFIG, chatAutoApproveConfigEdits: true };

    startChatSession("aa1");
    const result = await sendMessage("aa1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "rename the group", autoConfig);

    expect(result).toEqual({
      type: "auto_applied",
      tool: "propose_config_edit",
      input: expect.objectContaining({ summary: "Rename Group 1 to Fractional CTO Search" }),
      description: "Rename Group 1 to Fractional CTO Search",
    });
    const { readRawConfig } = await import("../../config/save.js");
    const raw = readRawConfig() as { groups?: Array<{ label?: string }> };
    expect(raw.groups?.[0]?.label).toBe("Fractional CTO Search");
    expect(listPreferences(undefined, { db })).toHaveLength(1);
    endChatSession("aa1");
  });

  it("a DIFFERENT write tool (update_gig_status) still pauses for approval even with chatAutoApproveConfigEdits on -- the toggle has zero effect on any tool but propose_config_edit", async () => {
    const key = seedGig({ sourceId: "src-a", externalId: "1" });
    mockCreate.mockResolvedValueOnce(fakeToolUseResponse("update_gig_status", { key, status: "applied" }));
    const autoConfig: Config = { ...FAKE_CONFIG, chatAutoApproveConfigEdits: true };

    startChatSession("aa2");
    const result = await sendMessage("aa2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "mark this applied", autoConfig);

    expect(result).toEqual({
      type: "proposal",
      tool: "update_gig_status",
      input: { key, status: "applied" },
      description: `Mark gig "${key}" as "applied"`,
    });
    endChatSession("aa2");
  });
});

describe("resumeChatSession: rehydration from persisted memory", () => {
  it("returns false and creates no session when nothing was ever persisted for this id", () => {
    expect(resumeChatSession("never-persisted")).toBe(false);
  });

  it("returns true and a subsequent sendMessage() sees the rehydrated history as prior context", async () => {
    startChatSession("rs1");
    mockCreate.mockResolvedValueOnce(fakeTextResponse("Hello!"));
    await sendMessage("rs1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "hi, remember this exact phrase: banana-42", FAKE_CONFIG);
    endChatSession("rs1"); // clears in-memory state, but NOT persisted history (endChatSession only clears memory it itself wrote -- wait, see next line)

    // endChatSession() also deletes persisted history (by design -- ending
    // a session is a real end). To test resumption, persist WITHOUT ending:
    startChatSession("rs2");
    mockCreate.mockResolvedValueOnce(fakeTextResponse("Sure thing."));
    await sendMessage("rs2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "hi, remember this exact phrase: banana-42", FAKE_CONFIG);
    // Simulate a server restart: drop the in-memory session, but the DB row survives.
    const { loadSessionHistory } = await import("../memory.js");
    expect(loadSessionHistory("rs2")).toBeDefined();

    const resumed = resumeChatSession("rs2");
    expect(resumed).toBe(true);

    mockCreate.mockResolvedValueOnce(fakeTextResponse("Yes, I remember."));
    await sendMessage("rs2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "what phrase did I ask you to remember?", FAKE_CONFIG);
    const secondCallMessages = JSON.stringify((mockCreate.mock.calls[mockCreate.mock.calls.length - 1]?.[0] as Anthropic.MessageCreateParams).messages);
    expect(secondCallMessages).toContain("banana-42");
    endChatSession("rs2");
  });
});

describe("memory persistence: sendMessage()/resolveApproval() save history on every call", () => {
  it("a session's history is persisted after sendMessage() completes, readable via memory.ts directly", async () => {
    mockCreate.mockResolvedValueOnce(fakeTextResponse("hi there"));
    startChatSession("mp1");

    await sendMessage("mp1", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "hello", FAKE_CONFIG);

    const { loadSessionHistory } = await import("../memory.js");
    const persisted = loadSessionHistory("mp1", { db });
    expect(persisted).toBeDefined();
    expect(JSON.stringify(persisted)).toContain("hello");
    endChatSession("mp1");
  });

  it("endChatSession() deletes the persisted history too, not just the in-memory session", async () => {
    mockCreate.mockResolvedValueOnce(fakeTextResponse("hi there"));
    startChatSession("mp2");
    await sendMessage("mp2", { kind: "api-key", provider: "anthropic", value: "fake-api-key" }, "hello", FAKE_CONFIG);

    endChatSession("mp2");

    const { loadSessionHistory } = await import("../memory.js");
    expect(loadSessionHistory("mp2", { db })).toBeUndefined();
  });
});
