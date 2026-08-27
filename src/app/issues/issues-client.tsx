"use client";

import { useState, useTransition } from "react";
import { cancelCaptureAction, checkCaptureReadinessAction, finishCaptureAction, startCaptureAction } from "@/app/config/actions";
import type { StoredIssue } from "@/lib/notify/issues";
import {
  checkCopilotReadinessAction,
  finishCopilotSessionAction,
  openCopilotSessionAction,
  resolveIssueAction,
  retrySourceAction,
} from "./actions";

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

/** Both titles scheduler/index.ts's runCycle() ever raises for a source erroring outright (as opposed to e.g. "Auto-fire submit failed", which also carries a context.sourceId but names a DRAFT problem, not a SOURCE problem — retrying the source wouldn't act on that). */
const SOURCE_DOWN_ISSUE_TITLES = new Set([VERIFICATION_ISSUE_TITLE, "Source fetch failed"]);

/**
 * source-status-features epic, inline-issue-actions story: for the two
 * "this source is down" issue titles, every scheduler-raised instance
 * carries `context.sourceId` (see scheduler/index.ts's `raiseIssue()` call
 * sites) — the same structured, non-fragile signal `resolveIssuesForSource()`
 * cross-references server-side, reused here client-side to decide whether
 * "Retry now" / "Capture login" can target a real source. Deliberately not a
 * keyword match on `issue.message`.
 */
function issueSourceId(issue: StoredIssue): string | null {
  if (!SOURCE_DOWN_ISSUE_TITLES.has(issue.title)) return null;
  const sourceId = issue.context?.sourceId;
  return typeof sourceId === "string" ? sourceId : null;
}

const actionButtonClass =
  "rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50";

/**
 * "Retry now" — re-runs just this one source's fetch immediately instead of
 * waiting for the next scheduled cycle, and reports the real outcome. A
 * success also resolves this source's open issues server-side
 * (retrySourceAction calls resolveIssuesForSource()), so the row disappears
 * from the open list via the same revalidatePath()-driven refresh
 * `resolveIssueAction` already relies on — no local "hide" bookkeeping here.
 */
function RetryNowButton({ sourceId }: { sourceId: string }) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: true; foundCount: number } | { ok: false; error: string } | null>(null);

  function handleRetry() {
    setResult(null);
    startTransition(async () => {
      const outcome = await retrySourceAction(sourceId);
      setResult(outcome.ok ? { ok: true, foundCount: outcome.data.foundCount } : { ok: false, error: outcome.error });
    });
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={handleRetry} disabled={isPending} className={actionButtonClass}>
        {isPending ? "Retrying…" : "Retry now"}
      </button>
      {result?.ok === true && (
        <p role="status" className="text-xs text-green-700">
          ✓ Succeeded — found {result.foundCount} gig{result.foundCount === 1 ? "" : "s"}. Issue resolved.
        </p>
      )}
      {result?.ok === false && (
        <p role="alert" className="text-xs text-red-700">
          Still failing: {result.error}
        </p>
      )}
    </div>
  );
}

/**
 * Lean, self-contained "Capture login" flow for an issue on a source whose
 * `SourceConfig.settings.customAuth`/registry entry needs a browser-session
 * login (see page.tsx's `captureEligibleSourceIds()`) — mirrors
 * config-client.tsx's own `CaptureLoginControl`, but intentionally NOT
 * shared with it: that component is wired to a draft-array row index and a
 * bank of `useState<Record<number, ...>>` maps this page has no equivalent
 * of. Reuses the exact same Server Actions (`startCaptureAction` etc.), same
 * "spawn a real headed browser, wait for the user, then finish/cancel"
 * mechanism, same as every other Capture Login entry point in this app.
 */
function CaptureLoginAction({ sourceId }: { sourceId: string }) {
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "waiting"; captureId: string }
    | { status: "success"; path: string }
    | { status: "success-portunus" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [readinessNote, setReadinessNote] = useState<string | null>(null);

  function handleStart() {
    startTransition(async () => {
      const result = await startCaptureAction(sourceId);
      setState(result.ok ? { status: "waiting", captureId: result.data.captureId } : { status: "error", message: result.error });
    });
  }

  function handleFinish() {
    if (state.status !== "waiting") return;
    const { captureId } = state;
    startTransition(async () => {
      const result = await finishCaptureAction(captureId, sourceId);
      if (!result.ok) {
        setState({ status: "error", message: result.error });
        return;
      }
      setState(result.data.backend === "local" ? { status: "success", path: result.data.path } : { status: "success-portunus" });
      setReadinessNote(null);
    });
  }

  function handleCancel() {
    if (state.status !== "waiting") return;
    const { captureId } = state;
    startTransition(async () => {
      await cancelCaptureAction(captureId);
      setState({ status: "idle" });
      setReadinessNote(null);
    });
  }

  function handleCheckReadiness() {
    if (state.status !== "waiting") return;
    const { captureId } = state;
    setReadinessNote(null);
    startTransition(async () => {
      const result = await checkCaptureReadinessAction(captureId, sourceId);
      setReadinessNote(result.ok ? (result.data.ready ? `✓ ${result.data.note}` : `Not yet: ${result.data.note}`) : result.error);
    });
  }

  if (state.status === "waiting") {
    return (
      <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p>A browser window opened — log in to {sourceId}, then click &ldquo;I&rsquo;m done&rdquo;.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={handleFinish} disabled={isPending} className={actionButtonClass}>
            {isPending ? "Finishing…" : "I'm done"}
          </button>
          <button type="button" onClick={handleCancel} disabled={isPending} className={actionButtonClass}>
            {isPending ? "Cancelling…" : "Cancel"}
          </button>
          <button type="button" onClick={handleCheckReadiness} disabled={isPending} className={actionButtonClass}>
            {isPending ? "Checking…" : "Check if I'm ready"}
          </button>
        </div>
        {readinessNote && <p className="mt-2 text-xs">{readinessNote}</p>}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={handleStart} disabled={isPending} className={actionButtonClass}>
        {isPending ? "Opening browser…" : "Capture login"}
      </button>
      {state.status === "success" && <p className="text-xs text-green-700">Captured — saved to {state.path}.</p>}
      {state.status === "success-portunus" && <p className="text-xs text-green-700">Captured — stored in Portunus.</p>}
      {state.status === "error" && <p className="text-xs text-red-700">{state.message}</p>}
    </div>
  );
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
    <div className="mt-2 flex flex-col gap-2 rounded-md bg-theme-surface-raised p-2">
      <div className="flex flex-wrap items-center gap-2">
        {!sessionId ? (
          <button
            type="button"
            onClick={handleOpen}
            disabled={isPending}
            className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50"
          >
            {isPending ? "Opening…" : "Open browser to help clear it"}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleCheck}
              disabled={isPending}
              className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50"
            >
              {isPending ? "Checking…" : "Check if it looks cleared"}
            </button>
            <button
              type="button"
              onClick={handleFinish}
              disabled={isPending}
              className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50"
            >
              {isPending ? "Finishing…" : "I'm done"}
            </button>
          </>
        )}
      </div>
      {readinessNote && <p className="text-xs text-theme-text-dim">{readinessNote}</p>}
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}

function IssueRow({ issue, resolvable, captureEligibleSourceIds }: { issue: StoredIssue; resolvable: boolean; captureEligibleSourceIds: Set<string> }) {
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
  const sourceDownId = resolvable ? issueSourceId(issue) : null;

  return (
    <div className="rounded-md border border-theme-surface-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE_CLASS[issue.severity]}`}>
              {issue.severity}
            </span>
            <span className="font-medium text-theme-text">{issue.title}</span>
          </div>
          <p className="mt-1 text-sm text-theme-text-dim">{issue.message}</p>
          <p className="mt-1 text-xs text-theme-text-dim">
            {issue.source} — raised {formatDate(issue.raisedAt)}
            {issue.resolvedAt && ` — resolved ${formatDate(issue.resolvedAt)}`}
          </p>
        </div>
        {resolvable && (
          <button
            type="button"
            onClick={handleResolve}
            disabled={isPending}
            className="shrink-0 rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50"
          >
            {isPending ? "Resolving…" : "Resolve"}
          </button>
        )}
      </div>
      {verification && <VerificationCopilot issueId={issue.id} sourceId={verification.sourceId} blockedUrl={verification.blockedUrl} />}
      {sourceDownId && captureEligibleSourceIds.has(sourceDownId) && <CaptureLoginAction sourceId={sourceDownId} />}
      {sourceDownId && <RetryNowButton sourceId={sourceDownId} />}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}

export function IssuesClient({
  open,
  resolved,
  captureEligibleSourceIds,
}: {
  open: StoredIssue[];
  resolved: StoredIssue[];
  captureEligibleSourceIds: string[];
}) {
  const [showResolved, setShowResolved] = useState(false);
  const eligibleIds = new Set(captureEligibleSourceIds);

  return (
    <div className="mt-4 flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {open.map((issue) => (
          <IssueRow key={issue.id} issue={issue} resolvable captureEligibleSourceIds={eligibleIds} />
        ))}
      </div>

      {resolved.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="text-xs font-medium text-theme-text-dim hover:underline"
          >
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved issue{resolved.length === 1 ? "" : "s"}
          </button>
          {showResolved && (
            <div className="mt-3 flex flex-col gap-3">
              {resolved.map((issue) => (
                <IssueRow key={issue.id} issue={issue} resolvable={false} captureEligibleSourceIds={eligibleIds} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
