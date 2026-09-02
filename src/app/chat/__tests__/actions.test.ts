// Tests for the chat Server Actions (../actions.ts). agent-chat-loop.ts
// is mocked -- this suite exercises ONLY these actions' own logic (the
// {ok,error} convention, the missing-API-key gate, session id plumbing).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startChatSessionMock = vi.fn();
const endChatSessionMock = vi.fn();
const resumeChatSessionMock = vi.fn();
const sendMessageMock = vi.fn();
const resolveApprovalMock = vi.fn();
// buildContextSeedBlock is real (not mocked) -- it's a pure string builder
// (chat-copilot-self-tuning epic, Slice 2), so exercising the real
// implementation is more useful than stubbing it, and startContextualChatSessionAction's
// own tests assert on startChatSessionMock's second arg to prove the real
// seed actually reached it.
vi.mock("@/lib/chat/agent-chat-loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chat/agent-chat-loop")>();
  return {
    ...actual,
    startChatSession: (...args: unknown[]) => startChatSessionMock(...args),
    endChatSession: (...args: unknown[]) => endChatSessionMock(...args),
    resumeChatSession: (...args: unknown[]) => resumeChatSessionMock(...args),
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
    resolveApproval: (...args: unknown[]) => resolveApprovalMock(...args),
  };
});

import { setEnvVar } from "@/lib/config/env-store";
import { saveConfig, type ConfigEdits } from "@/lib/config/save";
import { closeDb, recordScan, saveDraft } from "@/lib/store";
import {
  endChatSessionAction,
  resolveChatApprovalAction,
  resumeChatSessionAction,
  sendChatMessageAction,
  startChatSessionAction,
  startContextualChatSessionAction,
} from "../actions";

function baseConfigEdits(): ConfigEdits {
  return {
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
    sources: [{ id: "braintrust", enabled: true }],
  };
}

let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-chat-action-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-chat-action-test-key-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  startChatSessionMock.mockReset();
  endChatSessionMock.mockReset();
  resumeChatSessionMock.mockReset();
  sendMessageMock.mockReset();
  resolveApprovalMock.mockReset();
});

afterEach(async () => {
  closeDb();
  const fs = await import("node:fs");
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
});

describe("startChatSessionAction", () => {
  it("starts a real session with a fresh, non-empty sessionId", async () => {
    const result = await startChatSessionAction();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.sessionId.length).toBeGreaterThan(0);
    expect(startChatSessionMock).toHaveBeenCalledWith(result.data.sessionId);
  });
});

describe("startContextualChatSessionAction (chat-copilot-self-tuning epic, Slice 2)", () => {
  it("gig: seeds the session with the real gig's data and returns its title as the contextLabel", async () => {
    recordScan([{ sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "Fractional CTO at Acme", company: "Acme", url: "https://example.test/1" }] }]);

    const result = await startContextualChatSessionAction("gig", "src-a:1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.contextLabel).toBe("Fractional CTO at Acme");
    expect(startChatSessionMock).toHaveBeenCalledTimes(1);
    const [, seed] = startChatSessionMock.mock.calls[0] as [string, string];
    expect(seed).toContain("Fractional CTO at Acme");
    expect(seed).toContain("Acme");
  });

  it("gig: returns {ok:false} for an unknown gig key, never calls startChatSession", async () => {
    const result = await startContextualChatSessionAction("gig", "does-not:exist");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("does-not:exist");
    expect(startChatSessionMock).not.toHaveBeenCalled();
  });

  it("draft: seeds the session with both the draft content and its linked gig's title as contextLabel", async () => {
    recordScan([{ sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "Fractional CTO at Acme", url: "https://example.test/1" }] }]);
    saveDraft("src-a:1", { coverText: "Dear hiring manager...", answers: {} });

    const result = await startContextualChatSessionAction("draft", "src-a:1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.contextLabel).toBe("Fractional CTO at Acme");
    const [, seed] = startChatSessionMock.mock.calls[0] as [string, string];
    expect(seed).toContain("Dear hiring manager");
  });

  it("draft: returns {ok:false} for a gig key with no draft, never calls startChatSession", async () => {
    recordScan([{ sourceId: "src-a", gigs: [{ sourceId: "src-a", externalId: "1", title: "T", url: "https://example.test/1" }] }]);

    const result = await startContextualChatSessionAction("draft", "src-a:1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(startChatSessionMock).not.toHaveBeenCalled();
  });

  it("source: seeds the session with id/enabled/kind/groupIds but OMITS settings (opaque, may reference secrets)", async () => {
    saveConfig({
      profile: { name: "Test", roles: [], skills: [], timezone: "UTC" },
      groups: [{ id: "g1", label: "Group 1", needs: { engagementProfiles: [{ id: "p1", label: "Hourly", types: ["contract"], minRate: 100, highRate: 150, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: true } }],
      sources: [{ id: "braintrust", enabled: true, settings: { apiToken: "env:BRAINTRUST_TOKEN" } }],
    });

    const result = await startContextualChatSessionAction("source", "braintrust");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.contextLabel).toBe("braintrust");
    const [, seed] = startChatSessionMock.mock.calls[0] as [string, string];
    expect(seed).toContain("braintrust");
    expect(seed).not.toContain("BRAINTRUST_TOKEN");
    expect(seed).not.toContain("apiToken");
  });

  it("source: returns {ok:false} for an unknown source id, never calls startChatSession", async () => {
    saveConfig({
      profile: { name: "Test", roles: [], skills: [], timezone: "UTC" },
      groups: [{ id: "g1", label: "Group 1", needs: { engagementProfiles: [{ id: "p1", label: "Hourly", types: ["contract"], minRate: 100, highRate: 150, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: true } }],
      sources: [],
    });

    const result = await startContextualChatSessionAction("source", "does-not-exist");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(startChatSessionMock).not.toHaveBeenCalled();
  });
});

describe("endChatSessionAction", () => {
  it("ends the given session", async () => {
    const result = await endChatSessionAction("s1");
    expect(result).toEqual({ ok: true, data: null });
    expect(endChatSessionMock).toHaveBeenCalledWith("s1");
  });
});

describe("resumeChatSessionAction", () => {
  it("returns resumed:true when the lib call finds a persisted session", async () => {
    resumeChatSessionMock.mockReturnValue(true);

    const result = await resumeChatSessionAction("s1");

    expect(result).toEqual({ ok: true, data: { resumed: true } });
    expect(resumeChatSessionMock).toHaveBeenCalledWith("s1");
  });

  it("returns resumed:false (never an error) when nothing was persisted for this id", async () => {
    resumeChatSessionMock.mockReturnValue(false);

    const result = await resumeChatSessionAction("never-persisted");

    expect(result).toEqual({ ok: true, data: { resumed: false } });
  });
});

describe("sendChatMessageAction", () => {
  it("returns a specific error naming the Anthropic credential, never calls sendMessage", async () => {
    const result = await sendChatMessageAction("s1", "hello");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("Anthropic credential");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("returns a specific config-invalid error, never calls sendMessage, when no valid config.json exists yet", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");

    const result = await sendChatMessageAction("s1", "hello");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("/config");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("resolves the credential + a real validated Config, and forwards the message to sendMessage()", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    saveConfig(baseConfigEdits());
    sendMessageMock.mockResolvedValue({ type: "message", text: "hi there" });

    const result = await sendChatMessageAction("s1", "hello");

    expect(result).toEqual({ ok: true, data: { type: "message", text: "hi there" } });
    expect(sendMessageMock).toHaveBeenCalledWith(
      "s1",
      { kind: "api-key", provider: "anthropic", value: "fake-key" },
      "hello",
      expect.objectContaining({ profile: expect.objectContaining({ name: "Jane Doe" }) }),
    );
  });

  it("returns {ok:false} when sendMessage() itself throws (e.g. unknown session)", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    saveConfig(baseConfigEdits());
    sendMessageMock.mockRejectedValue(new Error("no chat session"));

    const result = await sendChatMessageAction("never-started", "hello");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no chat session");
  });
});

describe("resolveChatApprovalAction", () => {
  it("returns a specific error naming the Anthropic credential, never calls resolveApproval", async () => {
    const result = await resolveChatApprovalAction("s1", true);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("Anthropic credential");
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it("returns a specific config-invalid error, never calls resolveApproval, when no valid config.json exists yet", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");

    const result = await resolveChatApprovalAction("s1", true);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("/config");
    expect(resolveApprovalMock).not.toHaveBeenCalled();
  });

  it("resolves the credential + a real validated Config, and forwards approve through to resolveApproval()", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    saveConfig(baseConfigEdits());
    resolveApprovalMock.mockResolvedValue({ type: "message", text: "Done." });

    const result = await resolveChatApprovalAction("s1", true);

    expect(result).toEqual({ ok: true, data: { type: "message", text: "Done." } });
    expect(resolveApprovalMock).toHaveBeenCalledWith("s1", { kind: "api-key", provider: "anthropic", value: "fake-key" }, true, expect.objectContaining({ profile: expect.objectContaining({ name: "Jane Doe" }) }));
  });

  it("forwards approve:false through to resolveApproval() unchanged", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    saveConfig(baseConfigEdits());
    resolveApprovalMock.mockResolvedValue({ type: "message", text: "Rejected." });

    await resolveChatApprovalAction("s1", false);

    expect(resolveApprovalMock).toHaveBeenCalledWith("s1", { kind: "api-key", provider: "anthropic", value: "fake-key" }, false, expect.anything());
  });

  it("returns {ok:false} when resolveApproval() itself throws (e.g. no pending approval)", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    saveConfig(baseConfigEdits());
    resolveApprovalMock.mockRejectedValue(new Error("no pending approval"));

    const result = await resolveChatApprovalAction("s1", true);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("no pending approval");
  });
});
