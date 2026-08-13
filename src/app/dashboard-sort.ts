// Pure client-side sorting logic for the dashboard, split out of
// dashboard-client.tsx the same way dashboard-filter.ts is — directly
// unit-testable without React Testing Library (not a dependency of this
// project). Runs client-side over the already-filtered array; see
// dashboard-client.tsx for how sort state (field + direction) is wired to
// clickable column headers.
import type { StoredGig } from "@/lib/store";

export const SORT_FIELDS = [
  "source",
  "title",
  "company",
  "tier",
  "status",
  "rate",
  "weeklyHours",
  "firstSeen",
] as const;

export type SortField = (typeof SORT_FIELDS)[number];
export type SortDirection = "asc" | "desc";

export interface SortState {
  field: SortField;
  direction: SortDirection;
}

// Tier has no natural alphabetical order that matches its actual meaning
// (green is "best", not first alphabetically) — rank it green < yellow <
// red so ascending sort surfaces the best matches first, matching the tier
// tabs' own left-to-right order elsewhere in this UI. An untiered gig
// (Gig.tier is optional) sorts last in both directions — deliberately never
// mixed in among ranked tiers, same "never guess" spirit as
// dashboard-client.tsx's TIER_BADGE_FALLBACK.
const TIER_RANK: Record<string, number> = { green: 0, yellow: 1, red: 2 };
const UNTIERED_RANK = 3;

// ALL_STATUSES' own declared order (dashboard-client.tsx) — a lifecycle
// order (new -> applied -> interview -> archived/ignored), not alphabetical.
const STATUS_RANK: Record<string, number> = { new: 0, applied: 1, interview: 2, archived: 3, ignored: 4 };

/**
 * Missing values (null/undefined) always sort last, regardless of
 * direction — never silently interleaved as if they were zero/empty-string,
 * and never flipped to sort FIRST just because the direction is "desc"
 * (the direction sign only ever applies to the actual value comparison
 * below, not to missing-value placement).
 */
function compareNullable<T>(
  a: T | null | undefined,
  b: T | null | undefined,
  direction: SortDirection,
  compare: (a: T, b: T) => number,
): number {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const sign = direction === "asc" ? 1 : -1;
  return sign * compare(a, b);
}

function compareByField(field: SortField, direction: SortDirection, a: StoredGig, b: StoredGig): number {
  const sign = direction === "asc" ? 1 : -1;
  switch (field) {
    case "source":
      return sign * a.sourceId.localeCompare(b.sourceId);
    case "title":
      return sign * a.title.localeCompare(b.title);
    case "company":
      return compareNullable(a.company, b.company, direction, (x, y) => x.localeCompare(y));
    case "tier": {
      // Untiered gigs sort last regardless of direction -- same
      // direction-independent-missing-value invariant as compareNullable
      // below, just expressed via TIER_RANK's lookup miss instead of
      // null/undefined (Gig.tier is a plain optional string union, not
      // null-typed).
      const aUntiered = !(a.tier != null && a.tier in TIER_RANK);
      const bUntiered = !(b.tier != null && b.tier in TIER_RANK);
      if (aUntiered && bUntiered) return 0;
      if (aUntiered) return 1;
      if (bUntiered) return -1;
      return sign * ((TIER_RANK[a.tier as string] ?? UNTIERED_RANK) - (TIER_RANK[b.tier as string] ?? UNTIERED_RANK));
    }
    case "status":
      return (
        sign *
        ((STATUS_RANK[a.status] ?? Number.MAX_SAFE_INTEGER) - (STATUS_RANK[b.status] ?? Number.MAX_SAFE_INTEGER))
      );
    case "rate":
      // rate.min is the sortable anchor -- the same value formatRate() in
      // dashboard-client.tsx leads with. A gig with only rate.max set (no
      // min) is rare; it still sorts by min (missing -> last), not by max.
      return compareNullable(a.rate?.min, b.rate?.min, direction, (x, y) => x - y);
    case "weeklyHours":
      return compareNullable(a.weeklyHours, b.weeklyHours, direction, (x, y) => x - y);
    case "firstSeen":
      return sign * a.firstSeen.localeCompare(b.firstSeen); // ISO 8601 -- lexicographic order IS chronological order
    default:
      return 0;
  }
}

/**
 * Stable sort (Array.prototype.sort is spec-guaranteed stable since ES2019)
 * over `gigs` by `sort.field`/`sort.direction`. `sort === null` returns
 * `gigs` unchanged (a fresh copy, still — callers should not rely on
 * reference identity either way) -- the dashboard's default, pre-any-header-
 * click state.
 */
export function sortGigs(gigs: readonly StoredGig[], sort: SortState | null): StoredGig[] {
  if (!sort) return [...gigs];
  return [...gigs].sort((a, b) => compareByField(sort.field, sort.direction, a, b));
}
