import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Gig } from "../../types.js";
import type { PrepPacketContent } from "../../apply/prep.js";
import { closeDb, getDb } from "../db.js";
import { recordScan } from "../gigs.js";
import { getInterviewPrep, listInterviewPrep, saveInterviewPrep } from "../prep.js";

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-prep-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
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

/** Inserts a real gig row via the REAL recordScan() (unmocked), so interview_prep's FK has a real row to reference. */
function seedGig(sourceId: string, externalId: string): string {
  recordScan([{ sourceId, gigs: [makeGig({ sourceId, externalId })] }], { db, now: "2026-01-01T00:00:00.000Z" });
  return `${sourceId}:${externalId}`;
}

const PACKET: PrepPacketContent = {
  score: 82,
  rationale: "Strong overlap.",
  topStrengths: ["Backend leadership"],
  keyGaps: ["No Kubernetes listed"],
  recommendation: "Pursue.",
  predictedQuestions: ["How have you scaled a team?"],
  starlaStories: ["S: ... T: ... A: ... R: ... L: ... A: ..."],
  atsScore: { keywordOverlapScore: 70, matchedKeywords: ["Backend"], missingKeywords: ["Kubernetes"], resumeTweaks: ["Add 'Kubernetes' to your skills."] },
};

describe("saveInterviewPrep / getInterviewPrep", () => {
  it("persists a new prep packet with the real generated content", () => {
    const gigKey = seedGig("src-a", "1");

    saveInterviewPrep(gigKey, PACKET, { db, now: "2026-01-02T00:00:00.000Z" });

    const stored = getInterviewPrep(gigKey, { db });
    expect(stored).toBeDefined();
    expect(stored?.gigKey).toBe(gigKey);
    expect(stored?.content).toEqual(PACKET);
    expect(stored?.generatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("getInterviewPrep returns undefined for a gig with no prep packet", () => {
    const gigKey = seedGig("src-a", "1");
    expect(getInterviewPrep(gigKey, { db })).toBeUndefined();
  });

  it("regenerating REPLACES the content wholesale, never appending/duplicating", () => {
    const gigKey = seedGig("src-a", "1");
    saveInterviewPrep(gigKey, PACKET, { db, now: "2026-01-01T00:00:00.000Z" });

    const regenerated: PrepPacketContent = { ...PACKET, score: 91, rationale: "Even stronger fit on a second look." };
    saveInterviewPrep(gigKey, regenerated, { db, now: "2026-01-03T00:00:00.000Z" });

    const stored = getInterviewPrep(gigKey, { db });
    expect(stored?.content).toEqual(regenerated);
    expect(stored?.generatedAt).toBe("2026-01-03T00:00:00.000Z");

    // Exactly one row for this gig -- not two.
    expect(listInterviewPrep({ db }).filter((p) => p.gigKey === gigKey)).toHaveLength(1);
  });
});

describe("interview_prep: gig_key foreign key is genuinely enforced", () => {
  it("fails an insert whose gig_key doesn't exist in gigs", () => {
    expect(() => saveInterviewPrep("does-not-exist:1", PACKET, { db })).toThrow();
  });
});

describe("listInterviewPrep", () => {
  it("lists every prep packet, newest-generated-first", () => {
    const key1 = seedGig("src-a", "1");
    const key2 = seedGig("src-a", "2");
    saveInterviewPrep(key1, PACKET, { db, now: "2026-01-01T00:00:00.000Z" });
    saveInterviewPrep(key2, PACKET, { db, now: "2026-01-02T00:00:00.000Z" });

    const all = listInterviewPrep({ db });
    expect(all.map((p) => p.gigKey)).toEqual([key2, key1]);
  });

  it("returns an empty list when nothing has been generated yet", () => {
    seedGig("src-a", "1");
    expect(listInterviewPrep({ db })).toEqual([]);
  });
});
