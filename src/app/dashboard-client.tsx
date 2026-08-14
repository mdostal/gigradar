"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { GigStatus, StoredGig } from "@/lib/store";
import { generateDraftAction, updateGigStatusAction } from "./actions";
import { canGenerateDraft, draftButtonLabel } from "./dashboard-draft";
import { distinctSources, filterGigs, type TierFilter } from "./dashboard-filter";
import { sortGigs, type SortField, type SortState } from "./dashboard-sort";

const TIER_TABS: TierFilter[] = ["all", "green", "yellow", "red"];

const TIER_TAB_LABEL: Record<TierFilter, string> = {
  all: "All",
  green: "Green",
  yellow: "Yellow",
  red: "Red",
};

const ALL_STATUSES: GigStatus[] = ["new", "applied", "interview", "archived", "ignored"];

const STATUS_LABEL: Record<GigStatus, string> = {
  new: "New",
  applied: "Applied",
  interview: "Interview",
  archived: "Archived",
  ignored: "Ignored",
};

// Tailwind color-coding for the tier badge — green/yellow/red map onto the
// same GREEN/YELLOW/RED role-area classification described in
// src/lib/types.ts / docs/ARCHITECTURE.md. A gig with no tier yet (Gig.tier
// is optional) gets the neutral slate style, never a guessed color.
const TIER_BADGE_CLASS: Record<string, string> = {
  green: "bg-green-100 text-green-800 ring-1 ring-inset ring-green-300",
  yellow: "bg-yellow-100 text-yellow-800 ring-1 ring-inset ring-yellow-300",
  red: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-300",
};
const TIER_BADGE_FALLBACK = "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-300";

function formatRate(rate: StoredGig["rate"]): string {
  if (!rate) return "—";
  const { min, max, unit } = rate;
  if (min != null && max != null) return `$${min}–$${max}/${unit}`;
  if (min != null) return `$${min}+/${unit}`;
  if (max != null) return `up to $${max}/${unit}`;
  return `/${unit}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function tabClass(active: boolean): string {
  return [
    "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
    active
      ? "border-slate-900 bg-slate-900 text-white"
      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  ].join(" ");
}

/** Column header -> SortField for the 8 data-backed columns. "Change status"/"Draft" are actions, not data — deliberately absent, never sortable. */
const SORTABLE_COLUMNS: { label: string; field: SortField }[] = [
  { label: "Source", field: "source" },
  { label: "Title", field: "title" },
  { label: "Company", field: "company" },
  { label: "Tier", field: "tier" },
  { label: "Status", field: "status" },
  { label: "Rate", field: "rate" },
  { label: "Weekly hrs", field: "weeklyHours" },
  { label: "Seen", field: "firstSeen" },
];

/** A clickable column header: cycles asc -> desc -> asc on the same field, jumps straight to asc when switching fields. Shows a chevron only on the currently-active field. */
function SortableHeader({
  label,
  field,
  sort,
  onSort,
}: {
  label: string;
  field: SortField;
  sort: SortState | null;
  onSort: (field: SortField) => void;
}) {
  const active = sort?.field === field;
  return (
    <th className="sticky top-0 z-[1] isolate bg-slate-50 px-3 py-2 text-left font-semibold text-slate-600">
      <button
        type="button"
        onClick={() => onSort(field)}
        aria-sort={active ? (sort?.direction === "asc" ? "ascending" : "descending") : "none"}
        className="flex items-center gap-1 hover:text-slate-900"
      >
        {label}
        <span className="text-slate-400">{active ? (sort?.direction === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

/**
 * The interactive dashboard: tier tabs, status checkboxes, text search, and
 * the results table, all filtering client-side over the full `gigs` array
 * the Server Component parent fetched via listGigs() (see
 * src/app/dashboard-filter.ts for the pure filter logic and
 * src/app/page.tsx for the fetch). Status changes call updateGigStatusAction
 * (src/app/actions.ts), a Server Action that revalidates "/" on success so a
 * reload always reflects the latest state.
 *
 * `draftedGigKeys` (`draft-review-ui` story) — the set of gig keys that
 * already have a draft (any status), from `listDrafts()` (see
 * src/app/page.tsx) — only changes the "Generate draft"/"Regenerate draft"
 * button LABEL (dashboard-draft.ts's `draftButtonLabel()`), never whether
 * it's shown at all; that's tier-gated only (`canGenerateDraft()`).
 */
export function DashboardClient({
  gigs,
  draftedGigKeys = new Set(),
}: {
  gigs: StoredGig[];
  draftedGigKeys?: ReadonlySet<string>;
}) {
  const router = useRouter();
  const [tier, setTier] = useState<TierFilter>("all");
  const [statuses, setStatuses] = useState<ReadonlySet<GigStatus>>(new Set(ALL_STATUSES));
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<string | "all">("all");
  const [sort, setSort] = useState<SortState | null>(null);
  const [isPending, startTransition] = useTransition();
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
  const [, startDraftTransition] = useTransition();
  const [generatingKeys, setGeneratingKeys] = useState<ReadonlySet<string>>(new Set());
  const [draftErrorByKey, setDraftErrorByKey] = useState<Record<string, string>>({});

  const sources = useMemo(() => distinctSources(gigs), [gigs]);

  const filtered = useMemo(
    () => filterGigs(gigs, { tier, statuses, search, source }),
    [gigs, tier, statuses, search, source],
  );

  const sorted = useMemo(() => sortGigs(filtered, sort), [filtered, sort]);

  /** Clicking the currently-active column's header toggles asc/desc; clicking a different column jumps straight to asc on that column. */
  function handleSort(field: SortField) {
    setSort((prev) => {
      if (prev?.field === field) {
        return { field, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { field, direction: "asc" };
    });
  }

  function toggleStatus(status: GigStatus) {
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }

  function handleStatusChange(key: string, status: GigStatus) {
    setErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    startTransition(async () => {
      const result = await updateGigStatusAction(key, status);
      if (!result.ok) {
        setErrorByKey((prev) => ({ ...prev, [key]: result.error }));
      }
    });
  }

  /**
   * "Generate draft" click handler. Clears any prior error for this row,
   * marks it generating (disables just this row's button, not the whole
   * table), calls the Server Action, and on success navigates to `/drafts`
   * for review (per this story's acceptance criteria) — on failure, the
   * Server Action's own message (including stageApplication()'s specific
   * red-tier/missing-applyProfile errors) is shown inline under the button,
   * never a generic failure.
   */
  function handleGenerateDraft(key: string) {
    setDraftErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    setGeneratingKeys((prev) => new Set(prev).add(key));
    startDraftTransition(async () => {
      const result = await generateDraftAction(key);
      setGeneratingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (!result.ok) {
        setDraftErrorByKey((prev) => ({ ...prev, [key]: result.error }));
        return;
      }
      router.push("/drafts");
    });
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter by tier">
          {TIER_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tier === t}
              className={tabClass(tier === t)}
              onClick={() => setTier(t)}
            >
              {TIER_TAB_LABEL[t]}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-4" role="group" aria-label="Filter by status">
          {ALL_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={statuses.has(s)}
                onChange={() => toggleStatus(s)}
                className="h-4 w-4 rounded border-slate-300"
              />
              {STATUS_LABEL[s]}
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search company or title…"
            aria-label="Search company or title"
            className="w-full max-w-sm rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
          />
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            Source
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              aria-label="Filter by source"
              className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900"
            >
              <option value="all">All</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p className="text-sm text-slate-500">
        {filtered.length} of {gigs.length} gig{gigs.length === 1 ? "" : "s"}
      </p>

      {/*
        max-h-[70vh] + overflow-auto makes THIS div the sticky-positioning
        containing block for the <th> cells below (top-0 relative to its OWN
        scroll). Deliberately NOT the page's own scroll: this same div's
        `overflow-x-auto` (needed for horizontal scroll on narrow viewports)
        implicitly computes `overflow-y: auto` too per the CSS2.1 overflow
        computed-value coupling rule (setting one axis non-visible forces the
        other off "visible" as well) -- so it was ALREADY becoming a scroll
        container even before this fix, just with no bounded height, which is
        what broke a naive page-relative sticky attempt (confirmed live: the
        sticky element's containing block was this div, not the viewport, so
        it scrolled away with the page instead of pinning).
        Sticky is applied to each individual <th>, not <thead> -- position:sticky
        on thead/tr (display:table-header-group/table-row) is a known
        cross-browser inconsistency. Each sticky <th> also has `isolation:
        isolate` (Tailwind `isolate`) -- confirmed live to be the actual fix
        for a real bleed-through glitch (a scrolled-past row's text visible
        above the header): z-index alone did NOT reliably force a new
        stacking context for a sticky table cell in testing, isolation does.
      */}
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200 shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              {SORTABLE_COLUMNS.map(({ label, field }) => (
                <SortableHeader key={field} label={label} field={field} sort={sort} onSort={handleSort} />
              ))}
              <th className="sticky top-0 z-[1] isolate bg-slate-50 px-3 py-2 text-left font-semibold text-slate-600">
                Change status
              </th>
              <th className="sticky top-0 z-[1] isolate bg-slate-50 px-3 py-2 text-left font-semibold text-slate-600">
                Draft
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {sorted.map((gig) => (
              <tr key={gig.key} className="odd:bg-white even:bg-slate-50/60 hover:bg-slate-100">
                <td className="px-3 py-2 text-slate-600">{gig.sourceId}</td>
                <td className="px-3 py-2 font-medium text-slate-900">
                  <a
                    href={gig.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:underline"
                  >
                    {gig.title}
                  </a>
                </td>
                <td className="px-3 py-2 text-slate-600">{gig.company ?? "—"}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      gig.tier ? TIER_BADGE_CLASS[gig.tier] : TIER_BADGE_FALLBACK
                    }`}
                  >
                    {gig.tier ?? "unrated"}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-600">{STATUS_LABEL[gig.status]}</td>
                <td className="px-3 py-2 text-slate-600">{formatRate(gig.rate)}</td>
                <td className="px-3 py-2 text-slate-600">{gig.weeklyHours ?? "—"}</td>
                <td className="px-3 py-2 text-slate-600">{formatDate(gig.firstSeen)}</td>
                <td className="px-3 py-2">
                  <select
                    value={gig.status}
                    disabled={isPending}
                    onChange={(e) => handleStatusChange(gig.key, e.target.value as GigStatus)}
                    aria-label={`Change status for ${gig.title}`}
                    className="rounded-md border border-slate-300 px-2 py-1 text-sm text-slate-900 disabled:opacity-50"
                  >
                    {ALL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                  {errorByKey[gig.key] && (
                    <p className="mt-1 max-w-[16rem] text-xs text-red-600">{errorByKey[gig.key]}</p>
                  )}
                </td>
                <td className="px-3 py-2">
                  {canGenerateDraft(gig.tier) && (
                    <>
                      <button
                        type="button"
                        disabled={generatingKeys.has(gig.key)}
                        onClick={() => handleGenerateDraft(gig.key)}
                        className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {generatingKeys.has(gig.key) ? "Generating…" : draftButtonLabel(draftedGigKeys.has(gig.key))}
                      </button>
                      {draftErrorByKey[gig.key] && (
                        <p className="mt-1 max-w-[16rem] text-xs text-red-600">{draftErrorByKey[gig.key]}</p>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-slate-400">
                  No gigs match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
