"use client";

import { useState, useTransition } from "react";
import type { StoredIssue } from "@/lib/notify/issues";
import { checkCopilotReadinessAction, finishCopilotSessionAction, openCopilotSessionAction, resolveIssueAction } from "./actions";

const SEVERITY_BADGE_CLASS: Record<StoredIssue["severity"], string> = {
  warning: "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-300",
  error: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-300",
};

const VERIFICATION_ISSUE_TITLE = "Needs human verification";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** `issue.context` is `Record<string, unknown> | null` — narrow the two fields raiseIssue() sets for this issue title (scheduler/index.ts) before trusting them as strings. */
function verificationContext(issue: StoredIssue): { sourceId: string; blockedUrl: string } | null {
  if (issue.title !== VERIFICATION_ISSUE_TITLE) return null;
  const sourceId = issue.context?.sourceId;
  const blockedUrl = issue.context?.blockedUrl;
  if (typeof sourceId !== "string" || typeof blockedUrl !== "string") return null;
  return { sourceId, blockedUrl };
}

/**
 * "Open browser to help clear it" / "Check if it looks cleared" / "I'm
 * done" — the verification co-pilot flow, only rendered for an open issue
 * whose title/context match `verificationContext()`. Session state
 * (`sessionId`) lives in this component only — closing/navigating away
 * loses it, same as every other in-memory Playwright session this repo
 * already has (session-capture.ts's own Capture Login UI has the same
 * property). "I'm done" always closes the session AND resolves the issue
 * together (finishCopilotSessionAction does both server-side); this
 * component just reflects that back by clearing local session state.
 */
function VerificationCopilot({ issueId, sourceId, blockedUrl }: { issueId: string; sourceId: string; blockedUrl: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [readinessNote, setReadinessNote] = useState<string | null>(null);

  function handleOpen() {
    setError(null);
    startTransition(async () => {
      const result = await openCopilotSessionAction(sourceId, blockedUrl);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSessionId(result.data.sessionId);
    });
  }

  function handleCheck() {
    if (!sessionId) return;
    setError(null);
    setReadinessNote(null);
    startTransition(async () => {
      const result = await checkCopilotReadinessAction(sessionId, sourceId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReadinessNote(result.data.ready ? `Looks cleared: ${result.data.note}` : `Not yet: ${result.data.note}`);
    });
  }

  function handleFinish() {
    if (!sessionId) return;
    setError(null);
    startTransition(async () => {
      const result = await finishCopilotSessionAction(sessionId, issueId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSessionId(null);
      setReadinessNote(null);
    });
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md bg-slate-50 p-2">
      <div className="flex flex-wrap items-center gap-2">
        {!sessionId ? (
          <button
            type="button"
            onClick={handleOpen}
            disabled={isPending}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            {isPending ? "Opening…" : "Open browser to help clear it"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleCheck}
              disabled={isPending}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {isPending ? "Checking…" : "Check if it looks cleared"}
            </button>
            <button
              type="button"
              onClick={handleFinish}
              disabled={isPending}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {isPending ? "Finishing…" : "I'm done"}
            </button>
          </>
        )}
      </div>
      {readinessNote && <p className="text-xs text-slate-500">{readinessNote}</p>}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
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

  const verification = resolvable ? verificationContext(issue) : null;

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
      {verification && <VerificationCopilot issueId={issue.id} sourceId={verification.sourceId} blockedUrl={verification.blockedUrl} />}
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
