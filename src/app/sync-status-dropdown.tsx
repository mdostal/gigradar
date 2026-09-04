"use client";

// sync-status-dynamic-per-source story (config-rebuild-and-match-quality
// epic). Replaces the old hardcoded row of <SyncStatusButton>s (exactly 2,
// GoFractional/Wellfound) with a single "Sync statuses" dropdown listing
// EVERY entry in sync-status-registry.ts's SYNC_STATUS_SOURCES — owner's
// own words: "allowed for each one in a drop down or something -- as you
// sign up and add accounts, more should appear." Each item keeps its own
// independent sync state (idle/syncing/done/error), same result-summary
// shape SyncStatusButton already established -- this is a real UI
// generalization of that component, not a parallel, drifting copy.
import { useState } from "react";
import type { ActionResult } from "@/lib/actions/result";
import type { ReconciliationResult } from "@/lib/sources/gofractional-status";
import type { SyncStatusSource } from "./sync-status-registry";

type SourceSyncState = { status: "idle" } | { status: "syncing" } | { status: "done"; result: ReconciliationResult } | { status: "error"; message: string };

function summarize(result: ReconciliationResult): string {
  const parts = [`${result.updated.length} updated`];
  if (result.backfilled.length > 0) parts.push(`${result.backfilled.length} newly tracked`);
  if (result.alreadyCurrent.length > 0) parts.push(`${result.alreadyCurrent.length} already current`);
  if (result.noMatch.length > 0) parts.push(`${result.noMatch.length} not tracked locally`);
  if (result.ambiguous.length > 0) parts.push(`${result.ambiguous.length} ambiguous (skipped)`);
  return parts.join(", ");
}

export function SyncStatusDropdown({ sources }: { sources: readonly SyncStatusSource[] }) {
  const [open, setOpen] = useState(false);
  const [states, setStates] = useState<Record<string, SourceSyncState>>({});

  if (sources.length === 0) return null;

  async function handleSync(source: SyncStatusSource) {
    setStates((prev) => ({ ...prev, [source.id]: { status: "syncing" } }));
    const result: ActionResult<ReconciliationResult> = await source.action();
    setStates((prev) => ({
      ...prev,
      [source.id]: result.ok ? { status: "done", result: result.data } : { status: "error", message: result.error },
    }));
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded-full border border-theme-surface-border bg-theme-surface px-3 py-1 text-sm text-theme-text-dim transition-colors hover:bg-theme-surface-raised"
      >
        Sync statuses
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-md border border-theme-surface-border bg-theme-surface p-2 shadow-lg">
          {sources.map((source) => {
            const state = states[source.id] ?? { status: "idle" };
            return (
              <div key={source.id} className="flex flex-col gap-1 border-b border-theme-surface-border py-2 last:border-b-0">
                <button
                  type="button"
                  onClick={() => handleSync(source)}
                  disabled={state.status === "syncing"}
                  className="flex items-center justify-between text-sm text-theme-text hover:text-theme-accent disabled:opacity-50"
                >
                  <span>{source.label}</span>
                  <span className="font-theme-mono text-xs text-theme-text-dim">{state.status === "syncing" ? "Syncing…" : "Sync"}</span>
                </button>
                {state.status === "error" && <p className="text-xs text-red-600">{state.message}</p>}
                {state.status === "done" && <p className="text-xs text-theme-text-dim">{summarize(state.result)}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
