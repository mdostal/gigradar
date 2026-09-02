"use client";

// gigradar-command-center epic, metrics-page story. The founding
// north_star.success criterion from this project's own scaffold, finally
// built: "a weekly metrics overview and deep-dive... so any user can see
// their throughput and improve toward finding their next role." Own
// dedicated layout (not theme-swappable like Dashboard/Today are), but
// styled entirely with the shared theme-* tokens so it still tints
// correctly under whichever theme is active (gigradar-command-center's
// design-discussion.md §2 "Resolved" item 3).
import { useMemo, useState } from "react";
import type { StoredDraft, StoredGig } from "@/lib/store";
import {
  computeDiscoveredByDay,
  computeDraftFunnel,
  computeOutcomeCounts,
  computeRunRate,
  computeStatusCounts,
  computeSubmissionsByDay,
  filterDraftsByRange,
  filterGigsByRange,
  METRICS_DATE_RANGE_OPTIONS,
  type DayBucket,
  type MetricsDateRange,
} from "../metrics-calc";

const OUTCOME_LABEL: Record<string, string> = {
  rejected: "Rejected",
  withdrawn: "Withdrawn/closed",
  expired_unapplied: "Missed — closed before applying",
};

const DRAFT_STATUS_LABEL: Record<StoredDraft["status"], string> = {
  draft: "Drafted",
  approved: "Approved",
  rejected: "Rejected (draft)",
  submitted: "Submitted",
  submitting: "Submitting…",
};

const GRAPH_WINDOW_DAYS = 30;

function Tile({ value, label, hint }: { value: number | string; label: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-theme-surface-border bg-theme-surface p-4">
      <span className="font-theme-mono text-2xl font-semibold text-theme-text">{value}</span>
      <span className="text-xs font-medium text-theme-text">{label}</span>
      {hint && <span className="text-[11px] text-theme-text-faint">{hint}</span>}
    </div>
  );
}

/** A minimal, hand-rolled SVG bar chart -- no charting library dependency for one chart type on one page (see metrics-page.yaml's own acceptance criteria discussion). Bars read from real DayBucket[] data; a zero-count day still renders a visible baseline tick, never silently skipped. */
function BarChart({ buckets, color }: { buckets: DayBucket[]; color: string }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const width = 640;
  const height = 120;
  const barGap = 2;
  const barWidth = buckets.length > 0 ? width / buckets.length - barGap : 0;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Bar chart">
      {buckets.map((b, i) => {
        const barHeight = Math.max(1, (b.count / max) * (height - 16));
        const x = i * (barWidth + barGap);
        const y = height - barHeight;
        return (
          <g key={b.date}>
            <rect x={x} y={y} width={barWidth} height={barHeight} fill={color} rx="1">
              <title>{`${b.date}: ${b.count}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

export function MetricsClient({ gigs, drafts, now }: { gigs: StoredGig[]; drafts: StoredDraft[]; now: number }) {
  const [range, setRange] = useState<MetricsDateRange>("30d");

  const rangedGigs = useMemo(() => filterGigsByRange(gigs, range, now), [gigs, range, now]);
  const rangedDrafts = useMemo(() => filterDraftsByRange(drafts, range, now), [drafts, range, now]);

  const statusCounts = useMemo(() => computeStatusCounts(rangedGigs), [rangedGigs]);
  const outcomeCounts = useMemo(() => computeOutcomeCounts(rangedGigs), [rangedGigs]);
  const draftFunnel = useMemo(() => computeDraftFunnel(rangedDrafts), [rangedDrafts]);
  const runRatePerDay = useMemo(() => computeRunRate(drafts, GRAPH_WINDOW_DAYS, now), [drafts, now]);
  const submissionsByDay = useMemo(() => computeSubmissionsByDay(drafts, GRAPH_WINDOW_DAYS, now), [drafts, now]);
  const discoveredByDay = useMemo(() => computeDiscoveredByDay(gigs, GRAPH_WINDOW_DAYS, now), [gigs, now]);

  const totalFailed = outcomeCounts.rejected + outcomeCounts.withdrawn + outcomeCounts.expired_unapplied;

  return (
    <main className="mx-auto max-w-[88rem] p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-theme-heading text-2xl font-bold tracking-tight text-theme-text">Metrics</h1>
        <div className="flex gap-1" role="tablist" aria-label="Date range">
          {METRICS_DATE_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={range === opt.value}
              onClick={() => setRange(opt.value)}
              className={[
                "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                range === opt.value
                  ? "bg-theme-accent text-theme-accent-ink"
                  : "border border-theme-surface-border bg-theme-surface text-theme-text-dim hover:bg-theme-surface-raised",
              ].join(" ")}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-sm text-theme-text-dim">Every number below reflects the selected range, except the two throughput graphs, which always show the trailing {GRAPH_WINDOW_DAYS} days.</p>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Tile value={rangedGigs.length} label="Tracked" hint="In range" />
        <Tile value={statusCounts.applied} label="Applied" />
        <Tile value={statusCounts.interview} label="Interviewing" />
        <Tile value={totalFailed} label="Failed" hint="Rejected + withdrawn + missed" />
        <Tile value={runRatePerDay.toFixed(1)} label="Run rate" hint={`Submissions/day, last ${GRAPH_WINDOW_DAYS}d`} />
      </section>

      <section className="mt-8">
        <h2 className="font-theme-heading text-lg font-semibold text-theme-text">How you're failing (specifically)</h2>
        <p className="text-sm text-theme-text-dim">Never one generic bucket — the real reason, every time.</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(Object.keys(outcomeCounts) as (keyof typeof outcomeCounts)[]).map((reason) => (
            <Tile key={reason} value={outcomeCounts[reason]} label={OUTCOME_LABEL[reason] ?? reason} />
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-theme-heading text-lg font-semibold text-theme-text">Draft pipeline</h2>
        <p className="text-sm text-theme-text-dim">Every drafted application, by its real current status.</p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {(Object.keys(draftFunnel) as (keyof typeof draftFunnel)[]).map((status) => (
            <Tile key={status} value={draftFunnel[status]} label={DRAFT_STATUS_LABEL[status]} />
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-theme-heading text-lg font-semibold text-theme-text">Submissions, last {GRAPH_WINDOW_DAYS} days</h2>
        <p className="text-sm text-theme-text-dim">Real applications sent, per day — the actual daily run rate.</p>
        <div className="mt-3 rounded-lg border border-theme-surface-border bg-theme-surface p-4">
          <BarChart buckets={submissionsByDay} color="var(--color-theme-accent)" />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="font-theme-heading text-lg font-semibold text-theme-text">New gigs discovered, last {GRAPH_WINDOW_DAYS} days</h2>
        <p className="text-sm text-theme-text-dim">How much is actually coming in, day to day.</p>
        <div className="mt-3 rounded-lg border border-theme-surface-border bg-theme-surface p-4">
          <BarChart buckets={discoveredByDay} color="var(--color-theme-tier-green)" />
        </div>
      </section>
    </main>
  );
}
