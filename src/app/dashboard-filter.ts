// Pure client-side filtering logic for the dashboard, split out of
// dashboard-client.tsx so it's directly unit-testable without React
// Testing Library (not a dependency of this project). listGigs() has no
// pagination/filtering-by-tier support server-side, so the dashboard fetches
// the full set once and does all filtering (tier, status, text search) here
// over that in-memory array — see this story's spec and
// docs/ARCHITECTURE.md's design-decision note on that tradeoff.
import type { GigStatus, StoredGig } from "@/lib/store";
import type { Tier } from "@/lib/types";

export type TierFilter = Tier | "all";

export interface DashboardFilters {
  tier: TierFilter;
  /** Which statuses are currently checked (multi-select). */
  statuses: ReadonlySet<GigStatus>;
  /** Free-text search over company + title, case-insensitive substring match. */
  search: string;
  /** A specific Gig.sourceId, or "all" (the default -- every source passes). */
  source: string | "all";
}

/** Tier filter AND status filter AND source filter AND text search — all four combine as AND. */
export function filterGigs(gigs: readonly StoredGig[], filters: DashboardFilters): StoredGig[] {
  const term = filters.search.trim().toLowerCase();
  return gigs.filter((gig) => {
    if (filters.tier !== "all" && gig.tier !== filters.tier) return false;
    if (!filters.statuses.has(gig.status)) return false;
    if (filters.source !== "all" && gig.sourceId !== filters.source) return false;
    if (term) {
      const haystack = `${gig.title} ${gig.company ?? ""}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

/** The distinct sourceIds actually present in `gigs`, alphabetically sorted -- drives the Source filter dropdown's option list (never a hardcoded/registered-sources list, so it never offers a source with zero gigs). */
export function distinctSources(gigs: readonly StoredGig[]): string[] {
  return [...new Set(gigs.map((g) => g.sourceId))].sort((a, b) => a.localeCompare(b));
}
