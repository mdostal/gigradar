"use client";

// product-review-followups epic, status-reconciliation-from-platforms
// story. Generalized from the original GoFractional-only button (owner's
// own words: "ALL of them should have their status sync setup as well") --
// one reusable button component, parameterized by source label + its own
// reconciliation Server Action, rather than a copy-pasted component per
// source. A single dashboard button per source rather than a scheduled/
// automatic sync -- matches this feature's own "manual OR automated,
// configurable" framing; an automation toggle is a natural follow-up once
// this is proven out across more sources.
import { useState } from "react";
import type { ActionResult } from "@/lib/actions/result";
import type { ReconciliationResult } from "@/lib/sources/gofractional-status";

export function SyncStatusButton({
  sourceLabel,
  action,
}: {
  /** e.g. "GoFractional", "Wellfound" -- used in the button's own label. */
  sourceLabel: string;
  action: () => Promise<ActionResult<ReconciliationResult>>;
}) {
  const [state, setState] = useState<
    { status: "idle" } | { status: "syncing" } | { status: "done"; result: ReconciliationResult } | { status: "error"; message: string }
  >({ status: "idle" });

  async function handleClick() {
    setState({ status: "syncing" });
    const result = await action();
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState({ status: "done", result: result.data });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={state.status === "syncing"}
        className="rounded-full border border-theme-surface-border bg-theme-surface px-3 py-1 text-sm text-theme-text-dim transition-colors hover:bg-theme-surface-raised disabled:opacity-50"
      >
        {state.status === "syncing" ? `Syncing ${sourceLabel}…` : `Sync ${sourceLabel} statuses`}
      </button>
      {state.status === "error" && <p className="text-xs text-red-600">{state.message}</p>}
      {state.status === "done" && (
        <p className="text-xs text-theme-text-dim">
          {state.result.updated.length} updated
          {state.result.alreadyCurrent.length > 0 && `, ${state.result.alreadyCurrent.length} already current`}
          {state.result.noMatch.length > 0 && `, ${state.result.noMatch.length} not tracked locally`}
          {state.result.ambiguous.length > 0 && `, ${state.result.ambiguous.length} ambiguous (skipped)`}
        </p>
      )}
    </div>
  );
}
