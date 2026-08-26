"use client";

import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { GigStatus, StoredGig } from "@/lib/store";
import type { PrepPacketContent } from "@/lib/apply/prep";
import { generateDraftAction, generatePrepPacketAction, updateGigStatusAction } from "./actions";
import { canGenerateDraft, draftButtonLabel } from "./dashboard-draft";
import { distinctSources, isWithinSeenWindow, SEEN_WINDOW_OPTIONS, type SeenWindow } from "./dashboard-filter";
import { compareByField, type SortField } from "./dashboard-sort";

const ALL_STATUSES: GigStatus[] = ["new", "applied", "interview", "archived", "ignored"];

const STATUS_LABEL: Record<GigStatus, string> = {
  new: "New",
  applied: "Applied",
  interview: "Interview",
  archived: "Archived",
  ignored: "Ignored",
};

// Tier badge colors read from the theme-invariant CSS custom properties
// (globals.css root) rather than hardcoded Tailwind green/yellow/red
// utilities — ui-theme-system epic: tier color must read identically no
// matter which visual theme (radar/editorial/terminal) is active, so this
// maps to inline custom-property references, not per-theme classes. A gig
// with no tier yet (Gig.tier is optional) gets the neutral fallback, never
// a guessed color.
const TIER_BADGE_STYLE: Record<string, { color: string; background: string }> = {
  green: { color: "var(--tier-green)", background: "color-mix(in srgb, var(--tier-green) 16%, transparent)" },
  yellow: { color: "var(--tier-yellow)", background: "color-mix(in srgb, var(--tier-yellow) 16%, transparent)" },
  red: { color: "var(--tier-red)", background: "color-mix(in srgb, var(--tier-red) 16%, transparent)" },
};
const TIER_BADGE_FALLBACK_STYLE = { color: "var(--text-secondary, #64748b)", background: "var(--surface-bg-raised, #f1f5f9)" };

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

const filterInputClass =
  "w-full rounded border border-theme-surface-border px-1.5 py-1 text-xs text-theme-text placeholder:text-theme-text-dim focus:border-slate-500 focus:outline-none";

/**
 * Per-column filter control shape — driven by each ColumnDef's own `meta`
 * (module-augmented below), so the header-row renderer stays generic
 * instead of a giant switch keyed on column id.
 */
type FilterKind = "text" | "select" | "status-multi" | "number-min" | "number-max" | "seen-window" | "none";

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    filterKind: FilterKind;
    /** Only for filterKind: "select" — option VALUES, "All" is always prepended. */
    selectOptions?: string[];
  }
}

/** Renders the right filter control for one column, in the filter row under the sortable headers. Chips (status) vs. text/number/select inputs are visually distinct but share the same compact footprint. */
function ColumnFilterCell({
  filterKind,
  value,
  onChange,
  selectOptions,
  label,
}: {
  filterKind: FilterKind;
  value: unknown;
  onChange: (next: unknown) => void;
  selectOptions?: string[];
  label: string;
}) {
  if (filterKind === "none") return null;

  if (filterKind === "text") {
    return (
      <input
        type="text"
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder="Filter…"
        aria-label={`Filter by ${label}`}
        className={filterInputClass}
      />
    );
  }

  if (filterKind === "select") {
    return (
      <select
        value={(value as string) ?? "all"}
        onChange={(e) => onChange(e.target.value === "all" ? undefined : e.target.value)}
        aria-label={`Filter by ${label}`}
        className={filterInputClass}
      >
        <option value="all">All</option>
        {(selectOptions ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (filterKind === "seen-window") {
    return (
      <select
        value={(value as SeenWindow) ?? "any"}
        onChange={(e) => onChange(e.target.value === "any" ? undefined : e.target.value)}
        aria-label={`Filter by ${label}`}
        className={filterInputClass}
      >
        {SEEN_WINDOW_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }

  if (filterKind === "number-min" || filterKind === "number-max") {
    return (
      <input
        type="number"
        value={(value as number | undefined) ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        placeholder={filterKind === "number-min" ? "Min…" : "Max…"}
        aria-label={`Filter by ${label}`}
        className={filterInputClass}
      />
    );
  }

  if (filterKind === "status-multi") {
    const checked = (value as ReadonlySet<GigStatus>) ?? new Set(ALL_STATUSES);
    return (
      <div className="flex flex-wrap gap-1">
        {ALL_STATUSES.map((s) => {
          const active = checked.has(s);
          return (
            <button
              key={s}
              type="button"
              aria-pressed={active}
              onClick={() => {
                const next = new Set(checked);
                if (next.has(s)) next.delete(s);
                else next.add(s);
                onChange(next);
              }}
              className={[
                "rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                active ? "bg-slate-900 text-white" : "bg-slate-100 text-theme-text-dim hover:bg-slate-200",
              ].join(" ")}
            >
              {STATUS_LABEL[s]}
            </button>
          );
        })}
      </div>
    );
  }

  return null;
}

/** field -> ascending comparator, reusing dashboard-sort.ts's domain-aware compareByField (tier/status rank, nullable-last) instead of TanStack's generic default sort for these columns. TanStack negates automatically for desc — these only ever need to implement "asc". */
function sortingFnFor(field: SortField) {
  return (rowA: { original: StoredGig }, rowB: { original: StoredGig }) =>
    compareByField(field, "asc", rowA.original, rowB.original);
}

/**
 * The interactive dashboard: a TanStack Table with a sortable, per-column-
 * filterable results grid, all filtering/sorting client-side over the full
 * `gigs` array the Server Component parent fetched via listGigs() (see
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
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([
    { id: "status", value: new Set(ALL_STATUSES) },
  ]);
  const [isPending, startTransition] = useTransition();
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
  const [, startDraftTransition] = useTransition();
  const [generatingKeys, setGeneratingKeys] = useState<ReadonlySet<string>>(new Set());
  const [draftErrorByKey, setDraftErrorByKey] = useState<Record<string, string>>({});

  // "Generate prep packet" (career-crm epic, prep-packet-ui story) — own
  // state, own row-keyed maps, same convention as the draft-generation
  // state above. No canGenerateDraft()-style tier gate: a prep packet is
  // read-only analysis, not a real application artifact, so it's available
  // for every gig regardless of tier.
  const [, startPrepTransition] = useTransition();
  const [generatingPrepKeys, setGeneratingPrepKeys] = useState<ReadonlySet<string>>(new Set());
  const [prepErrorByKey, setPrepErrorByKey] = useState<Record<string, string>>({});
  const [prepByKey, setPrepByKey] = useState<Record<string, PrepPacketContent>>({});

  const sources = useMemo(() => distinctSources(gigs), [gigs]);

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

  /**
   * "Generate prep packet" click handler — same shape as
   * handleGenerateDraft() above, but stays on the dashboard (no
   * navigation) and displays the returned content inline once generated,
   * rather than routing to a review page.
   */
  function handleGeneratePrep(key: string) {
    setPrepErrorByKey((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
    setGeneratingPrepKeys((prev) => new Set(prev).add(key));
    startPrepTransition(async () => {
      const result = await generatePrepPacketAction(key);
      setGeneratingPrepKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (!result.ok) {
        setPrepErrorByKey((prev) => ({ ...prev, [key]: result.error }));
        return;
      }
      setPrepByKey((prev) => ({ ...prev, [key]: result.data }));
    });
  }

  const columns: ColumnDef<StoredGig>[] = [
    {
      id: "source",
      header: "Source",
      accessorFn: (g) => g.sourceId,
      cell: ({ row }) => row.original.sourceId,
      sortingFn: sortingFnFor("source"),
      filterFn: (row, _id, value) => !value || row.original.sourceId === value,
      meta: { filterKind: "select", selectOptions: sources },
    },
    {
      id: "title",
      header: "Title",
      accessorFn: (g) => g.title,
      cell: ({ row }) => (
        <a
          href={row.original.url}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-theme-text hover:underline"
        >
          {row.original.title}
        </a>
      ),
      sortingFn: sortingFnFor("title"),
      filterFn: (row, _id, value) =>
        !value || row.original.title.toLowerCase().includes(String(value).toLowerCase()),
      meta: { filterKind: "text" },
    },
    {
      id: "company",
      header: "Company",
      accessorFn: (g) => g.company ?? "",
      cell: ({ row }) => row.original.company ?? "—",
      sortingFn: sortingFnFor("company"),
      filterFn: (row, _id, value) =>
        !value || (row.original.company ?? "").toLowerCase().includes(String(value).toLowerCase()),
      meta: { filterKind: "text" },
    },
    {
      id: "tier",
      header: "Tier",
      accessorFn: (g) => g.tier ?? "",
      cell: ({ row }) => {
        const tier = row.original.tier;
        return (
          <span
            className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-current/30"
            style={tier ? TIER_BADGE_STYLE[tier] : TIER_BADGE_FALLBACK_STYLE}
          >
            {tier ?? "unrated"}
          </span>
        );
      },
      sortingFn: sortingFnFor("tier"),
      filterFn: (row, _id, value) => !value || row.original.tier === value,
      meta: { filterKind: "select", selectOptions: ["green", "yellow", "red"] },
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (g) => g.status,
      cell: ({ row }) => STATUS_LABEL[row.original.status],
      sortingFn: sortingFnFor("status"),
      filterFn: (row, _id, value) => {
        const checked = value as ReadonlySet<GigStatus> | undefined;
        return !checked || checked.has(row.original.status);
      },
      meta: { filterKind: "status-multi" },
    },
    {
      id: "rate",
      header: "Rate",
      accessorFn: (g) => g.rate?.min ?? null,
      cell: ({ row }) => formatRate(row.original.rate),
      sortingFn: sortingFnFor("rate"),
      filterFn: (row, _id, value) =>
        value == null || (row.original.rate?.min != null && row.original.rate.min >= (value as number)),
      meta: { filterKind: "number-min" },
    },
    {
      id: "weeklyHours",
      header: "Weekly hrs",
      accessorFn: (g) => g.weeklyHours ?? null,
      cell: ({ row }) => row.original.weeklyHours ?? "—",
      sortingFn: sortingFnFor("weeklyHours"),
      filterFn: (row, _id, value) =>
        value == null || (row.original.weeklyHours != null && row.original.weeklyHours <= (value as number)),
      meta: { filterKind: "number-max" },
    },
    {
      id: "firstSeen",
      header: "Seen",
      accessorFn: (g) => g.firstSeen,
      cell: ({ row }) => formatDate(row.original.firstSeen),
      sortingFn: sortingFnFor("firstSeen"),
      filterFn: (row, _id, value) =>
        isWithinSeenWindow(row.original.firstSeen, (value as SeenWindow) ?? "any", Date.now()),
      meta: { filterKind: "seen-window" },
    },
    {
      id: "changeStatus",
      header: "Change status",
      enableSorting: false,
      enableColumnFilter: false,
      cell: ({ row }) => {
        const gig = row.original;
        return (
          <>
            <select
              value={gig.status}
              disabled={isPending}
              onChange={(e) => handleStatusChange(gig.key, e.target.value as GigStatus)}
              aria-label={`Change status for ${gig.title}`}
              className="rounded-md border border-theme-surface-border px-2 py-1 text-sm text-theme-text disabled:opacity-50"
            >
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            {errorByKey[gig.key] && <p className="mt-1 max-w-[16rem] text-xs text-red-600">{errorByKey[gig.key]}</p>}
          </>
        );
      },
      meta: { filterKind: "none" },
    },
    {
      id: "draft",
      header: "Draft",
      enableSorting: false,
      enableColumnFilter: false,
      cell: ({ row }) => {
        const gig = row.original;
        if (!canGenerateDraft(gig.tier)) return null;
        return (
          <>
            <button
              type="button"
              disabled={generatingKeys.has(gig.key)}
              onClick={() => handleGenerateDraft(gig.key)}
              className="whitespace-nowrap rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm font-medium text-theme-text hover:bg-theme-surface-raised disabled:opacity-50"
            >
              {generatingKeys.has(gig.key) ? "Generating…" : draftButtonLabel(draftedGigKeys.has(gig.key))}
            </button>
            {draftErrorByKey[gig.key] && (
              <p className="mt-1 max-w-[16rem] text-xs text-red-600">{draftErrorByKey[gig.key]}</p>
            )}
          </>
        );
      },
      meta: { filterKind: "none" },
    },
    {
      id: "prep",
      header: "Prep",
      enableSorting: false,
      enableColumnFilter: false,
      cell: ({ row }) => {
        const gig = row.original;
        const packet = prepByKey[gig.key];
        return (
          <>
            <button
              type="button"
              disabled={generatingPrepKeys.has(gig.key)}
              onClick={() => handleGeneratePrep(gig.key)}
              className="whitespace-nowrap rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm font-medium text-theme-text hover:bg-theme-surface-raised disabled:opacity-50"
            >
              {generatingPrepKeys.has(gig.key) ? "Generating…" : packet ? "Regenerate prep packet" : "Generate prep packet"}
            </button>
            {prepErrorByKey[gig.key] && <p className="mt-1 max-w-[16rem] text-xs text-red-600">{prepErrorByKey[gig.key]}</p>}
            {packet && (
              <div className="mt-1 max-w-[20rem] text-xs text-theme-text">
                <p className="font-medium">
                  Fit score: {packet.score}/100 — {packet.recommendation}
                </p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-theme-text-dim hover:underline">Full prep packet</summary>
                  <div className="mt-1 flex flex-col gap-1">
                    <p>{packet.rationale}</p>
                    {packet.topStrengths.length > 0 && (
                      <p>
                        <span className="font-medium">Top strengths:</span> {packet.topStrengths.join("; ")}
                      </p>
                    )}
                    {packet.keyGaps.length > 0 && (
                      <p>
                        <span className="font-medium">Key gaps:</span> {packet.keyGaps.join("; ")}
                      </p>
                    )}
                    {packet.predictedQuestions.length > 0 && (
                      <p>
                        <span className="font-medium">Predicted questions:</span> {packet.predictedQuestions.join("; ")}
                      </p>
                    )}
                    {packet.starlaStories.length > 0 && (
                      <p>
                        <span className="font-medium">STARLA story prompts:</span> {packet.starlaStories.join("; ")}
                      </p>
                    )}
                    <p className="mt-1 border-t border-theme-surface-border pt-1 font-medium">
                      ATS keyword match: {packet.atsScore.keywordOverlapScore}/100 (vs. your tracked skills/roles)
                    </p>
                    {packet.atsScore.matchedKeywords.length > 0 && (
                      <p>
                        <span className="font-medium">Matched keywords:</span> {packet.atsScore.matchedKeywords.join("; ")}
                      </p>
                    )}
                    {packet.atsScore.missingKeywords.length > 0 && (
                      <p>
                        <span className="font-medium">Missing keywords:</span> {packet.atsScore.missingKeywords.join("; ")}
                      </p>
                    )}
                    {packet.atsScore.resumeTweaks.length > 0 && (
                      <div>
                        <span className="font-medium">Tweaks to close the gap:</span>
                        <ul className="ml-4 list-disc">
                          {packet.atsScore.resumeTweaks.map((tweak) => (
                            <li key={tweak}>{tweak}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {packet.atsScore.resumeChecked ? (
                      packet.atsScore.parseabilityIssues.length > 0 ? (
                        <div>
                          <span className="font-medium">Resume format issues (from your saved resume):</span>
                          <ul className="ml-4 list-disc">
                            {packet.atsScore.parseabilityIssues.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <p className="text-green-700">No resume format issues found.</p>
                      )
                    ) : (
                      <p className="text-theme-text-dim">
                        No resume format check — save a resume on /config to get a real ATS-parseability read.
                      </p>
                    )}
                  </div>
                </details>
              </div>
            )}
          </>
        );
      },
      meta: { filterKind: "none" },
    },
  ];

  const table = useReactTable({
    data: gigs,
    columns,
    state: { sorting, columnFilters },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = table.getRowModel().rows;

  return (
    <div className="mt-6 flex flex-col gap-3">
      <p className="text-sm text-theme-text-dim">
        {rows.length} of {gigs.length} gig{gigs.length === 1 ? "" : "s"}
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
        Only the label/sort header row is sticky -- the filter row below it
        scrolls away with the body, avoiding fragile two-row sticky offset
        math for a modest UX tradeoff (set filters before scrolling).
      */}
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-theme-surface-border shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-theme-surface-raised">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortDirection = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="sticky top-0 z-[1] isolate bg-theme-surface-raised px-3 py-2 text-left font-semibold text-theme-text-dim"
                    >
                      {header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          aria-sort={sortDirection ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
                          className="flex items-center gap-1 hover:text-theme-text"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <span className="text-theme-text-dim">
                            {sortDirection ? (sortDirection === "asc" ? "▲" : "▼") : ""}
                          </span>
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
            <tr>
              {table.getFlatHeaders().map((header) => (
                <th key={`filter-${header.id}`} className="bg-theme-surface-raised px-3 pb-2">
                  <ColumnFilterCell
                    filterKind={header.column.columnDef.meta?.filterKind ?? "none"}
                    selectOptions={header.column.columnDef.meta?.selectOptions}
                    value={header.column.getFilterValue()}
                    onChange={(v) => header.column.setFilterValue(v)}
                    label={
                      typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : header.id
                    }
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-theme-surface">
            {rows.map((row) => (
              <tr key={row.original.key} className="odd:bg-theme-surface even:bg-theme-surface-raised/60 hover:bg-slate-100">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2 text-theme-text-dim">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-theme-text-dim">
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
