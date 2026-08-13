// Pure "Generate draft" button logic for the dashboard, split out of
// dashboard-client.tsx for the same reason dashboard-filter.ts's filtering
// logic is split out — no React Testing Library in this repo, so anything
// worth asserting on its own needs to be plain, DOM-free logic (see that
// file's header comment).
//
// `draft-review-ui` story, `assisted-apply-drafting` epic: the dashboard
// must never show a "Generate draft" button for a tier='red' gig at all —
// matching `stageApplication()`'s own backend guardrail (apply/runner.ts)
// exactly, so the UI never offers an action the backend would immediately
// reject with a click-then-error round trip. Deliberately mirrors the
// backend's own condition (`r.tier === "red"` throws) rather than an
// allowlist of "green"/"yellow" — an untiered gig (`tier` undefined) is NOT
// blocked by stageApplication() either, so it must not be hidden here.
import type { Tier } from "@/lib/types";

/** True unless `tier` is exactly `"red"` — see this file's header comment. */
export function canGenerateDraft(tier: Tier | undefined): boolean {
  return tier !== "red";
}

/** "Generate draft" for a gig with no draft yet, "Regenerate draft" once one already exists (saveDraft() supports regeneration — see store/drafts.ts). */
export function draftButtonLabel(hasDraft: boolean): string {
  return hasDraft ? "Regenerate draft" : "Generate draft";
}
