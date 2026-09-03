"use client";

import { useState, useTransition } from "react";
import type { DraftStatus } from "@/lib/store";
import type { DraftContent, DraftFormat } from "@/lib/types";
import { markSubmittedAction, setDraftStatusAction, updateDraftContentAction } from "./actions";
import { DRAFT_STATUS_TABS, filterDrafts, formatCopyReadyDraft, type DraftListItem, type DraftStatusFilter } from "./drafts-filter";
import { ContextualChatTrigger } from "../contextual-chat/contextual-chat-trigger";
import { formatRate, TIER_BADGE_FALLBACK_STYLE, TIER_BADGE_STYLE } from "../dashboard-client";
import { KNOWN_SOURCES } from "@/lib/sources/origins";

/** id -> display label, built once from the same registry the setup wizard/Capture Login already read from (status-strip.ts's own precedent) — never a second, hand-typed copy. Falls back to the raw id (upper-cased) for a source not in the registry (a hand-added custom-llm/gmail-digest source). */
const SOURCE_LABEL: ReadonlyMap<string, string> = new Map(KNOWN_SOURCES.map((s) => [s.id, s.label]));
function sourceLabel(sourceId: string): string {
  return SOURCE_LABEL.get(sourceId) ?? sourceId.toUpperCase();
}

const STATUS_TAB_LABEL: Record<DraftStatusFilter, string> = {
  all: "All",
  draft: "Draft",
  approved: "Approved",
  rejected: "Rejected",
  submitted: "Submitted",
  // Not in DRAFT_STATUS_TABS (drafts-filter.ts) -- 'submitting' is a brief,
  // internal-only in-flight state (graduated-auto-fire-trust epic), not a
  // tab a user picks. Still required here for Record<DraftStatusFilter,
  // string>'s exhaustiveness now that DraftStatus includes it.
  submitting: "Submitting…",
};

const STATUS_BADGE_CLASS: Record<DraftStatus, string> = {
  draft: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300",
  approved: "bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-300",
  rejected: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-300",
  submitted: "bg-green-100 text-green-800 ring-1 ring-inset ring-green-300",
  submitting: "bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-300",
};

// platform-aware-application-drafting epic: the field is still literally
// named `coverText` regardless of format (DraftContent.format's own doc
// comment in types.ts explains why — never renamed), so the review UI's
// job is just to relabel what's already there per the real platform's
// application UX, not restructure the layout.
const FORMAT_LABEL: Record<DraftFormat, string> = {
  "cover-letter": "Cover message",
  proposal: "Proposal",
  "why-fit": "Why you're a fit",
  "form-fields": "Statement (optional — this platform is mostly short-answer questions)",
};

function tabClass(active: boolean): string {
  return [
    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
    active
      ? "border-slate-900 bg-slate-900 text-white"
      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  ].join(" ");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * One draft's review card. Content is only ever editable while `status ===
 * "draft"` — matching updateDraftContentAction()'s own server-side
 * enforcement (src/app/drafts/actions.ts), not just a UI convention: once
 * approved/rejected/submitted, the content shown is read-only.
 *
 * The real gig URL + copy-ready draft + "Mark submitted" only appear once
 * `status` is `"approved"` (or, for reference, `"submitted"`) — per this
 * story's acceptance criteria ("once approved: the real gig URL ... and a
 * copy-ready draft both appear, and a 'Mark submitted' action becomes
 * available").
 */
function DraftCard({ item }: { item: DraftListItem }) {
  const [coverText, setCoverText] = useState(item.content.coverText);
  const [answers, setAnswers] = useState(item.content.answers);
  const [isSaving, startSaveTransition] = useTransition();
  const [isTransitioning, startStatusTransition] = useTransition();
  const [isSubmitting, startSubmitTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const format = item.content.format ?? "cover-letter";
  const editedContent: DraftContent = { coverText, answers, format };

  function handleSave() {
    setError(null);
    startSaveTransition(async () => {
      const result = await updateDraftContentAction(item.gigKey, editedContent);
      if (!result.ok) setError(result.error);
    });
  }

  function handleSetStatus(status: "approved" | "rejected") {
    setError(null);
    startStatusTransition(async () => {
      const result = await setDraftStatusAction(item.gigKey, status);
      if (!result.ok) setError(result.error);
    });
  }

  function handleMarkSubmitted() {
    setError(null);
    startSubmitTransition(async () => {
      const result = await markSubmittedAction(item.gigKey);
      if (!result.ok) setError(result.error);
    });
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatCopyReadyDraft(item.content));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("gigradar drafts: could not copy to clipboard — copy the text below manually.");
    }
  }

  const showApprovedView = item.status === "approved" || item.status === "submitted";

  return (
    <div className="group rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-slate-900">{item.gigTitle}</p>
          <p className="text-sm text-slate-500">{item.gigCompany ?? "—"}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <ContextualChatTrigger kind="draft" itemKey={item.gigKey} label={item.gigTitle} />
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[item.status]}`}
          >
            {item.status}
          </span>
        </div>
      </div>

      {/* drafts-gig-context-surfacing story: always visible, not gated
          behind approval status — the whole point is having this BEFORE
          deciding approve/reject on a handful of near-identical drafts. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <span
          className="inline-flex rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ring-current/30"
          style={item.gigTier ? TIER_BADGE_STYLE[item.gigTier] : TIER_BADGE_FALLBACK_STYLE}
        >
          {item.gigTier ?? "unrated"}
        </span>
        <span className="font-mono text-slate-500">{formatRate(item.gigRate)}</span>
        <span className="rounded border border-slate-200 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-500">
          {sourceLabel(item.gigSourceId)}
        </span>
      </div>

      <p className="mt-1 text-xs text-slate-400">
        Generated {formatDate(item.generatedAt)}
        {item.approvedAt && ` · Approved ${formatDate(item.approvedAt)}`}
        {item.submittedAt && ` · Submitted ${formatDate(item.submittedAt)}`}
      </p>

      {item.status === "draft" ? (
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            {FORMAT_LABEL[format]}
            <textarea
              value={coverText}
              onChange={(e) => setCoverText(e.target.value)}
              rows={8}
              aria-label={`${FORMAT_LABEL[format]} for ${item.gigTitle}`}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
            />
          </label>

          {Object.entries(answers).map(([question, answer]) => (
            <label key={question} className="flex flex-col gap-1 text-sm text-slate-700">
              {question}
              <textarea
                value={answer}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [question]: e.target.value }))}
                rows={3}
                aria-label={`Answer to "${question}" for ${item.gigTitle}`}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none"
              />
            </label>
          ))}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={handleSave}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={isTransitioning}
              onClick={() => handleSetStatus("approved")}
              className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-800 hover:bg-blue-100 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={isTransitioning}
              onClick={() => handleSetStatus("rejected")}
              className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <p className="whitespace-pre-wrap text-sm text-slate-700">{item.content.coverText}</p>
          {Object.entries(item.content.answers).map(([question, answer]) => (
            <div key={question} className="text-sm text-slate-700">
              <p className="font-medium text-slate-500">{question}</p>
              <p className="whitespace-pre-wrap">{answer}</p>
            </div>
          ))}

          {item.status === "rejected" && (
            <div>
              <button
                type="button"
                disabled={isTransitioning}
                onClick={() => handleSetStatus("approved")}
                className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-800 hover:bg-blue-100 disabled:opacity-50"
              >
                Approve anyway
              </button>
            </div>
          )}

          {showApprovedView && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <a
                href={item.gigUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm font-medium text-blue-700 hover:underline"
              >
                Open the real job listing ↗
              </a>

              <div className="mt-2">
                <p className="text-xs font-medium text-slate-500">Copy-ready draft</p>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-2 text-sm text-slate-900">
                  {formatCopyReadyDraft(item.content)}
                </pre>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="mt-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  {copied ? "Copied!" : "Copy to clipboard"}
                </button>
              </div>

              {item.status === "approved" && (
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={handleMarkSubmitted}
                  className="mt-3 rounded-md border border-green-300 bg-green-50 px-3 py-1.5 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
                >
                  {isSubmitting ? "Marking submitted…" : "Mark submitted"}
                </button>
              )}
              {item.status === "submitted" && (
                <p className="mt-3 text-sm font-medium text-green-800">Submitted — the gig is now marked "applied".</p>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

/** The /drafts page's interactive shell: status tabs + a list of DraftCards. */
export function DraftsClient({ items }: { items: DraftListItem[] }) {
  const [status, setStatus] = useState<DraftStatusFilter>("all");
  const filtered = filterDrafts(items, status);

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter by draft status">
        {DRAFT_STATUS_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={status === tab}
            className={tabClass(status === tab)}
            onClick={() => setStatus(tab)}
          >
            {STATUS_TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      <p className="text-sm text-slate-500">
        {filtered.length} of {items.length} draft{items.length === 1 ? "" : "s"}
      </p>

      <div className="flex flex-col gap-4">
        {filtered.map((item) => (
          <DraftCard key={item.gigKey} item={item} />
        ))}
        {filtered.length === 0 && <p className="text-center text-slate-400">No drafts match the current filter.</p>}
      </div>
    </div>
  );
}
