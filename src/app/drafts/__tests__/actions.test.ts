import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same next/cache mock as src/app/__tests__/actions.test.ts — revalidatePath()
// asserts a real Next.js request context that doesn't exist under vitest.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import { closeDb, getDraft, getGig, recordScan, saveDraft } from "@/lib/store";
import { markSubmittedAction, setDraftStatusAction, updateDraftContentAction } from "../actions";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-drafts-actions-test-"));
  process.env.GIGRADAR_DB_PATH = path.join(tmpDir, "gigs.db");
  vi.mocked(revalidatePath).mockClear();
});

afterEach(() => {
  closeDb();
  delete process.env.GIGRADAR_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Seeds a real gig (application_drafts' FK needs one) via the real recordScan(). */
function seedGig(key: { sourceId: string; externalId: string }): void {
  recordScan([
    {
      sourceId: key.sourceId,
      gigs: [{ sourceId: key.sourceId, externalId: key.externalId, title: "Fractional CTO", url: "https://example.test/1" }],
    },
  ]);
}

const GIG_KEY = "src-a:1";

describe("updateDraftContentAction (AC1, AC2)", () => {
  it("saves edited content back to application_drafts.content and returns {ok:true}", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });
    saveDraft(GIG_KEY, { coverText: "Original LLM output", answers: {} });

    const edited = { coverText: "My hand-edited version", answers: { "Why?": "Because I said so." } };
    const result = await updateDraftContentAction(GIG_KEY, edited);

    expect(result).toEqual({ ok: true, data: { gigKey: GIG_KEY } });
    // Queried fresh from the store, not the in-memory `edited` value —
    // proves the edit actually persisted, not the original LLM output.
    expect(getDraft(GIG_KEY)?.content).toEqual(edited);
    expect(revalidatePath).toHaveBeenCalledWith("/drafts");
  });

  it("returns {ok:false} for a gig with no draft, and touches nothing", async () => {
    const result = await updateDraftContentAction("no-such:gig", { coverText: "x", answers: {} });
    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses to edit a draft that is no longer in 'draft' status, and does not overwrite its content", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });
    saveDraft(GIG_KEY, { coverText: "Approved content", answers: {} });
    const { setDraftStatus } = await import("@/lib/store");
    setDraftStatus(GIG_KEY, "approved");

    const result = await updateDraftContentAction(GIG_KEY, { coverText: "Sneaky overwrite", answers: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("approved");
    expect(getDraft(GIG_KEY)?.content).toEqual({ coverText: "Approved content", answers: {} });
    expect(getDraft(GIG_KEY)?.status).toBe("approved");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setDraftStatusAction (AC1, AC3)", () => {
  it("approves a draft, revalidates /drafts", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });
    saveDraft(GIG_KEY, { coverText: "x", answers: {} });

    const result = await setDraftStatusAction(GIG_KEY, "approved");

    expect(result).toEqual({ ok: true, data: { gigKey: GIG_KEY, status: "approved" } });
    expect(getDraft(GIG_KEY)?.status).toBe("approved");
    expect(getDraft(GIG_KEY)?.approvedAt).not.toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith("/drafts");
  });

  it("rejects a draft without touching the linked gig's status", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });
    saveDraft(GIG_KEY, { coverText: "x", answers: {} });

    const result = await setDraftStatusAction(GIG_KEY, "rejected");

    expect(result).toEqual({ ok: true, data: { gigKey: GIG_KEY, status: "rejected" } });
    expect(getDraft(GIG_KEY)?.status).toBe("rejected");
    expect(getGig(GIG_KEY)?.status).toBe("new");
  });

  it("returns {ok:false} for an unknown gig key instead of throwing", async () => {
    const result = await setDraftStatusAction("no-such:gig", "approved");
    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("markSubmittedAction: atomic draft+gig status sync (AC4)", () => {
  it("sets BOTH the draft's status to 'submitted' AND the linked gig's status to 'applied', via the real atomic markDraftSubmitted()", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });
    saveDraft(GIG_KEY, { coverText: "x", answers: {} });

    const result = await markSubmittedAction(GIG_KEY);

    expect(result).toEqual({ ok: true, data: { gigKey: GIG_KEY } });
    expect(getDraft(GIG_KEY)?.status).toBe("submitted");
    expect(getDraft(GIG_KEY)?.submittedAt).not.toBeNull();
    expect(getGig(GIG_KEY)?.status).toBe("applied");
  });

  it("revalidates BOTH /drafts and / — so the main dashboard reflects the new gig status too", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });
    saveDraft(GIG_KEY, { coverText: "x", answers: {} });

    await markSubmittedAction(GIG_KEY);

    expect(revalidatePath).toHaveBeenCalledWith("/drafts");
    expect(revalidatePath).toHaveBeenCalledWith("/");
  });

  it("returns {ok:false} for a gig with no draft, and leaves the gig's status untouched", async () => {
    seedGig({ sourceId: "src-a", externalId: "1" });

    const result = await markSubmittedAction(GIG_KEY);

    expect(result.ok).toBe(false);
    expect(getGig(GIG_KEY)?.status).toBe("new");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
