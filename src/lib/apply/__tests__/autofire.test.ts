import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config, Gig } from "../../types.js";
import { closeDb, getDb } from "../../store/db.js";
import { recordScan } from "../../store/gigs.js";
import { saveDraft, setDraftStatus } from "../../store/drafts.js";
import { approvedCount, findAutoFireRule, isGraduated } from "../autofire.js";

let tmpDir: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-autofire-test-"));
  db = getDb({ path: path.join(tmpDir, "gigs.db") });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeGig(overrides: Partial<Gig> & { sourceId: string; externalId: string }): Gig {
  return {
    title: "Fractional CTO",
    url: `https://example.test/${overrides.sourceId}/${overrides.externalId}`,
    ...overrides,
  };
}

/** Seeds one gig (with a real tier) and an approved draft for it. */
function seedApprovedDraft(sourceId: string, externalId: string, tier: Gig["tier"]): void {
  recordScan([{ sourceId, gigs: [makeGig({ sourceId, externalId, tier })] }], { db, now: "2026-01-01T00:00:00.000Z" });
  const gigKey = `${sourceId}:${externalId}`;
  saveDraft(gigKey, { coverText: "hi", answers: {} }, { db, now: "2026-01-01T00:00:00.000Z" });
  setDraftStatus(gigKey, "approved", { db, now: "2026-01-01T00:00:00.000Z" });
}

function seedDraftWithStatus(
  sourceId: string,
  externalId: string,
  tier: Gig["tier"],
  status: "draft" | "rejected" | "submitted",
): void {
  recordScan([{ sourceId, gigs: [makeGig({ sourceId, externalId, tier })] }], { db, now: "2026-01-01T00:00:00.000Z" });
  const gigKey = `${sourceId}:${externalId}`;
  saveDraft(gigKey, { coverText: "hi", answers: {} }, { db, now: "2026-01-01T00:00:00.000Z" });
  if (status !== "draft") setDraftStatus(gigKey, status, { db, now: "2026-01-01T00:00:00.000Z" });
}

const RULE_3: Config["autoFire"] = {
  rules: [{ sourceId: "src-a", tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }],
};

describe("approvedCount", () => {
  it("counts approved AND submitted drafts, never draft/rejected", () => {
    seedDraftWithStatus("src-a", "1", "green", "draft");
    seedDraftWithStatus("src-a", "2", "green", "rejected");
    seedApprovedDraft("src-a", "3", "green");
    seedDraftWithStatus("src-a", "4", "green", "submitted");

    expect(approvedCount("src-a", "green", { db })).toBe(2);
  });

  it("only counts drafts for the matching (sourceId, tier) pair", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "yellow"); // wrong tier
    seedApprovedDraft("src-b", "3", "green"); // wrong source

    expect(approvedCount("src-a", "green", { db })).toBe(1);
  });

  it("returns 0 when nothing has ever been approved for the pair", () => {
    expect(approvedCount("src-a", "green", { db })).toBe(0);
  });
});

describe("isGraduated — the owner's exact worked example (3-approval threshold)", () => {
  it("is false with 2 approvals when minApprovals is 3", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "green");

    const config = { autoFire: RULE_3 } as Config;
    expect(isGraduated("src-a", "green", config, { db })).toBe(false);
  });

  it("is true once the 3rd approval lands", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "green");
    seedApprovedDraft("src-a", "3", "green");

    const config = { autoFire: RULE_3 } as Config;
    expect(isGraduated("src-a", "green", config, { db })).toBe(true);
  });

  it("is false for a pair with no configured rule at all, no matter how many approvals exist", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "green");
    seedApprovedDraft("src-a", "3", "green");

    const config = { autoFire: { rules: [] } } as unknown as Config;
    expect(isGraduated("src-a", "green", config, { db })).toBe(false);
  });

  it("is false when config.autoFire is entirely unset", () => {
    seedApprovedDraft("src-a", "1", "green");
    seedApprovedDraft("src-a", "2", "green");
    seedApprovedDraft("src-a", "3", "green");

    const config = {} as Config;
    expect(isGraduated("src-a", "green", config, { db })).toBe(false);
  });
});

describe("findAutoFireRule", () => {
  it("finds the rule matching (sourceId, tier) exactly", () => {
    const config = { autoFire: RULE_3 } as Config;
    expect(findAutoFireRule("src-a", "green", config)).toEqual(RULE_3!.rules[0]);
  });

  it("returns undefined for a pair with no matching rule", () => {
    const config = { autoFire: RULE_3 } as Config;
    expect(findAutoFireRule("src-a", "yellow", config)).toBeUndefined();
    expect(findAutoFireRule("src-b", "green", config)).toBeUndefined();
  });
});
