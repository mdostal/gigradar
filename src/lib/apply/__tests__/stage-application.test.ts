import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyProfileConfig, Config, DraftContent, Gig, MatchResult } from "../../types.js";

// generateDraft() is mocked entirely here -- stageApplication() is tested as
// its own unit (guardrail ordering + persistence), not re-testing
// generateDraft()'s own prompt-construction behavior (see draft.test.ts for
// that). This also lets the "guardrail fires before any LLM call" acceptance
// criteria be asserted directly: mockGenerateDraft.mock.calls.length === 0.
const { mockGenerateDraft } = vi.hoisted(() => ({ mockGenerateDraft: vi.fn() }));
vi.mock("../draft.js", () => ({ generateDraft: mockGenerateDraft }));

import { closeDb, getDb, getDraft } from "../../store/index.js";
import { stageApplication } from "../runner.js";

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-stage-application-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  mockGenerateDraft.mockReset();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const REAL_APPLY_PROFILE: ApplyProfileConfig = { email: "jane@example.com" };

function makeConfig(applyProfile?: ApplyProfileConfig): Config {
  return {
    profile: { name: "Jane Doe", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
    needs: {
      engagementProfiles: [
        {
          id: "any-hourly",
          label: "Any (hourly)",
          types: ["contract", "fractional", "contract-to-hire"],
          minRate: 0,
          highRate: 999_999,
          maxHours: 999,
          maxHoursAtHighRate: 999,
          rateUnit: "hour",
        },
        {
          id: "any-salaried",
          label: "Any (salaried)",
          types: ["full-time"],
          minRate: 0,
          highRate: 999_999_999,
          rateUnit: "year",
        },
      ],
      freshStageOnly: false,
      remoteOnly: false,
    },
    sources: [{ id: "braintrust", enabled: true }],
    applyProfile,
  };
}

function makeGig(overrides: Partial<Gig> & { sourceId: string; externalId: string }): Gig {
  return {
    title: "Fractional CTO",
    url: `https://example.test/${overrides.sourceId}/${overrides.externalId}`,
    ...overrides,
  };
}

function makeMatchResult(gig: Gig, tier: MatchResult["tier"]): MatchResult {
  return { gig, pass: true, reasons: [], score: 1, tier, matchedProfiles: [] };
}

/** Seeds a real gig row via the store (application_drafts' FK needs a real gigs row). */
function seedGig(gig: Gig): void {
  db.prepare(
    `INSERT INTO gigs (key, source_id, external_id, title, url, status, first_seen, last_seen)
     VALUES (:key, :source_id, :external_id, :title, :url, 'new', :now, :now)`,
  ).run({
    key: `${gig.sourceId}:${gig.externalId}`,
    source_id: gig.sourceId,
    external_id: gig.externalId,
    title: gig.title,
    url: gig.url,
    now: "2026-01-01T00:00:00.000Z",
  });
}

describe("stageApplication: red-tier guardrail (AC3)", () => {
  it("throws a specific error naming the tier restriction, before any LLM call", async () => {
    const gig = makeGig({ sourceId: "braintrust", externalId: "1" });
    seedGig(gig);
    const r = makeMatchResult(gig, "red");

    await expect(stageApplication(r, makeConfig(REAL_APPLY_PROFILE), "fake-api-key", { db })).rejects.toThrow(
      /tier is "red"/,
    );
    expect(mockGenerateDraft).not.toHaveBeenCalled();
    expect(getDraft(`${gig.sourceId}:${gig.externalId}`, { db })).toBeUndefined();
  });
});

describe("stageApplication: missing applyProfile guardrail (AC4)", () => {
  it("throws a specific error pointing at /config, before any LLM call", async () => {
    const gig = makeGig({ sourceId: "braintrust", externalId: "1" });
    seedGig(gig);
    const r = makeMatchResult(gig, "green");

    await expect(stageApplication(r, makeConfig(undefined), "fake-api-key", { db })).rejects.toThrow(/\/config/);
    expect(mockGenerateDraft).not.toHaveBeenCalled();
    expect(getDraft(`${gig.sourceId}:${gig.externalId}`, { db })).toBeUndefined();
  });
});

describe("stageApplication: tier restriction only blocks red, not green/yellow", () => {
  it.each(["green", "yellow", undefined] as const)("does not throw the tier error for tier=%s", async (tier) => {
    const gig = makeGig({ sourceId: "braintrust", externalId: "1" });
    seedGig(gig);
    const content: DraftContent = { coverText: "Hello", answers: {} };
    mockGenerateDraft.mockResolvedValueOnce(content);

    await expect(
      stageApplication(makeMatchResult(gig, tier), makeConfig(REAL_APPLY_PROFILE), "fake-api-key", { db }),
    ).resolves.toBeDefined();
  });
});

describe("stageApplication: successful draft generation and persistence (AC7)", () => {
  it("calls generateDraft() with the real gig/profile/applyProfile data and persists via saveDraft() with status 'draft'", async () => {
    const gig = makeGig({ sourceId: "braintrust", externalId: "1", company: "Acme" });
    seedGig(gig);
    const config = makeConfig(REAL_APPLY_PROFILE);
    const content: DraftContent = { coverText: "Dear Acme team...", answers: { "Why?": "Great fit." } };
    mockGenerateDraft.mockResolvedValueOnce(content);

    const result = await stageApplication(makeMatchResult(gig, "green"), config, "fake-api-key", { db });

    expect(mockGenerateDraft).toHaveBeenCalledWith(gig, config.profile, config.applyProfile, "fake-api-key");
    expect(result).toEqual({ gig, content, status: "draft" });

    const stored = getDraft(`${gig.sourceId}:${gig.externalId}`, { db });
    expect(stored?.status).toBe("draft");
    expect(stored?.content).toEqual(content);
  });
});
