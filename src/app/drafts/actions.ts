"use server";

import { revalidatePath } from "next/cache";
import { getDraft, markDraftSubmitted, saveDraft, setDraftStatus } from "@/lib/store";
import type { DraftStatus } from "@/lib/store";
import type { DraftContent } from "@/lib/types";
import { actionErr, actionOk, type ActionResult } from "@/lib/actions/result";

/**
 * Server Actions for the `/drafts` review/approve UI (`draft-review-ui`
 * story, `assisted-apply-drafting` epic) — thin wrappers around
 * `store/drafts.ts`'s real functions, reusing the exact same
 * `ActionResult<T>` + `revalidatePath()` convention every other Server
 * Action in this app follows (see src/app/actions.ts and
 * src/app/config/actions.ts).
 */

/**
 * Saves an edited draft's content back to `application_drafts.content` via
 * `saveDraft()` — the same insert-or-replace function `stageApplication()`
 * itself uses for a fresh generation (see store/drafts.ts's doc comment).
 *
 * Deliberately restricted to drafts still in `'draft'` status: `saveDraft()`
 * ALWAYS resets `status` back to `'draft'` and clears `approved_at`/
 * `submitted_at` as part of its insert-or-replace contract (correct for a
 * genuine regeneration, but not what an "edit this draft's text" action on
 * an already-approved/submitted draft should silently do — that would
 * un-approve/un-submit it as a side effect of what looks like a text edit).
 * The review UI only ever renders the editable textarea while a draft is in
 * `'draft'` status (see drafts-client.tsx), but this check makes that
 * invariant real at the data layer too, not just a UI convention.
 */
export async function updateDraftContentAction(
  gigKey: string,
  content: DraftContent,
): Promise<ActionResult<{ gigKey: string }>> {
  const existing = getDraft(gigKey);
  if (!existing) {
    return actionErr(new Error(`gigradar drafts: no draft found for gig "${gigKey}".`));
  }
  if (existing.status !== "draft") {
    return actionErr(
      new Error(
        `gigradar drafts: cannot edit a draft with status "${existing.status}" — only a draft still in ` +
          `"draft" status is editable.`,
      ),
    );
  }

  try {
    saveDraft(gigKey, content);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/drafts");
  return actionOk({ gigKey });
}

/**
 * Approve/Reject — wraps `setDraftStatus()`. Deliberately typed to only
 * `"approved" | "rejected"`, narrower than the full `DraftStatus` union:
 * `"submitted"` has its own dedicated atomic action (`markSubmittedAction`
 * below) and `"draft"` is never a target a UI button transitions TO.
 * `setDraftStatus()` itself places no restriction on the ORIGINATING
 * status, so a rejected draft can still be approved after reconsideration.
 */
export async function setDraftStatusAction(
  gigKey: string,
  status: "approved" | "rejected",
): Promise<ActionResult<{ gigKey: string; status: DraftStatus }>> {
  try {
    setDraftStatus(gigKey, status);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/drafts");
  return actionOk({ gigKey, status });
}

/**
 * "Mark submitted" — wraps `markDraftSubmitted()`, the ONE atomic
 * transaction that flips both the draft (`'submitted'`) and the linked
 * gig's own status (`'applied'`) together (store/drafts.ts). Revalidates
 * BOTH `/drafts` (this page) AND `/` (the main dashboard, which renders
 * `gig.status`) — omitting the latter would let a reload of "/" keep
 * serving a stale pre-"applied" status from Next's Full Route Cache under a
 * production build, exactly the desync this story exists to prevent (see
 * src/app/actions.ts's `updateGigStatusAction` for the same discipline).
 */
export async function markSubmittedAction(gigKey: string): Promise<ActionResult<{ gigKey: string }>> {
  try {
    markDraftSubmitted(gigKey);
  } catch (e) {
    return actionErr(e);
  }
  revalidatePath("/drafts");
  revalidatePath("/");
  return actionOk({ gigKey });
}
