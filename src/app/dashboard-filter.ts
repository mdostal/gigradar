// Pure, directly-unit-testable filter logic for the dashboard's per-column
// TanStack Table filters (dashboard-client.tsx) — split out the same way
// dashboard-sort.ts's compareByField() is, for the same reason (no React
// Testing Library dependency in this project). Most per-column filters
// (text substring, single-value equality, numeric threshold) are simple
// enough to live inline as column filterFns in dashboard-client.tsx; only
// the ones with real logic worth isolating live here.
import type { StoredGig } from "@/lib/store";
import type { Tier } from "@/lib/types";

export type TierFilter = Tier | "all";

/** The distinct sourceIds actually present in `gigs`, alphabetically sorted -- drives the Source column filter's option list (never a hardcoded/registered-sources list, so it never offers a source with zero gigs). */
export function distinctSources(gigs: readonly StoredGig[]): string[] {
  return [...new Set(gigs.map((g) => g.sourceId))].sort((a, b) => a.localeCompare(b));
}

export type SeenWindow = "any" | "24h" | "7d" | "30d";

export const SEEN_WINDOW_OPTIONS: { value: SeenWindow; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

/**
 * A short, table-cell-sized label derived from a user-authored
 * `EngagementProfile.label` (free text — this repo has no fixed "A/B/C"
 * naming convention, that's a particular owner's own scheme, not a core
 * assumption) — the leading token up to the first separator character.
 * "A — Fractional/Hourly ($150+)" -> "A"; a label with no separator is
 * used whole. The full label is always still available as a tooltip
 * (`title`) wherever this is rendered, so a plain-language label never
 * loses information, just table width.
 */
export function shortProfileLabel(label: string): string {
  const match = /^[^\s\-–—:]+/.exec(label.trim());
  return match ? match[0] : label.trim();
}

const SEEN_WINDOW_MS: Record<Exclude<SeenWindow, "any">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * `nowMs` is a parameter (not `Date.now()` read internally) so this stays a
 * pure, deterministically-testable function — dashboard-client.tsx's column
 * filterFn is the only real caller and passes the actual current time.
 * "any" always matches; an unparseable `firstSeenIso` never matches a
 * bounded window (never guessed as "recent").
 */
export function isWithinSeenWindow(firstSeenIso: string, window: SeenWindow, nowMs: number): boolean {
  if (window === "any") return true;
  const seenMs = new Date(firstSeenIso).getTime();
  if (Number.isNaN(seenMs)) return false;
  return nowMs - seenMs <= SEEN_WINDOW_MS[window];
}
