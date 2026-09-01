"use client";

// Row-by-row job detail browsing (product-review-followups epic,
// dashboard-redesign story, job-detail-row-browsing slice). Owner's own
// words: "we should be able to see and go through the jobs from row to row
// to see what we are getting into." A single flat table row is too
// cramped to actually read a JD in -- this is a slide-over that shows one
// gig in full, with Prev/Next stepping through whatever set of rows the
// dashboard's OWN table currently has active (the current pipeline tab +
// any manual filters/sort) -- dashboard-client.tsx passes that position
// down rather than this component re-deriving it, so there's exactly one
// place that owns filter/sort logic.
//
// statusChangeSection/draftSection/prepSection are rendered by the CALLER
// (dashboard-client.tsx's renderDraftSection()/renderPrepSection() and its
// inline status <select>) rather than reimplemented here -- same
// generatingKeys/prepByKey/etc. state as the table row for this exact gig,
// so acting on a gig from the panel can never drift out of sync with its
// row.
import { useEffect } from "react";
import type { ReactNode } from "react";
import type { StoredGig } from "@/lib/store";
import { formatDate, formatRate, OUTCOME_LABEL, STATUS_LABEL, TIER_BADGE_FALLBACK_STYLE, TIER_BADGE_STYLE } from "./dashboard-client";

export function GigDetailPanel({
  gig,
  position,
  onClose,
  onPrev,
  onNext,
  canPrev,
  canNext,
  statusChangeSection,
  draftSection,
  prepSection,
}: {
  gig: StoredGig;
  position: { index: number; total: number };
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  statusChangeSection: ReactNode;
  draftSection: ReactNode;
  prepSection: ReactNode;
}) {
  // Escape closes; Left/Right steps Prev/Next -- the natural "flip through
  // a stack of listings" keys, matching the owner's own "go through the
  // jobs from row to row" framing. Ignored while focus is in a text input
  // (the status <select> doesn't count -- arrow keys on a closed <select>
  // change its OWN value, not this listener's concern) so typing in the
  // prep-packet `<details>` area or anywhere else with a text field never
  // fights this.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isTextInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (isTextInput) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onPrev();
      else if (e.key === "ArrowRight") onNext();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, onPrev, onNext]);

  const tierStyle = gig.tier ? TIER_BADGE_STYLE[gig.tier] : TIER_BADGE_FALLBACK_STYLE;

  return (
    <div className="fixed inset-0 z-20 flex justify-end">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- backdrop dismiss; Escape (handled above) is the keyboard-equivalent path */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={gig.title}
        className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-theme-surface-border bg-theme-surface shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-theme-surface-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-current/30"
                style={tierStyle}
              >
                {gig.tier ?? "unrated"}
              </span>
              <span className="text-xs text-theme-text-dim">{gig.sourceId}</span>
              <span className="text-xs text-theme-text-dim">·</span>
              <span className="text-xs text-theme-text-dim">{STATUS_LABEL[gig.status]}</span>
            </div>
            <h2 className="mt-1 truncate text-lg font-bold tracking-tight text-theme-text">{gig.title}</h2>
            {gig.company && <p className="text-sm text-theme-text-dim">{gig.company}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md border border-theme-surface-border px-2 py-1 text-sm text-theme-text-dim hover:bg-theme-surface-raised"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-theme-surface-border bg-theme-surface-raised px-5 py-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onPrev}
              disabled={!canPrev}
              className="rounded-md border border-theme-surface-border px-2 py-1 text-xs font-medium text-theme-text hover:bg-theme-surface disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              type="button"
              onClick={onNext}
              disabled={!canNext}
              className="rounded-md border border-theme-surface-border px-2 py-1 text-xs font-medium text-theme-text hover:bg-theme-surface disabled:opacity-40"
            >
              Next →
            </button>
          </div>
          <span className="text-xs text-theme-text-dim">
            {position.total === 0 ? "—" : `${position.index + 1} of ${position.total} in this view`}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-xs font-medium text-theme-text-dim">Rate</dt>
              <dd className="text-theme-text">{formatRate(gig.rate)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-theme-text-dim">Weekly hours</dt>
              <dd className="text-theme-text">{gig.weeklyHours ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-theme-text-dim">Remote</dt>
              <dd className="text-theme-text">{gig.remote == null ? "—" : gig.remote ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-theme-text-dim">First seen</dt>
              <dd className="text-theme-text">{formatDate(gig.firstSeen)}</dd>
            </div>
          </dl>

          <a
            href={gig.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-4 inline-block text-sm font-medium text-theme-text underline underline-offset-2 hover:no-underline"
          >
            Open original listing ↗
          </a>

          {gig.description ? (
            <div className="mt-4 whitespace-pre-wrap rounded-md border border-theme-surface-border bg-theme-surface-raised/40 p-3 text-sm text-theme-text">
              {gig.description}
            </div>
          ) : (
            <p className="mt-4 text-sm text-theme-text-dim">No description captured for this listing -- see the original.</p>
          )}

          <div className="mt-5 flex flex-col gap-4 border-t border-theme-surface-border pt-4">
            <div>
              <p className="mb-1 text-xs font-medium text-theme-text-dim">Status</p>
              {statusChangeSection}
              {gig.outcomeReason && (
                <p className="mt-1 text-xs text-theme-text-dim">
                  {OUTCOME_LABEL[gig.outcomeReason]}
                  {gig.outcomeNote && <> — {gig.outcomeNote}</>}
                </p>
              )}
            </div>
            {draftSection && (
              <div>
                <p className="mb-1 text-xs font-medium text-theme-text-dim">Draft</p>
                {draftSection}
              </div>
            )}
            <div>
              <p className="mb-1 text-xs font-medium text-theme-text-dim">Prep</p>
              {prepSection}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
