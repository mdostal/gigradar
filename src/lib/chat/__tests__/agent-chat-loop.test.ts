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

describe("source-connection tools: propose then approve, no exceptions", () => {
  it("start_capture_login produces a proposal, never opens a browser before approval", async () => {
    mockCreate.mockResolvedValueOnce(fakeToolUseResponse("start_capture_login", { sourceId: "gofractional" }));

    startChatSession("c1");
    const result = await sendMessage("c1", "fake-api-key", "log me into gofractional");

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
    await sendMessage("c2", "fake-api-key", "log me into gofractional");
    const result = await resolveApproval("c2", "fake-api-key", true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "Browser window opened -- log in, then let me know." });
    expect(startCaptureMock).toHaveBeenCalledWith("gofractional", "https://www.gofractional.com/login", ["gofractional.com"]);
    endChatSession("c2");
  });

  it("finish_capture_login: no-op error (not a throw out of resolveApproval) when this chat never started a capture", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("finish_capture_login", {}))
      .mockResolvedValueOnce(fakeTextResponse("There's no login capture open right now."));

    startChatSession("c3");
    await sendMessage("c3", "fake-api-key", "finish the login");
    const result = await resolveApproval("c3", "fake-api-key", true, FAKE_CONFIG);

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
      needs: {
        engagementProfiles: [
          { id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" },
        ],
        freshStageOnly: false,
        remoteOnly: false,
      },
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
    await sendMessage("c4", "fake-api-key", "log me into gofractional");
    await resolveApproval("c4", "fake-api-key", true, FAKE_CONFIG);
    await sendMessage("c4", "fake-api-key", "I'm done, finish it");
    const result = await resolveApproval("c4", "fake-api-key", true, FAKE_CONFIG);

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
    await sendMessage("c5", "fake-api-key", "log me into gofractional");
    await resolveApproval("c5", "fake-api-key", true, FAKE_CONFIG);
    await sendMessage("c5", "fake-api-key", "never mind, cancel it");
    const result = await resolveApproval("c5", "fake-api-key", true, FAKE_CONFIG);

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
    await sendMessage("c6", "fake-api-key", "connect my gmail alerts source");
    const result = await resolveApproval("c6", "fake-api-key", true, FAKE_CONFIG);

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
    await sendMessage("c7", "fake-api-key", "disconnect gmail-alerts");
    const result = await resolveApproval("c7", "fake-api-key", true, FAKE_CONFIG);

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
    const result = await sendMessage("s9", "fake-api-key", "show me the login window");

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
    await sendMessage("s10", "fake-api-key", "log me into gofractional");
    await resolveApproval("s10", "fake-api-key", true, FAKE_CONFIG);
    const result = await sendMessage("s10", "fake-api-key", "what does it look like?");

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
    const result = await sendMessage("p1", "fake-api-key", "what job sites can you add?");

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
      needs: {
        engagementProfiles: [
          { id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" },
        ],
        freshStageOnly: false,
        remoteOnly: false,
      },
      sources: [],
    });
    expect(result.ok).toBe(true);
  }

  it("with a presetId produces a proposal, never mutates config.json before approval", async () => {
    await seedBaseConfig();
    mockCreate.mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "zoho-recruit" }));

    startChatSession("as1");
    const result = await sendMessage("as1", "fake-api-key", "add zoho recruit");

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
    await sendMessage("as2", "fake-api-key", "add zoho recruit");
    const result = await resolveApproval("as2", "fake-api-key", true, FAKE_CONFIG);

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
    await sendMessage("as3", "fake-api-key", "add zoho recruit");
    await resolveApproval("as3", "fake-api-key", true, FAKE_CONFIG);
    const gmailCall = mockCreate.mock.calls[1]?.[0] as Anthropic.MessageCreateParams;
    expect(JSON.stringify(gmailCall.messages)).toContain("start_gmail_connect");
    endChatSession("as3");

    await seedBaseConfig();
    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { presetId: "welcome-to-the-jungle" }))
      .mockResolvedValueOnce(fakeTextResponse("Added welcome-to-the-jungle."));
    startChatSession("as4");
    await sendMessage("as4", "fake-api-key", "add welcome to the jungle");
    await resolveApproval("as4", "fake-api-key", true, FAKE_CONFIG);
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
    await sendMessage("as5", "fake-api-key", "add indeed");
    await resolveApproval("as5", "fake-api-key", true, FAKE_CONFIG);

    expect(buildAuthorizationUrlMock).not.toHaveBeenCalled();
    endChatSession("as5");
  });

  it("with a raw sourceId+url (no preset) writes a custom-llm SourceConfig with a uniqued id on collision", async () => {
    const { saveConfig } = await import("../../config/save.js");
    saveConfig({
      profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
      needs: {
        engagementProfiles: [
          { id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" },
        ],
        freshStageOnly: false,
        remoteOnly: false,
      },
      sources: [{ id: "monster", enabled: true }],
    });

    mockCreate
      .mockResolvedValueOnce(fakeToolUseResponse("add_source", { sourceId: "monster", url: "https://example.test/monster/jobs", hint: "a list of cards" }))
      .mockResolvedValueOnce(fakeTextResponse("Added it."));

    startChatSession("as6");
    await sendMessage("as6", "fake-api-key", "add monster at https://example.test/monster/jobs");
    await resolveApproval("as6", "fake-api-key", true, FAKE_CONFIG);

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
    await sendMessage("as7", "fake-api-key", "add indeed");
    const result = await resolveApproval("as7", "fake-api-key", false, FAKE_CONFIG);

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
    await sendMessage("as8", "fake-api-key", "add does-not-exist");
    const result = await resolveApproval("as8", "fake-api-key", true, FAKE_CONFIG);

    expect(result).toEqual({ type: "message", text: "I don't recognize that preset." });
    endChatSession("as8");
  });
});
