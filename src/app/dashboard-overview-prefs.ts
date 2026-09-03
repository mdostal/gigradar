// dashboard-drafts-data-integrity epic, dashboard-overview-page story.
// Which of the Dashboard's small glance tiles the owner wants to see --
// "allow us to customize what shows" (owner's own words). Per-viewer
// desktop-app preference, not server state, so localStorage is the right
// store -- same discipline dashboard-prefs.ts already established for
// sorting/filter persistence (own storage key, own pure (de)serialize
// pair, no React Testing Library dependency to test against).
export const DASHBOARD_OVERVIEW_TILE_PREFS_KEY = "gigradar:dashboard-overview-tiles:v1";

/** The tile library. Adding a new tile type: add its id here + a case in dashboard-overview-client.tsx's TILE_LIBRARY — nowhere else. */
export type TileId = "readyToAct" | "newSignals" | "inPlay" | "trackedTotal";

export const ALL_TILE_IDS: readonly TileId[] = ["readyToAct", "newSignals", "inPlay", "trackedTotal"];

/** Every tile visible until the owner explicitly hides one — matches the recovered Signal Deck concept's own default 4-tile layout. */
export const DEFAULT_VISIBLE_TILES: readonly TileId[] = ALL_TILE_IDS;

function isTileId(value: unknown): value is TileId {
  return typeof value === "string" && (ALL_TILE_IDS as readonly string[]).includes(value);
}

/** JSON-safe representation, ready for `localStorage.setItem()`. */
export function serializeVisibleTiles(visible: readonly TileId[]): string {
  return JSON.stringify(visible);
}

/**
 * Parses a previously-serialized tile list back, or `null` for anything
 * that isn't a genuinely valid prior write (missing key, malformed JSON, a
 * foreign/future shape) -- never throws, callers fall back to
 * DEFAULT_VISIBLE_TILES on `null`, same convention dashboard-prefs.ts's
 * own deserializeDashboardPrefs() established. Unknown tile ids (a stale
 * localStorage value from a since-removed tile type) are silently
 * dropped, not treated as a parse failure.
 */
export function deserializeVisibleTiles(raw: string): TileId[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(isTileId);
}
