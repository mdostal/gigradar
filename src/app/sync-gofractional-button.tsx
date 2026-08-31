"use client";

// product-review-followups epic, status-reconciliation-from-platforms
// story (first source: GoFractional). Owner's own words: "go through, the
// ones i've applied to, especially go fractional -- ones i was passed on,
// etc so we fully update statuses." A single dashboard button rather than
// a scheduled/automatic sync -- matches this feature's own "manual OR
// automated, configurable" framing from the original brain-dump; manual
// first, a Settings toggle for automating it is a natural, separate
// follow-up once this is proven out.
import { useState } from "react";
import { reconcileGoFractionalStatusesAction } from "./actions";
import type { ReconciliationResult } from "@/lib/sources/gofractional-status";

export function SyncGoFractionalButton() {
  const [state, setState] = useState<
    { status: "idle" } | { status: "syncing" } | { status: "done"; result: ReconciliationResult } | { status: "error"; message: string }
  >({ status: "idle" });

  async function handleClick() {
    setState({ status: "syncing" });
    const result = await reconcileGoFractionalStatusesAction();
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
        {state.status === "syncing" ? "Syncing GoFractional…" : "Sync GoFractional statuses"}
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
