// sync-status-dynamic-per-source story (config-rebuild-and-match-quality
// epic): the single source of truth for which sources have a real
// reconcile*Statuses() adapter — confirmed via code search, only 2 of ~13
// sources (GoFractional, Wellfound) have one. Owner's own words: "sync
// statuses should be across all of them and then allowed for each one in
// a drop down or something -- as you sign up and add accounts, more
// should appear." Mirrors src/lib/sources/origins.ts's own KNOWN_SOURCES
// id->label registry pattern. NOT a "use server" file — a plain module
// holding references to the real Server Actions (already-exported,
// already-transformed by Next.js) so both the sync-status UI and any
// future consumer read from this ONE list instead of hardcoded JSX.
// Adding a third real reconcile adapter (its own, separate, already-
// flagged follow-on epic) means adding ONE entry here — zero UI changes.
import { reconcileGoFractionalStatusesAction, reconcileWellfoundStatusesAction } from "./actions";
import type { ActionResult } from "@/lib/actions/result";
import type { ReconciliationResult } from "@/lib/sources/gofractional-status";

export interface SyncStatusSource {
  id: string;
  label: string;
  action: () => Promise<ActionResult<ReconciliationResult>>;
}

export const SYNC_STATUS_SOURCES: readonly SyncStatusSource[] = [
  { id: "gofractional", label: "GoFractional", action: reconcileGoFractionalStatusesAction },
  { id: "wellfound", label: "Wellfound", action: reconcileWellfoundStatusesAction },
];
