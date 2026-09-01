// Tests for the chat Server Actions (../actions.ts). agent-chat-loop.ts
// is mocked -- this suite exercises ONLY these actions' own logic (the
// {ok,error} convention, the missing-API-key gate, session id plumbing).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startChatSessionMock = vi.fn();
const endChatSessionMock = vi.fn();
const sendMessageMock = vi.fn();
const resolveApprovalMock = vi.fn();
vi.mock("@/lib/chat/agent-chat-loop", () => ({
  startChatSession: (...args: unknown[]) => startChatSessionMock(...args),
  endChatSession: (...args: unknown[]) => endChatSessionMock(...args),
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  resolveApproval: (...args: unknown[]) => resolveApprovalMock(...args),
}));

import { setEnvVar } from "@/lib/config/env-store";
import { saveConfig, type ConfigEdits } from "@/lib/config/save";
import { endChatSessionAction, resolveChatApprovalAction, sendChatMessageAction, startChatSessionAction } from "../actions";

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
  sendMessageMock.mockReset();
  resolveApprovalMock.mockReset();
});

afterEach(async () => {
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

describe("endChatSessionAction", () => {
  it("ends the given session", async () => {
    const result = await endChatSessionAction("s1");
    expect(result).toEqual({ ok: true, data: null });
    expect(endChatSessionMock).toHaveBeenCalledWith("s1");
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

  it("resolves the credential via resolveLlmCredential() and forwards the message to sendMessage()", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
    sendMessageMock.mockResolvedValue({ type: "message", text: "hi there" });

    const result = await sendChatMessageAction("s1", "hello");

    expect(result).toEqual({ ok: true, data: { type: "message", text: "hi there" } });
    expect(sendMessageMock).toHaveBeenCalledWith("s1", { kind: "api-key", provider: "anthropic", value: "fake-key" }, "hello");
  });

  it("returns {ok:false} when sendMessage() itself throws (e.g. unknown session)", async () => {
    setEnvVar("ANTHROPIC_API_KEY", "fake-key");
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
