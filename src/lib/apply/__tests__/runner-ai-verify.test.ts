// Proves runRadar() actually wires up applyAiVerification() (ai-match-
// verification epic) -- NOT re-testing applyAiVerification()'s own
// orchestration logic (see matching/__tests__/ai-verify.test.ts for that),
// only that runRadar() calls it with the right arguments and correctly
// folds its result (a possibly-narrowed matchedGroupIds + aiFlags) back
// into the persisted gig and MatchResult.pass. matching/ai-verify.js is
// mocked wholesale -- same "mock the LLM-calling module entirely, test the
// call site's own wiring" pattern as stage-application.test.ts's
// generateDraft mock.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiVerifyResult } from "../../matching/ai-verify.js";
import type { Config, Gig } from "../../types.js";

const { mockApplyAiVerification } = vi.hoisted(() => ({ mockApplyAiVerification: vi.fn() }));
vi.mock("../../matching/ai-verify.js", () => ({ applyAiVerification: mockApplyAiVerification }));

import { registerSource } from "../../sources/source.js";
import { closeDb, getDb, getGig } from "../../store/index.js";
import { runRadar } from "../runner.js";

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-runner-ai-verify-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  nextGigs = [];
  mockApplyAiVerification.mockReset();
  // Default: pass the heuristic result straight through unchanged, exactly
  // like the real function does when nothing has aiVerify on.
  mockApplyAiVerification.mockImplementation(async (_gig: Gig, matchedGroupIds: string[]) => ({
    matchedGroupIds,
    aiFlags: {},
  }));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(aiVerify: boolean): Config {
  return {
    profile: { name: "Test User", roles: [], skills: [], timezone: "UTC" },
    groups: [
      {
        id: "g1",
        label: "Group 1",
        needs: { engagementProfiles: [{ id: "any-hourly", label: "Any (hourly)", types: ["contract"], minRate: 0, highRate: 999_999, maxHours: 999, maxHoursAtHighRate: 999, rateUnit: "hour" }], freshStageOnly: false, remoteOnly: false },
        aiVerify,
      },
    ],
    sources: [{ id: "braintrust", enabled: true }],
  };
}

function makeGig(externalId: string): Gig {
  return { sourceId: "braintrust", externalId, title: "Fractional CTO", url: `https://example.test/${externalId}` };
}

describe("runRadar: applyAiVerification() wiring (ai-match-verification epic)", () => {
  it("calls applyAiVerification with the gig, the heuristic matchedGroupIds, a groupId->GroupConfig map, and the resolved credential", async () => {
    nextGigs = [makeGig("1")];
    const config = makeConfig(true);
    const credential = { kind: "api-key" as const, provider: "anthropic" as const, value: "fake-api-key" };

    await runRadar(config, { db }, { credential });

    expect(mockApplyAiVerification).toHaveBeenCalledTimes(1);
    const [gigArg, matchedGroupIdsArg, groupsByIdArg, credentialArg] = mockApplyAiVerification.mock.calls[0] as [
      Gig,
      string[],
      Map<string, unknown>,
      unknown,
    ];
    expect(gigArg.externalId).toBe("1");
    expect(matchedGroupIdsArg).toEqual(["g1"]);
    expect(groupsByIdArg.get("g1")).toEqual(config.groups[0]);
    expect(credentialArg).toEqual(credential);
  });

  it("persists the AI-narrowed matchedGroupIds and aiFlags, and excludes a fully-AI-rejected gig from MatchResult.pass/passed", async () => {
    nextGigs = [makeGig("1")];
    const rejection: AiVerifyResult = { confirmed: false, reason: "Not actually an engineering role." };
    mockApplyAiVerification.mockResolvedValueOnce({ matchedGroupIds: [], aiFlags: { g1: rejection } });

    const result = await runRadar(makeConfig(true), { db });

    expect(result.results[0]?.pass).toBe(false);
    expect(result.passed).toHaveLength(0);
    expect(result.results[0]?.gig.matchedGroupIds).toEqual([]);
    expect(result.results[0]?.gig.aiFlags).toEqual({ g1: rejection });

    const stored = getGig("braintrust:1", { db });
    expect(stored?.matchedGroupIds).toEqual([]);
    expect(stored?.aiFlags).toEqual({ g1: rejection });
  });

  it("keeps a gig the AI confirms in matchedGroupIds/passed, with the confirming aiFlags entry persisted", async () => {
    nextGigs = [makeGig("1")];
    const confirmation: AiVerifyResult = { confirmed: true, reason: "Genuinely a CTO-type role." };
    mockApplyAiVerification.mockResolvedValueOnce({ matchedGroupIds: ["g1"], aiFlags: { g1: confirmation } });

    const result = await runRadar(makeConfig(true), { db });

    expect(result.passed).toHaveLength(1);
    expect(result.results[0]?.gig.matchedGroupIds).toEqual(["g1"]);

    const stored = getGig("braintrust:1", { db });
    expect(stored?.aiFlags).toEqual({ g1: confirmation });
  });

  it("never sets aiFlags on the persisted gig when applyAiVerification returns an empty aiFlags object (no group actually ran a check)", async () => {
    nextGigs = [makeGig("1")];

    await runRadar(makeConfig(false), { db }); // aiVerify off -- the default mock returns {} aiFlags

    const stored = getGig("braintrust:1", { db });
    expect(stored?.aiFlags).toBeUndefined();
  });
});
