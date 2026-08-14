"use client";

import { useState, useTransition } from "react";
import type { StoredIssue } from "@/lib/notify/issues";
import { resolveIssueAction } from "./actions";

const SEVERITY_BADGE_CLASS: Record<StoredIssue["severity"], string> = {
  warning: "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-300",
  error: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-300",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function IssueRow({ issue, resolvable }: { issue: StoredIssue; resolvable: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleResolve() {
    setError(null);
    startTransition(async () => {
      const result = await resolveIssueAction(issue.id);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE_CLASS[issue.severity]}`}>
              {issue.severity}
            </span>
            <span className="font-medium text-slate-900">{issue.title}</span>
          </div>
          <p className="mt-1 text-sm text-slate-600">{issue.message}</p>
          <p className="mt-1 text-xs text-slate-400">
            {issue.source} — raised {formatDate(issue.raisedAt)}
            {issue.resolvedAt && ` — resolved ${formatDate(issue.resolvedAt)}`}
          </p>
        </div>
        {resolvable && (
          <button
            type="button"
            onClick={handleResolve}
            disabled={isPending}
            className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            {isPending ? "Resolving…" : "Resolve"}
          </button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function IssuesClient({ open, resolved }: { open: StoredIssue[]; resolved: StoredIssue[] }) {
  const [showResolved, setShowResolved] = useState(false);

  return (
    <div className="mt-4 flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {open.map((issue) => (
          <IssueRow key={issue.id} issue={issue} resolvable />
        ))}
      </div>

      {resolved.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="text-xs font-medium text-slate-500 hover:underline"
          >
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved issue{resolved.length === 1 ? "" : "s"}
          </button>
          {showResolved && (
            <div className="mt-3 flex flex-col gap-3">
              {resolved.map((issue) => (
                <IssueRow key={issue.id} issue={issue} resolvable={false} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
