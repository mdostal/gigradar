import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftContent, Gig } from "../../types.js";

// markDraftSubmitted() must genuinely wrap BOTH the draft-status update and
// the linked gig's own status update in ONE transaction (see
// design-discussion.md §3 step 5's atomicity finding). To prove that for
// real -- not just by reading the source -- this file mocks gigs.ts's
// setStatus() (the SECOND of the two statements markDraftSubmitted() runs)
// to optionally throw, simulating a crash/failure BETWEEN the two updates,
// and asserts neither commits. Every other test in this file leaves the
// flag off and gets the REAL setStatus() behavior via `...actual`.
const { shouldThrowOnGigStatusUpdate } = vi.hoisted(() => ({ shouldThrowOnGigStatusUpdate: { value: false } }));

vi.mock("../gigs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gigs.js")>();
  return {
    ...actual,
    setStatus: (key: string, status: Parameters<typeof actual.setStatus>[1], opts?: { db?: DatabaseSync }) => {
      if (shouldThrowOnGigStatusUpdate.value) {
        throw new Error("simulated failure between the draft update and the gig update");
      }
      return actual.setStatus(key, status, opts);
    },
  };
});

import { closeDb, getDb } from "../db.js";
import { getGig, recordScan } from "../gigs.js";
import {
  getDraft,
  listAutoFireDecisions,
  listDrafts,
  markDraftSubmitted,
  recordAutoFireDecision,
  saveDraft,
  setDraftStatus,
} from "../drafts.js";

let tmpDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-drafts-test-"));
  dbPath = path.join(tmpDir, "gigs.db");
  db = getDb({ path: dbPath });
  shouldThrowOnGigStatusUpdate.value = false;
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

/** Inserts a real gig row via the REAL recordScan() (unmocked), so application_drafts' FK has a real row to reference. */
function seedGig(sourceId: string, externalId: string): string {
  recordScan([{ sourceId, gigs: [makeGig({ sourceId, externalId })] }], { db, now: "2026-01-01T00:00:00.000Z" });
  return `${sourceId}:${externalId}`;
}

const DRAFT_CONTENT: DraftContent = {
  coverText: "Dear hiring team, I'm excited to apply for this role...",
  answers: { "Why this role?": "Strong fit for my background." },
};

describe("saveDraft / getDraft", () => {
  it("persists a new draft with status 'draft' and the real generated content (AC7)", () => {
    const gigKey = seedGig("src-a", "1");

    saveDraft(gigKey, DRAFT_CONTENT, { db, now: "2026-01-02T00:00:00.000Z" });

    const stored = getDraft(gigKey, { db });
    expect(stored).toBeDefined();
    expect(stored?.gigKey).toBe(gigKey);
    expect(stored?.status).toBe("draft");
    expect(stored?.content).toEqual(DRAFT_CONTENT);
    expect(stored?.generatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(stored?.approvedAt).toBeNull();
    expect(stored?.submittedAt).toBeNull();
  });

  it("getDraft returns undefined for a gig with no draft", () => {
    const gigKey = seedGig("src-a", "1");
    expect(getDraft(gigKey, { db })).toBeUndefined();
  });

  it("regenerating a draft replaces content, resets status to 'draft', and clears approved_at/submitted_at", () => {
    const gigKey = seedGig("src-a", "1");
    saveDraft(gigKey, DRAFT_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    setDraftStatus(gigKey, "approved", { db, now: "2026-01-02T00:00:00.000Z" });
    expect(getDraft(gigKey, { db })?.approvedAt).toBe("2026-01-02T00:00:00.000Z");

    const regenerated: DraftContent = { coverText: "A brand-new draft.", answers: {} };
    saveDraft(gigKey, regenerated, { db, now: "2026-01-03T00:00:00.000Z" });

    const stored = getDraft(gigKey, { db });
    expect(stored?.content).toEqual(regenerated);
    expect(stored?.status).toBe("draft");
    expect(stored?.generatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(stored?.approvedAt).toBeNull();
    expect(stored?.submittedAt).toBeNull();
  });
});

describe("application_drafts: gig_key foreign key is genuinely enforced (AC9)", () => {
  it("fails an insert whose gig_key doesn't exist in gigs", () => {
    expect(() => saveDraft("does-not-exist:1", DRAFT_CONTENT, { db })).toThrow();
  });
});

describe("listDrafts", () => {
  it("lists every draft, newest-generated-first, optionally filtered by status", () => {
    const key1 = seedGig("src-a", "1");
    const key2 = seedGig("src-a", "2");
    saveDraft(key1, DRAFT_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });
    saveDraft(key2, DRAFT_CONTENT, { db, now: "2026-01-02T00:00:00.000Z" });
    setDraftStatus(key1, "approved", { db, now: "2026-01-03T00:00:00.000Z" });

    const all = listDrafts({}, { db });
    expect(all.map((d) => d.gigKey)).toEqual([key2, key1]); // newest-generated-first

    const approvedOnly = listDrafts({ status: "approved" }, { db });
    expect(approvedOnly.map((d) => d.gigKey)).toEqual([key1]);
  });
});

describe("setDraftStatus", () => {
  it("transitions status and stamps approved_at only on 'approved'", () => {
    const gigKey = seedGig("src-a", "1");
    saveDraft(gigKey, DRAFT_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });

    setDraftStatus(gigKey, "rejected", { db, now: "2026-01-02T00:00:00.000Z" });
    let stored = getDraft(gigKey, { db });
    expect(stored?.status).toBe("rejected");
    expect(stored?.approvedAt).toBeNull();

    setDraftStatus(gigKey, "approved", { db, now: "2026-01-03T00:00:00.000Z" });
    stored = getDraft(gigKey, { db });
    expect(stored?.status).toBe("approved");
    expect(stored?.approvedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("does NOT change the linked gig's own status (rejecting a draft isn't a claim about the gig)", () => {
    const gigKey = seedGig("src-a", "1");
    saveDraft(gigKey, DRAFT_CONTENT, { db });
    setDraftStatus(gigKey, "rejected", { db });
    expect(getGig(gigKey, { db })?.status).toBe("new");
  });

  it("throws for a gig_key with no draft", () => {
    expect(() => setDraftStatus("does-not-exist:1", "approved", { db })).toThrow(/no draft with gig_key/);
  });
});

describe("markDraftSubmitted: atomic transaction (AC8)", () => {
  it("on success, sets BOTH the draft's status to 'submitted' AND the linked gig's status to 'applied'", () => {
    const gigKey = seedGig("src-a", "1");
    saveDraft(gigKey, DRAFT_CONTENT, { db });

    markDraftSubmitted(gigKey, { db, now: "2026-01-05T00:00:00.000Z" });

    const draft = getDraft(gigKey, { db });
    expect(draft?.status).toBe("submitted");
    expect(draft?.submittedAt).toBe("2026-01-05T00:00:00.000Z");
    expect(getGig(gigKey, { db })?.status).toBe("applied");
  });

  it("a simulated failure between the two updates leaves NEITHER committed (real atomicity, not just documented)", () => {
    const gigKey = seedGig("src-a", "1");
    saveDraft(gigKey, DRAFT_CONTENT, { db, now: "2026-01-01T00:00:00.000Z" });

    shouldThrowOnGigStatusUpdate.value = true;
    expect(() => markDraftSubmitted(gigKey, { db, now: "2026-01-05T00:00:00.000Z" })).toThrow(
      /simulated failure between the draft update and the gig update/,
    );

    // The draft's own UPDATE ran first (inside the same transaction) but
    // must have been rolled back along with the gig update that failed
    // after it -- neither half of the "both or neither" guarantee may commit.
    const draft = getDraft(gigKey, { db });
    expect(draft?.status).toBe("draft"); // NOT 'submitted' -- rolled back
    expect(draft?.submittedAt).toBeNull();
    expect(getGig(gigKey, { db })?.status).toBe("new"); // NOT 'applied'
  });

  it("throws (and applies nothing) when there is no draft for gig_key at all", () => {
    const gigKey = seedGig("src-a", "1");
    expect(() => markDraftSubmitted(gigKey, { db })).toThrow(/no draft with gig_key/);
    expect(getGig(gigKey, { db })?.status).toBe("new");
  });
});

describe("recordAutoFireDecision / listAutoFireDecisions", () => {
  const RULE = { sourceId: "src-a", tier: "green" as const, enabled: true, minApprovals: 3, dailyCap: 3 };

  it("persists a fired decision with its full rule snapshot", () => {
    const gigKey = seedGig("src-a", "1");

    recordAutoFireDecision(
      { gigKey, fired: true, reasons: ["graduated", "all checks passed"], ruleSnapshot: RULE },
      { db, now: "2026-01-01T00:00:00.000Z" },
    );

    const decisions = listAutoFireDecisions(gigKey, { db });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual({
      gigKey,
      decidedAt: "2026-01-01T00:00:00.000Z",
      fired: true,
      reasons: ["graduated", "all checks passed"],
      ruleSnapshot: RULE,
    });
  });

  it("persists a not-fired decision with reasons and a null rule snapshot (e.g. kill-switch stop)", () => {
    const gigKey = seedGig("src-a", "1");

    recordAutoFireDecision({ gigKey, fired: false, reasons: ["kill switch enabled"] }, { db, now: "2026-01-01T00:00:00.000Z" });

    const decisions = listAutoFireDecisions(gigKey, { db });
    expect(decisions[0]?.fired).toBe(false);
    expect(decisions[0]?.ruleSnapshot).toBeNull();
  });

  it("is append-only — multiple decisions for the same gig across cycles all survive, newest first", () => {
    const gigKey = seedGig("src-a", "1");

    recordAutoFireDecision({ gigKey, fired: false, reasons: ["not graduated yet"] }, { db, now: "2026-01-01T00:00:00.000Z" });
    recordAutoFireDecision({ gigKey, fired: false, reasons: ["not graduated yet"] }, { db, now: "2026-01-02T00:00:00.000Z" });
    recordAutoFireDecision({ gigKey, fired: true, reasons: ["graduated"], ruleSnapshot: RULE }, { db, now: "2026-01-03T00:00:00.000Z" });

    const decisions = listAutoFireDecisions(gigKey, { db });
    expect(decisions).toHaveLength(3);
    expect(decisions.map((d) => d.decidedAt)).toEqual(["2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
  });

  it("returns an empty list for a gig with no recorded decisions", () => {
    const gigKey = seedGig("src-a", "1");
    expect(listAutoFireDecisions(gigKey, { db })).toEqual([]);
  });
});
