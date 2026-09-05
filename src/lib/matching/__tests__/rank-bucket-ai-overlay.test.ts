import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePart, TextPart } from "ai";
import type { GroupConfig } from "../../types.js";

// Zero real API calls -- same mocking shape as ai-verify.test.ts (this
// module's own sibling call site).
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

import { applyRankBucketAiOverlay, suggestRankBucket } from "../rank-bucket-ai-overlay.js";

beforeEach(() => {
  mockGenerateText.mockReset();
  mockCreateAnthropic.mockClear();
  mockAnthropicModel.mockClear();
  mockGenerateHarnessObject.mockReset();
  mockGenerateText.mockResolvedValue({ output: { bucket: "Tier 1", reason: "Strong fit for Tier 1." } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CREDENTIAL = { kind: "api-key" as const, provider: "anthropic" as const, value: "fake-api-key" };

const GROUP: GroupConfig = {
  id: "g1",
  label: "Fractional CTO Search",
  needs: { engagementProfiles: [], freshStageOnly: false, remoteOnly: false },
  rankBuckets: [
    { label: "Tier 1", description: "Series B+, remote-first, $200+/hr" },
    { label: "Tier 2", description: "Everything else worth a look" },
  ],
  rankBucketAiOverlay: true,
};

const GIG = { title: "Fractional CTO at Acme", company: "Acme Robotics", description: "Remote, Series C, $220/hr." };

describe("suggestRankBucket", () => {
  it("returns {bucket, reason} parsed from the mocked model's structured output", async () => {
    const result = await suggestRankBucket(GIG, GROUP, { bucket: "Tier 2", reasons: [] }, CREDENTIAL);
    expect(result).toEqual({ bucket: "Tier 1", reason: "Strong fit for Tier 1." });
  });

  it("uses the claude-code-harness path when credential.kind is that", async () => {
    mockGenerateHarnessObject.mockResolvedValueOnce({ bucket: "Tier 1", reason: "Harness path." });
    const result = await suggestRankBucket(GIG, GROUP, { bucket: null, reasons: [] }, { kind: "claude-code-harness" });
    expect(result).toEqual({ bucket: "Tier 1", reason: "Harness path." });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

describe("applyRankBucketAiOverlay", () => {
  it("returns the rule-based result untouched when the group hasn't opted in", async () => {
    const offGroup: GroupConfig = { ...GROUP, rankBucketAiOverlay: false };
    const result = await applyRankBucketAiOverlay(GIG, offGroup, { bucket: "Tier 2", reasons: [] }, CREDENTIAL);
    expect(result).toEqual({ bucket: "Tier 2", source: "rule", confirmed: true });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns the rule-based result untouched when opted in but no credential resolved this cycle", async () => {
    const result = await applyRankBucketAiOverlay(GIG, GROUP, { bucket: "Tier 2", reasons: [] }, undefined);
    expect(result).toEqual({ bucket: "Tier 2", source: "rule", confirmed: true });
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns the rule-based result untouched when the AI agrees with it", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { bucket: "Tier 2", reason: "Agrees." } });
    const result = await applyRankBucketAiOverlay(GIG, GROUP, { bucket: "Tier 2", reasons: [] }, CREDENTIAL);
    expect(result).toEqual({ bucket: "Tier 2", source: "rule", confirmed: true });
  });

  it("returns an unconfirmed AI suggestion when it DIFFERS from the rule-based result -- never silently overwrites the rule result", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { bucket: "Tier 1", reason: "Actually looks like Tier 1." } });
    const result = await applyRankBucketAiOverlay(GIG, GROUP, { bucket: "Tier 2", reasons: [] }, CREDENTIAL);
    expect(result).toEqual({ bucket: "Tier 1", source: "ai", confirmed: false, reason: "Actually looks like Tier 1." });
  });

  it("handles a rule-based null bucket -- AI can suggest a real bucket where the rule found none", async () => {
    mockGenerateText.mockResolvedValueOnce({ output: { bucket: "Tier 2", reason: "Fits Tier 2 even though no rule matched." } });
    const result = await applyRankBucketAiOverlay(GIG, GROUP, { bucket: null, reasons: [] }, CREDENTIAL);
    expect(result).toEqual({ bucket: "Tier 2", source: "ai", confirmed: false, reason: "Fits Tier 2 even though no rule matched." });
  });

  it("falls back to the rule-based result, logging a warning, when the AI call itself throws -- never fails the scan", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("simulated API failure"));
    const result = await applyRankBucketAiOverlay(GIG, GROUP, { bucket: "Tier 2", reasons: [] }, CREDENTIAL);
    expect(result).toEqual({ bucket: "Tier 2", source: "rule", confirmed: true });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("rank-bucket AI overlay failed"));
  });
});
