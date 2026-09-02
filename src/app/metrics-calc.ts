// gigradar-command-center epic, metrics-page story. Pure, directly-
// unit-testable rollup logic for /metrics -- split out of metrics-client.tsx
// for the same reason dashboard-filter.ts/dashboard-sort.ts's own logic is
// split out (no React Testing Library in this repo, see those files'
// header comments). Every function here takes already-fetched
// StoredGig[]/StoredDraft[] and a `nowMs` parameter where time matters
// (never reads Date.now() internally) -- deterministic and testable, same
// discipline dashboard-filter.ts's isWithinSeenWindow() already
// established.
import type { GigStatus, OutcomeReason, StoredDraft, StoredGig } from "@/lib/store";

export type MetricsDateRange = "7d" | "30d" | "90d" | "all";

export const METRICS_DATE_RANGE_OPTIONS: { value: MetricsDateRange; label: string; days: number | null }[] = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "all", label: "All time", days: null },
];

const DAY_MS = 86_400_000;

function rangeStartMs(range: MetricsDateRange, nowMs: number): number {
  const opt = METRICS_DATE_RANGE_OPTIONS.find((o) => o.value === range);
  return opt?.days == null ? -Infinity : nowMs - opt.days * DAY_MS;
}

/** Real, computed status breakdown -- same shape dashboard-client.tsx's own countByStatus already establishes, over whatever gig set the caller passes in (already date-filtered by the caller if a range is active). */
export function computeStatusCounts(gigs: readonly StoredGig[]): Record<GigStatus, number> {
  const counts: Record<GigStatus, number> = { new: 0, applied: 0, interview: 0, archived: 0, ignored: 0 };
  for (const g of gigs) counts[g.status]++;
  return counts;
}

/**
 * "Failed" (the owner's own word) broken down by its real, specific
 * reason -- rejected / withdrawn / missed-before-applying -- never
 * collapsed into one generic bucket. Only counts archived gigs that
 * actually carry an outcomeReason (an archived gig with none is a
 * deliberate "ignored"/manually-archived case, not a tracked outcome).
 */
export function computeOutcomeCounts(gigs: readonly StoredGig[]): Record<OutcomeReason, number> {
  const counts: Record<OutcomeReason, number> = { rejected: 0, withdrawn: 0, expired_unapplied: 0 };
  for (const g of gigs) {
    if (g.status === "archived" && g.outcomeReason) counts[g.outcomeReason]++;
  }
  return counts;
}

/** The real application-draft pipeline funnel -- draft/approved/rejected/submitted/submitting counts, over whatever draft set the caller passes in. */
export function computeDraftFunnel(drafts: readonly StoredDraft[]): Record<StoredDraft["status"], number> {
  const counts: Record<StoredDraft["status"], number> = { draft: 0, approved: 0, rejected: 0, submitted: 0, submitting: 0 };
  for (const d of drafts) counts[d.status]++;
  return counts;
}

export interface DayBucket {
  /** YYYY-MM-DD, local-date-agnostic (UTC calendar day of the ISO timestamp) -- consistent bucketing regardless of the machine's own timezone. */
  date: string;
  count: number;
}

function isoDateOnly(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Builds a dense (no missing days) array of {date, count} buckets for the trailing `days` days ending at `nowMs`'s own UTC calendar day -- a real run-rate graph needs zero-count days to show up as zero, not be silently absent. */
function denseDayBuckets(days: number, nowMs: number): DayBucket[] {
  const buckets: DayBucket[] = [];
  const endDate = new Date(nowMs);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(endDate.getTime() - i * DAY_MS);
    buckets.push({ date: d.toISOString().slice(0, 10), count: 0 });
  }
  return buckets;
}

/**
 * Real submissions per day, from application_drafts.submitted_at -- the
 * actual "daily run rate" the owner asked for (project-profile.yaml's own
 * founding north_star.success criterion: "a weekly metrics overview...
 * so any user can see their throughput"). `days` is always a real,
 * bounded window (defaults to 30) -- "all time" as a graph would grow
 * unbounded and unreadable, so the graph itself always shows a trailing
 * window regardless of the page's own selected date-range filter (the
 * COUNT tiles respect the full range; this graph's own x-axis does not).
 */
export function computeSubmissionsByDay(drafts: readonly StoredDraft[], days: number, nowMs: number): DayBucket[] {
  const buckets = denseDayBuckets(days, nowMs);
  const byDate = new Map(buckets.map((b) => [b.date, b]));
  for (const d of drafts) {
    if (!d.submittedAt) continue;
    const date = isoDateOnly(d.submittedAt);
    const bucket = date ? byDate.get(date) : undefined;
    if (bucket) bucket.count++;
  }
  return buckets;
}

/** Same shape as computeSubmissionsByDay(), for gigs.first_seen -- "how many new gigs is gigradar actually finding," the other half of a real throughput picture. */
export function computeDiscoveredByDay(gigs: readonly StoredGig[], days: number, nowMs: number): DayBucket[] {
  const buckets = denseDayBuckets(days, nowMs);
  const byDate = new Map(buckets.map((b) => [b.date, b]));
  for (const g of gigs) {
    const date = isoDateOnly(g.firstSeen);
    const bucket = date ? byDate.get(date) : undefined;
    if (bucket) bucket.count++;
  }
  return buckets;
}

/** Average real submissions/day over the trailing `days` days -- the single headline "run rate" number, derived from the SAME dense buckets computeSubmissionsByDay() builds (never a second, potentially-inconsistent computation). */
export function computeRunRate(drafts: readonly StoredDraft[], days: number, nowMs: number): number {
  const buckets = computeSubmissionsByDay(drafts, days, nowMs);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  return days > 0 ? total / days : 0;
}

/** Filters gigs to those first seen within `range` of `nowMs` -- "all" always matches, matching dashboard-filter.ts's isWithinSeenWindow()'s own "any" convention. */
export function filterGigsByRange(gigs: readonly StoredGig[], range: MetricsDateRange, nowMs: number): StoredGig[] {
  if (range === "all") return [...gigs];
  const start = rangeStartMs(range, nowMs);
  return gigs.filter((g) => new Date(g.firstSeen).getTime() >= start);
}

/** Same as filterGigsByRange() but for drafts, keyed on generatedAt (a draft's own "when did this happen" timestamp -- submittedAt is often null for non-submitted drafts, so filtering on it would silently drop the whole draft/approved/rejected funnel for any date range). */
export function filterDraftsByRange(drafts: readonly StoredDraft[], range: MetricsDateRange, nowMs: number): StoredDraft[] {
  if (range === "all") return [...drafts];
  const start = rangeStartMs(range, nowMs);
  return drafts.filter((d) => new Date(d.generatedAt).getTime() >= start);
}
