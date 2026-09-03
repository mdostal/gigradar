"use client";

// dashboard-drafts-data-integrity epic, dashboard-overview-page story. The
// real Dashboard at "/" -- owner's own verbatim spec (this epic's own
// docs/design-discussion.md §2): "make dashboard an overview with a small
// metric component and allow us to customize what shows... a small top 5
// for today or a checkmark if all of today is finished/covered... a view
// into all gigs and just some general metrics and charts ON all gigs...
// dashboard is a human readable dashboard that forwards you along."
//
// A glance page, not a data-dense one -- every section here ends in a link
// deeper (to /gigs or /metrics), never tries to replace either.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { StoredDraft, StoredGig } from "@/lib/store";
import { isWithinSeenWindow } from "./dashboard-filter";
import { computeDiscoveredByDay, computeRunRate } from "./metrics-calc";
import { BarChart } from "./metrics/metrics-client";
import {
  ALL_TILE_IDS,
  DASHBOARD_OVERVIEW_TILE_PREFS_KEY,
  DEFAULT_VISIBLE_TILES,
  deserializeVisibleTiles,
  serializeVisibleTiles,
  type TileId,
} from "./dashboard-overview-prefs";

const TILE_LABEL: Record<TileId, string> = {
  readyToAct: "Ready to act — green & new",
  newSignals: "New signals, all tiers",
  inPlay: "In play — applied & interview",
  trackedTotal: "Tracked total",
};

function computeTileValue(id: TileId, gigs: readonly StoredGig[]): number {
  switch (id) {
    case "readyToAct":
      return gigs.filter((g) => g.status === "new" && g.tier === "green").length;
    case "newSignals":
      return gigs.filter((g) => g.status === "new").length;
    case "inPlay":
      return gigs.filter((g) => g.status === "applied" || g.status === "interview").length;
    case "trackedTotal":
      return gigs.length;
  }
}

const METRICS_TEASER_WINDOW_DAYS = 14;
const RUN_RATE_WINDOW_DAYS = 30;

export function DashboardOverviewClient({
  gigs,
  drafts,
  now,
  gigsHref = "/gigs",
}: {
  gigs: StoredGig[];
  drafts: StoredDraft[];
  now: number;
  /** multi-group-architecture epic: the per-group Dashboard ([group]/page.tsx) passes `/${groupId}/gigs` — /today and /metrics have no group-scoped equivalent yet, so those two links always point at the unscoped route regardless of `gigsHref`. */
  gigsHref?: string;
}) {
  const [visibleTiles, setVisibleTiles] = useState<readonly TileId[]>(DEFAULT_VISIBLE_TILES);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Read-on-mount + write-on-change, same discipline dashboard-prefs.ts
  // already established for the giglist's own sorting/filter persistence.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DASHBOARD_OVERVIEW_TILE_PREFS_KEY);
      if (!raw) return;
      const tiles = deserializeVisibleTiles(raw);
      if (tiles) setVisibleTiles(tiles);
    } catch {
      // localStorage unavailable (private browsing, etc.) -- stay on defaults.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_OVERVIEW_TILE_PREFS_KEY, serializeVisibleTiles(visibleTiles));
    } catch {
      // Storage full/unavailable -- not persisting a preference is never fatal.
    }
  }, [visibleTiles]);

  function toggleTile(id: TileId) {
    setVisibleTiles((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  // "Today" -- newest signals still worth a look, matching /today's own
  // isWithinSeenWindow("24h") definition of "today" (dashboard-filter.ts)
  // rather than a second, potentially-inconsistent one.
  const todaysSignals = useMemo(
    () => gigs.filter((g) => g.status === "new" && g.tier !== "red" && isWithinSeenWindow(g.firstSeen, "24h", now)).sort((a, b) => new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime()),
    [gigs, now],
  );
  const topToday = todaysSignals.slice(0, 5);

  const discoveredByDay = useMemo(() => computeDiscoveredByDay(gigs, METRICS_TEASER_WINDOW_DAYS, now), [gigs, now]);
  const runRate = useMemo(() => computeRunRate(drafts, RUN_RATE_WINDOW_DAYS, now), [drafts, now]);

  return (
    <div className="mt-6 flex flex-col gap-6">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-theme-heading text-sm font-semibold uppercase tracking-wide text-theme-text-dim">At a glance</h2>
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="text-xs font-medium text-theme-text-dim hover:underline"
          >
            {pickerOpen ? "Done" : "Customize"}
          </button>
        </div>

        {pickerOpen && (
          <div className="mb-3 flex flex-wrap gap-3 rounded-md border border-theme-surface-border bg-theme-surface-raised p-3 text-sm">
            {ALL_TILE_IDS.map((id) => (
              <label key={id} className="flex items-center gap-1.5 text-theme-text">
                <input type="checkbox" checked={visibleTiles.includes(id)} onChange={() => toggleTile(id)} />
                {TILE_LABEL[id]}
              </label>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {ALL_TILE_IDS.filter((id) => visibleTiles.includes(id)).map((id) => (
            <div key={id} className="rounded-lg border border-theme-surface-border bg-theme-surface p-4">
              <div className="font-theme-mono text-2xl font-bold tabular-nums text-theme-text">{computeTileValue(id, gigs)}</div>
              <div className="mt-1 text-xs text-theme-text-dim">{TILE_LABEL[id]}</div>
            </div>
          ))}
          {visibleTiles.length === 0 && <p className="col-span-full text-sm text-theme-text-dim">No tiles shown — click "Customize" to add some back.</p>}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-theme-surface-border bg-theme-surface p-4">
          <h2 className="font-theme-heading text-sm font-semibold uppercase tracking-wide text-theme-text-dim">Today</h2>
          {topToday.length === 0 ? (
            <p className="mt-3 text-sm text-theme-text">✓ All caught up — no new green/yellow signals in the last 24h.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {topToday.map((g) => (
                <li key={g.key} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-theme-text">{g.title}</span>
                  <span className="flex-none font-theme-mono text-xs text-theme-text-dim">{g.company ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/today" className="mt-3 inline-block text-xs font-medium text-theme-accent hover:underline">
            See Today →
          </Link>
        </section>

        <section className="rounded-lg border border-theme-surface-border bg-theme-surface p-4">
          <h2 className="font-theme-heading text-sm font-semibold uppercase tracking-wide text-theme-text-dim">Metrics</h2>
          <p className="mt-1 font-theme-mono text-xs text-theme-text-dim">
            {runRate.toFixed(1)} submissions/day, trailing {RUN_RATE_WINDOW_DAYS}d
          </p>
          <div className="mt-2">
            <BarChart buckets={discoveredByDay} color="var(--color-theme-tier-green)" />
          </div>
          <Link href="/metrics" className="mt-2 inline-block text-xs font-medium text-theme-accent hover:underline">
            See full metrics →
          </Link>
        </section>
      </div>

      <Link
        href={gigsHref}
        className="self-start rounded-md border border-theme-surface-border bg-theme-surface px-4 py-2 text-sm font-medium text-theme-text transition-colors hover:bg-theme-surface-raised"
      >
        Go to All Gigs →
      </Link>
    </div>
  );
}
