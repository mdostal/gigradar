import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePart, TextPart } from "ai";
import type { ApplyProfileConfig, Gig, GroupConfig, Profile } from "../../types.js";

// Zero real API calls happen in this automated suite -- same mocking shape
// as apply/__tests__/draft.test.ts (this module's own sibling call site).
const { mockGenerateText, mockCreateAnthropic, mockAnthropicModel, mockGenerateHarnessObject } = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ modelId, provider: "anthropic" }));
  return {
    mockGenerateText: vi.fn(),
    mockCreateAnthropic: vi.fn(() => mockAnthropicModel),
    mockAnthropicModel,
    mockGenerateHarnessObject: vi.fn(),
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: mockGenerateText };
});

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mockCreateAnthropic }));

vi.mock("../../config/llm-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/llm-client.js")>();
  return { ...actual, generateHarnessObject: mockGenerateHarnessObject };
});

import { NoOutputGeneratedError } from "ai";
import { applyAiVerification, verifyGroupMatch } from "../ai-verify.js";
import { saveResume } from "../../documents/resume-store.js";

beforeEach(() => {
  mockGenerateText.mockReset();
  mockCreateAnthropic.mockClear();
  mockAnthropicModel.mockClear();
  mockGenerateHarnessObject.mockReset();
  mockGenerateText.mockResolvedValue({ output: { confirmed: true, reason: "Genuinely a CTO-type role." } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const CTO_GROUP: GroupConfig = {
  id: "cto",
  label: "Fractional CTO Search",
  needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false },
  roleArea: { coreTitles: ["cto"], keywords: ["fractional", "interim"], redKeywords: ["cfo"] },
};

const FINANCE_GIG: Gig = {
  sourceId: "fractionus",
  externalId: "1",
  title: "Interim Finance Director",
  company: "Elevation Recruitment Group",
  url: "https://fractionus.com/jobs/1",
  description: "Lead financial planning for a growth-stage company.",
};

const REAL_PROFILE: Profile = {
  name: "Jane Doe",
  roles: ["Fractional CTO"],
  skills: ["TypeScript", "Team Leadership"],
  timezone: "America/Chicago",
};

/** deep-memory-and-context epic: generateText() is now called with a messages/content-blocks array (same shape as draft.ts/prep.ts). */
function messageContentSentToLLM(): Array<TextPart | FilePart> {
  const call = mockGenerateText.mock.calls[0]?.[0] as { messages?: Array<{ content?: unknown }> } | undefined;
  const content = call?.messages?.[0]?.content;
  if (!Array.isArray(content)) throw new Error("test setup: generateText() was not called with a messages content array");
  return content as Array<TextPart | FilePart>;
}

/** Joins every text block into a single string so existing `.toContain()` assertions still work unchanged. */
function promptSentToLLM(): string {
  return messageContentSentToLLM()
    .filter((b): b is TextPart => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

describe("verifyGroupMatch: structured output", () => {
  it("returns {confirmed, reason} parsed from the mocked model's structured output", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { confirmed: false, reason: "This is a Finance role, not engineering leadership." } });

    const result = await verifyGroupMatch(FINANCE_GIG, CTO_GROUP, REAL_PROFILE, undefined, { kind: "api-key", provider: "anthropic", value: "fake-api-key" });

    expect(result).toEqual({ confirmed: false, reason: "This is a Finance role, not engineering leadership." });
  });

  it("includes the group's intent, the candidate's tracked background, and the gig's own data in the prompt sent to the model", async () => {
    await verifyGroupMatch(FINANCE_GIG, CTO_GROUP, REAL_PROFILE, undefined, { kind: "api-key", provider: "anthropic", value: "fake-api-key" });

    const prompt = promptSentToLLM();
    expect(prompt).toContain(CTO_GROUP.label);
    expect(prompt).toContain("cto");
    expect(prompt).toContain(REAL_PROFILE.roles[0]);
    expect(prompt).toContain(REAL_PROFILE.skills[0]);
    expect(prompt).toContain(FINANCE_GIG.title);
    expect(prompt).toContain(FINANCE_GIG.company);
  });

  it("throws a specific error when the model's response has no expected structured output", async () => {
    mockGenerateText.mockResolvedValueOnce({
      get output() {
        throw new NoOutputGeneratedError();
      },
    });

    await expect(
      verifyGroupMatch(FINANCE_GIG, CTO_GROUP, REAL_PROFILE, undefined, { kind: "api-key", provider: "anthropic", value: "fake-api-key" }),
    ).rejects.toThrow(/did not include the expected structured verification result/);
  });
});

describe("verifyGroupMatch: claude-code-harness credential routes to generateHarnessObject, never the AI SDK", () => {
  it("calls generateHarnessObject with the joined prompt and never touches createAnthropic/generateText", async () => {
    mockGenerateHarnessObject.mockResolvedValueOnce({ confirmed: false, reason: "Not an engineering role." });

    const result = await verifyGroupMatch(FINANCE_GIG, CTO_GROUP, REAL_PROFILE, undefined, { kind: "claude-code-harness" });

    expect(result).toEqual({ confirmed: false, reason: "Not an engineering role." });
    expect(mockGenerateHarnessObject).toHaveBeenCalledTimes(1);
    expect(mockCreateAnthropic).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe("applyAiVerification: orchestration", () => {
  const NO_AI_GROUP: GroupConfig = { ...CTO_GROUP, id: "no-ai", aiVerify: false };
  const AI_GROUP: GroupConfig = { ...CTO_GROUP, id: "ai-on", aiVerify: true };
  const groupsById = new Map([
    [NO_AI_GROUP.id, NO_AI_GROUP],
    [AI_GROUP.id, AI_GROUP],
  ]);
  const CREDENTIAL = { kind: "api-key" as const, provider: "anthropic" as const, value: "fake-api-key" };

  it("is a no-op (no LLM call, matchedGroupIds/aiFlags unchanged) when no matched group has aiVerify on", async () => {
    const result = await applyAiVerification(FINANCE_GIG, [NO_AI_GROUP.id], groupsById, REAL_PROFILE, undefined, CREDENTIAL);

    expect(result).toEqual({ matchedGroupIds: [NO_AI_GROUP.id], aiFlags: {} });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("is a no-op when a group has aiVerify on but no LLM credential resolved this cycle", async () => {
    const result = await applyAiVerification(FINANCE_GIG, [AI_GROUP.id], groupsById, REAL_PROFILE, undefined, undefined);

    expect(result).toEqual({ matchedGroupIds: [AI_GROUP.id], aiFlags: {} });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("keeps the group in matchedGroupIds and records aiFlags when the AI confirms the match", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { confirmed: true, reason: "Genuinely a CTO-type role." } });

    const result = await applyAiVerification(FINANCE_GIG, [AI_GROUP.id], groupsById, REAL_PROFILE, undefined, CREDENTIAL);

    expect(result.matchedGroupIds).toEqual([AI_GROUP.id]);
    expect(result.aiFlags).toEqual({ [AI_GROUP.id]: { confirmed: true, reason: "Genuinely a CTO-type role." } });
  });

  it("removes the group from matchedGroupIds (but still records the flag) when the AI does NOT confirm the match", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { confirmed: false, reason: "This is a Finance role, not engineering leadership." } });

    const result = await applyAiVerification(FINANCE_GIG, [AI_GROUP.id], groupsById, REAL_PROFILE, undefined, CREDENTIAL);

    expect(result.matchedGroupIds).toEqual([]);
    expect(result.aiFlags).toEqual({ [AI_GROUP.id]: { confirmed: false, reason: "This is a Finance role, not engineering leadership." } });
  });

  it("only verifies the groups that have aiVerify on, leaving a non-aiVerify group's match untouched in the same call", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { confirmed: false, reason: "Wrong role type." } });

    const result = await applyAiVerification(FINANCE_GIG, [NO_AI_GROUP.id, AI_GROUP.id], groupsById, REAL_PROFILE, undefined, CREDENTIAL);

    expect(result.matchedGroupIds).toEqual([NO_AI_GROUP.id]);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("never drops the heuristic match when the AI call itself throws -- the heuristic result stands, no aiFlags entry for that group", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("simulated API failure"));

    const result = await applyAiVerification(FINANCE_GIG, [AI_GROUP.id], groupsById, REAL_PROFILE, undefined, CREDENTIAL);

    expect(result.matchedGroupIds).toEqual([AI_GROUP.id]);
    expect(result.aiFlags).toEqual({});
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("verifyGroupMatch: real resume file attachment (deep-memory-and-context epic)", () => {
  let tmpDataDir: string;
  let tmpKeyDir: string;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-ai-verify-resume-test-"));
    tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-ai-verify-resume-test-key-"));
    process.env.XDG_DATA_HOME = tmpDataDir;
    process.env.XDG_CONFIG_HOME = tmpKeyDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpKeyDir, { recursive: true, force: true });
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  it("when applyProfile.resumePath is set and loadResume() succeeds, embeds the real resume as a file content part", async () => {
    const { path: resumePath } = saveResume(Buffer.from("%PDF-1.4 fake resume for ai-verify test"), "application/pdf");
    const applyProfileWithResume: ApplyProfileConfig = { email: "jane@example.com", resumePath };

    await verifyGroupMatch(FINANCE_GIG, CTO_GROUP, REAL_PROFILE, applyProfileWithResume, { kind: "api-key", provider: "anthropic", value: "fake-api-key" });

    const fileBlock = messageContentSentToLLM().find((b) => b.type === "file");
    expect(fileBlock).toBeDefined();
  });

  it("when applyProfile is undefined or resumePath is unset, no file block -- unaffected", async () => {
    await verifyGroupMatch(FINANCE_GIG, CTO_GROUP, REAL_PROFILE, undefined, { kind: "api-key", provider: "anthropic", value: "fake-api-key" });

    expect(messageContentSentToLLM().some((b) => b.type === "file")).toBe(false);
  });

  it("when resumePath is set but the file has been deleted, degrades gracefully -- no error, no file block", async () => {
    const { path: resumePath } = saveResume(Buffer.from("%PDF-1.4 to be deleted"), "application/pdf");
    fs.unlinkSync(resumePath);
    const applyProfileWithMissingResume: ApplyProfileConfig = { email: "jane@example.com", resumePath };

    await expect(
      verifyGroupMatch(FINANCE_GIG, CTO_GROUP, REAL_PROFILE, applyProfileWithMissingResume, { kind: "api-key", provider: "anthropic", value: "fake-api-key" }),
    ).resolves.toBeDefined();
    expect(messageContentSentToLLM().some((b) => b.type === "file")).toBe(false);
  });
});
