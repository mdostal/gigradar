// product-review-followups epic, notifications-and-filter-persistence
// story: dashboard-client.tsx's `sorting`/`columnFilters` state used to be
// plain useState, reset to their hardcoded defaults on every reload or
// navigation -- confirmed absent by code reading (the owner's own words:
// "the preferences for sorting and filtering aren't in place"). This is
// per-viewer desktop-app preference state, not server state, so
// localStorage (not a backend change) is the right store.
//
// Pure, directly-unit-testable (de)serialization split out the same way
// dashboard-filter.ts/dashboard-sort.ts already are -- no React Testing
// Library dependency in this project (see dashboard-filter.ts's own header
// comment for why). dashboard-client.tsx is the only real caller, wiring
// these into a read-on-mount + write-on-change pair of useEffects.
import type { ColumnFiltersState, SortingState } from "@tanstack/react-table";

export const DASHBOARD_PREFS_STORAGE_KEY = "gigradar:dashboard-prefs:v1";

export interface DashboardPrefs {
  sorting: SortingState;
  columnFilters: ColumnFiltersState;
}

/**
 * TanStack's ColumnFiltersState allows any filter value shape per column --
 * this dashboard has exactly one column (`status`) whose filter value is a
 * `Set<GigStatus>` (see dashboard-client.tsx's "status-multi" filterKind).
 * `JSON.stringify`/`JSON.parse` don't round-trip a Set at all (it
 * serializes to `{}`), so every Set-valued filter is tagged with a small
 * `{__set: [...]}` marker on the way out and rehydrated back into a real
 * Set on the way in. Every other filter value (string/number/etc.) passes
 * through untouched.
 */
function serializeColumnFilters(filters: ColumnFiltersState): unknown[] {
  return filters.map((f) => ({
    id: f.id,
    value: f.value instanceof Set ? { __set: [...f.value] } : f.value,
  }));
}

function deserializeColumnFilters(raw: unknown): ColumnFiltersState | null {
  if (!Array.isArray(raw)) return null;
  const result: ColumnFiltersState = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || !("id" in entry) || typeof entry.id !== "string") return null;
    const rawValue = "value" in entry ? entry.value : undefined;
    const value =
      typeof rawValue === "object" && rawValue !== null && "__set" in rawValue && Array.isArray((rawValue as { __set: unknown }).__set)
        ? new Set((rawValue as { __set: unknown[] }).__set)
        : rawValue;
    result.push({ id: entry.id, value });
  }
  return result;
}

/** JSON-safe representation of `prefs`, ready for `localStorage.setItem()`. Never throws -- a value TanStack itself produced is always serializable by this function's own contract. */
export function serializeDashboardPrefs(prefs: DashboardPrefs): string {
  return JSON.stringify({ sorting: prefs.sorting, columnFilters: serializeColumnFilters(prefs.columnFilters) });
}

/**
 * Parses a previously-serialized string back into `DashboardPrefs`, or
 * `null` for anything that isn't a genuinely valid prior write (missing
 * key, malformed JSON, a shape from some future/incompatible version).
 * Never throws -- corrupted/foreign localStorage content should silently
 * fall back to the caller's own hardcoded defaults, not crash the
 * dashboard.
 */
export function deserializeDashboardPrefs(raw: string): DashboardPrefs | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { sorting, columnFilters } = parsed as Record<string, unknown>;
  if (!Array.isArray(sorting)) return null;
  const deserializedFilters = deserializeColumnFilters(columnFilters);
  if (!deserializedFilters) return null;
  return { sorting: sorting as SortingState, columnFilters: deserializedFilters };
}
