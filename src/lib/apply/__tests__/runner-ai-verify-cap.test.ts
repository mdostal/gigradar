// ai-verify-timeout-and-cap story (triage t-003): proves the real,
// exported AI_VERIFY_CAP (apply/runner.ts) is actually enforced end-to-end
// by runRadar() itself, across MULTIPLE gigs in one cycle -- mirrors
// runner-rank-bucket.test.ts's own RANK_BUCKET_AI_OVERLAY_CAP enforcement
// describe block (triage t-002).
//
// Unlike runner-ai-verify.test.ts (which mocks matching/ai-verify.js
// wholesale to test ONLY runRadar()'s own wiring -- gig/groupsById/
// profile/credential arguments), this file needs the REAL
// applyAiVerification() to actually run: the cap-enforcement logic
// (remainingCap/callsMade) lives INSIDE that function itself (see its own
// doc comment in ai-verify.ts for why, given its per-gig multi-group loop
// shape differs from the rank-bucket overlay's per-(gig, group) call site
// directly in runner.ts's loop). So only the underlying LLM call
// (generateText) is mocked here -- the SAME "zero real API calls" mocking
// shape matching/__tests__/ai-verify.test.ts itself already uses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, Gig } from "../../types.js";

const { mockGenerateText, mockCreateAnthropic, mockAnthropicModel } = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ modelId, provider: "anthropic" }));
  return {
    mockGenerateText: vi.fn(),
    mockCreateAnthropic: vi.fn(() => mockAnthropicModel),
    mockAnthropicModel,
  };
});

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: mockGenerateText };
});

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mockCreateAnthropic }));

import { registerSource } from "../../sources/source.js";
import { closeDb, getDb, getGig } from "../../store/index.js";
import { AI_VERIFY_CAP, runRadar } from "../runner.js";

let nextGigs: Gig[] = [];
registerSource({
  id: "braintrust",
  label: "Braintrust (test double)",
  auth: "none",
  async fetch(): Promise<Gig[]> {
    return nextGigs;
  },
});

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-ai-verify-cap-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  nextGigs = [];
  mockGenerateText.mockReset();
  mockCreateAnthropic.mockClear();
  mockAnthropicModel.mockClear();
  mockGenerateText.mockResolvedValue({ output: { confirmed: true, reason: "Confirmed." } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeConfig(): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: {
          engagementProfiles: [{ id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" }],
          freshStageOnly: false,
          remoteOnly: false,
        },
        aiVerify: true,
      },
    ],
    sources: [{ id: "braintrust", enabled: true }],
  };
}

function makeGig(externalId: string): Gig {
  return { sourceId: "braintrust", externalId, title: "Fractional CTO", url: `https://example.test/${externalId}` };
}

describe("runRadar: AI_VERIFY_CAP enforcement (ai-verify-timeout-and-cap, triage t-003)", () => {
  const CREDENTIAL = { kind: "api-key" as const, provider: "anthropic" as const, value: "fake-api-key" };

  it("calls the underlying LLM at most AI_VERIFY_CAP times in one cycle, even with more eligible gigs than the cap", async () => {
    const total = AI_VERIFY_CAP + 5;
    nextGigs = Array.from({ length: total }, (_, i) => makeGig(String(i)));

    await runRadar(makeConfig(), { db }, { credential: CREDENTIAL });

    expect(mockGenerateText).toHaveBeenCalledTimes(AI_VERIFY_CAP);
  });

  it("gigs beyond the cap keep the heuristic-only match this cycle -- matchedGroupIds unchanged, no aiFlags entry, never broken", async () => {
    const total = AI_VERIFY_CAP + 5;
    nextGigs = Array.from({ length: total }, (_, i) => makeGig(String(i)));

    await runRadar(makeConfig(), { db }, { credential: CREDENTIAL });

    for (let i = 0; i < total; i++) {
      const stored = getGig(`braintrust:${i}`, { db });
      expect(stored?.matchedGroupIds).toEqual(["g1"]);
      if (i < AI_VERIFY_CAP) {
        expect(stored?.aiFlags).toEqual({ g1: { confirmed: true, reason: "Confirmed." } });
      } else {
        expect(stored?.aiFlags).toBeUndefined();
      }
    }
  });

  it("does not consume the cap when no credential resolves this cycle -- a free no-op, same as RANK_BUCKET_AI_OVERLAY_CAP's own precedent", async () => {
    const total = AI_VERIFY_CAP + 5;
    nextGigs = Array.from({ length: total }, (_, i) => makeGig(String(i)));

    await runRadar(makeConfig(), { db }); // no credential this cycle

    expect(mockGenerateText).not.toHaveBeenCalled();
    for (let i = 0; i < total; i++) {
      const stored = getGig(`braintrust:${i}`, { db });
      expect(stored?.matchedGroupIds).toEqual(["g1"]);
      expect(stored?.aiFlags).toBeUndefined();
    }
  });
});
