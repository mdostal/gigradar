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
import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { GigStatus, OutcomeReason, StoredGig } from "@/lib/store";
import type { PrepPacketContent } from "@/lib/apply/prep";
import { bulkMarkAppliedElsewhereAction, generateDraftAction, generatePrepPacketAction, updateGigStatusAction } from "./actions";
import { canGenerateDraft, draftButtonLabel } from "./dashboard-draft";
import { DASHBOARD_PREFS_STORAGE_KEY, deserializeDashboardPrefs, serializeDashboardPrefs } from "./dashboard-prefs";
import { distinctSources, isWithinSeenWindow, SEEN_WINDOW_OPTIONS, shortProfileLabel, type SeenWindow } from "./dashboard-filter";
import { compareByField, type SortField } from "./dashboard-sort";
import { GigDetailPanel } from "./gig-detail-panel";
import { ContextualChatTrigger } from "./contextual-chat/contextual-chat-trigger";

export const ALL_STATUSES: GigStatus[] = ["new", "applied", "interview", "archived", "ignored"];

export const STATUS_LABEL: Record<GigStatus, string> = {
  new: "New",
  applied: "Applied",
  interview: "Interview",
  archived: "Archived",
  ignored: "Ignored",
};

/**
 * status-reconciliation-outcomes story, product-review-followups epic --
 * see store/types.ts's `OutcomeReason` for the full owner-quote rationale.
 * Short labels, meant to sit next to STATUS_LABEL's own "Archived" (e.g.
 * "Archived (Rejected)") -- the full raw platform text lives in
 * `gig.outcomeNote`, surfaced as a tooltip/detail-panel field, not repeated
 * here.
 */
export const OUTCOME_LABEL: Record<OutcomeReason, string> = {
  rejected: "Rejected",
  withdrawn: "Withdrawn/closed",
  expired_unapplied: "Missed — closed before we applied",
};

/**
 * dashboard-profile-grouping story — owner's own words: "we aren't
 * filtering based on the salaries and grouping them like I asked where we
 * can create different groups... my A list is all fractional gigs and
 * they pay hourly... let's make a C list." `Gig.matchedProfileIds`
 * (stamped by the matching runner from `Needs.engagementProfiles`) already
 * records WHICH configured rate/engagement-type profile(s) a gig cleared —
 * a completely different axis from the Tier column (matching/tiering.ts's
 * role-area keyword classifier, see that column's own comment). This was
 * real, existing data with no dashboard surface at all until now.
 *
 * Sentinel for "matched zero configured profiles" — a real, common,
 * meaningful bucket (e.g. every RED-tier gig, or a green-tier gig whose
 * rate/hours don't clear anything you've configured — see the Tier
 * column's own ⚠ marker), not an edge case to hide.
 */
export const NO_PROFILE_MATCH = "__none__";

/**
 * Pipeline tabs (product-review-followups epic, dashboard-redesign story) --
 * the owner's own words: "this ALSO doesn't show the ones I've already
 * applied, passed, etc" and "this can be a clean process with gigs to
 * apply, once we apply we can see the applied, the interviewing and
 * packets etc." The underlying data already had every status visible (the
 * status-multi column filter below defaulted to all of them checked) -- the
 * actual gap was presentation: one flat table with no way to land on "just
 * what I need to act on right now." Each tab is nothing more than a canned
 * preset for the EXISTING status column filter (same Set<GigStatus> value
 * the manual per-status chips below already drive), so it rides the exact
 * same filter/sort/persistence machinery instead of adding a parallel one.
 * "Archived" folds in "ignored" too -- both are terminal/inactive states
 * from the pipeline's point of view; the manual chips still let someone
 * split them back apart if they want that distinction.
 */
const PIPELINE_TABS: { key: string; label: string; statuses: GigStatus[] }[] = [
  { key: "review", label: "To review", statuses: ["new"] },
  { key: "applied", label: "Applied", statuses: ["applied"] },
  { key: "interviewing", label: "Interviewing", statuses: ["interview"] },
  { key: "archived", label: "Archived", statuses: ["archived", "ignored"] },
  { key: "all", label: "All", statuses: ALL_STATUSES },
];

function sameStatusSet(a: ReadonlySet<GigStatus> | undefined, statuses: GigStatus[]): boolean {
  if (!a || a.size !== statuses.length) return false;
  return statuses.every((s) => a.has(s));
}

// Tier badge colors read from the theme-invariant CSS custom properties
// (globals.css root) rather than hardcoded Tailwind green/yellow/red
// utilities — ui-theme-system epic: tier color must read identically no
// matter which visual theme (radar/editorial/terminal) is active, so this
// maps to inline custom-property references, not per-theme classes. A gig
// with no tier yet (Gig.tier is optional) gets the neutral fallback, never
// a guessed color.
export const TIER_BADGE_STYLE: Record<string, { color: string; background: string }> = {
  green: { color: "var(--tier-green)", background: "color-mix(in srgb, var(--tier-green) 16%, transparent)" },
  yellow: { color: "var(--tier-yellow)", background: "color-mix(in srgb, var(--tier-yellow) 16%, transparent)" },
  red: { color: "var(--tier-red)", background: "color-mix(in srgb, var(--tier-red) 16%, transparent)" },
};
export const TIER_BADGE_FALLBACK_STYLE = { color: "var(--text-secondary, #64748b)", background: "var(--surface-bg-raised, #f1f5f9)" };

/**
 * gigradar-command-center epic, Signal Deck: the radial signal-meter's arc
 * fill -- how "fresh" a gig still reads, not just its tier color. 0 (just
 * seen) fills the full ring; decays linearly to a small residual sliver by
 * SIGNAL_DECAY_DAYS out, never fully empty (a month-old green match is
 * still worth seeing, just visually quieter). Exported/pure so it's
 * testable without rendering the SVG.
 */
export const SIGNAL_DECAY_DAYS = 14;
export function signalStrength(firstSeen: string, now: number): number {
  const ageMs = now - new Date(firstSeen).getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  const ageDays = ageMs / 86_400_000;
  return Math.max(0.12, 1 - ageDays / SIGNAL_DECAY_DAYS);
}

/**
 * The radial signal-meter itself -- a small ring whose stroke color is the
 * tier's own theme-invariant color (TIER_BADGE_STYLE, unchanged) and whose
 * arc length encodes signalStrength() above. Purely decorative/additive:
 * the plain text tier badge next to it (unchanged, still "green"/
 * "unrated"/etc.) remains the authoritative, screen-reader-visible value,
 * so this never needs its own aria-label.
 */
function TierSignalMeter({ tier, firstSeen }: { tier: StoredGig["tier"]; firstSeen: string }) {
  const color = (tier ? TIER_BADGE_STYLE[tier]?.color : undefined) ?? TIER_BADGE_FALLBACK_STYLE.color;
  const strength = signalStrength(firstSeen, Date.now());
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="shrink-0">
      <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeWidth="2" className="text-theme-surface-border" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - strength)}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

export function formatRate(rate: StoredGig["rate"]): string {
  if (!rate) return "—";
  const { min, max, unit } = rate;
  if (min != null && max != null) return `$${min}–$${max}/${unit}`;
  if (min != null) return `$${min}+/${unit}`;
  if (max != null) return `up to $${max}/${unit}`;
  return `/${unit}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

const filterInputClass =
  "w-full rounded border border-theme-surface-border px-1.5 py-1 text-xs text-theme-text placeholder:text-theme-text-dim focus:border-theme-accent focus:outline-none";

/**
 * Per-column filter control shape — driven by each ColumnDef's own `meta`
 * (module-augmented below), so the header-row renderer stays generic
 * instead of a giant switch keyed on column id.
 */
type FilterKind = "text" | "select" | "status-multi" | "profile-multi" | "number-min" | "number-max" | "seen-window" | "none";

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
  profiles,
}: {
  filterKind: FilterKind;
  value: unknown;
  onChange: (next: unknown) => void;
  selectOptions?: string[];
  label: string;
  /** Only for filterKind: "profile-multi" — the configured engagement profiles, dynamic per-install (unlike ALL_STATUSES). */
  profiles?: { id: string; label: string }[];
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
                active ? "bg-theme-accent text-theme-accent-ink" : "bg-theme-surface-raised text-theme-text-dim hover:bg-theme-surface-border",
              ].join(" ")}
            >
              {STATUS_LABEL[s]}
            </button>
          );
        })}
      </div>
    );
  }

  if (filterKind === "profile-multi") {
    const options = [...(profiles ?? []), { id: NO_PROFILE_MATCH, label: "None" }];
    const checked = (value as ReadonlySet<string>) ?? new Set(options.map((o) => o.id));
    return (
      <div className="flex flex-wrap gap-1">
        {options.map((o) => {
          const active = checked.has(o.id);
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={active}
              title={o.label}
              onClick={() => {
                const next = new Set(checked);
                if (next.has(o.id)) next.delete(o.id);
                else next.add(o.id);
                onChange(next);
              }}
              className={[
                "rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                active ? "bg-theme-accent text-theme-accent-ink" : "bg-theme-surface-raised text-theme-text-dim hover:bg-theme-surface-border",
              ].join(" ")}
            >
              {o.id === NO_PROFILE_MATCH ? o.label : shortProfileLabel(o.label)}
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
  initialPrepByGigKey = {},
  engagementProfiles = [],
}: {
  gigs: StoredGig[];
  draftedGigKeys?: ReadonlySet<string>;
  /** Prep packets already persisted (interview_prep table) as of this page's own listGigs()-sibling fetch in page.tsx -- see that file's comment for why this now loads instead of starting empty. */
  initialPrepByGigKey?: Readonly<Record<string, PrepPacketContent>>;
  /** dashboard-profile-grouping story — this install's configured Needs.engagementProfiles, {id,label} only (see page.tsx's extractEngagementProfileSummaries()). Empty for a first-run install with no Needs configured yet -- the Profile column/filter then just shows the "None" bucket for everything, never crashes. */
  engagementProfiles?: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([]);
  // Default landing view is the "To review" pipeline tab (status: new only)
  // -- a fresh install/cleared-prefs visit lands on "what do I need to act
  // on," not the old all-statuses-mixed-together default. Any real prior
  // visit overrides this via the persisted-prefs useEffect below, same as
  // before this change.
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([
    { id: "status", value: new Set<GigStatus>(["new"]) },
  ]);

  // product-review-followups epic: read any previously-saved sort/filter
  // preference ONCE on mount and apply it -- deliberately not read
  // directly into the useState initializer above (localStorage doesn't
  // exist during Next's server render; reading it there would either throw
  // or produce a server/client hydration mismatch). Falls back silently
  // (stays on the hardcoded defaults above) for a first-ever visit, a
  // corrupted/foreign value, or a private-browsing context where
  // localStorage access itself throws.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DASHBOARD_PREFS_STORAGE_KEY);
      if (!raw) return;
      const prefs = deserializeDashboardPrefs(raw);
      if (!prefs) return;
      setSorting(prefs.sorting);
      setColumnFilters(prefs.columnFilters);
    } catch {
      // localStorage unavailable (private browsing, etc.) -- stay on defaults.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persists on every real change. A late write right after the mount-only
  // read above (still holding the pre-restore defaults) is expected and
  // harmless -- the very next write, once the restored values actually
  // land in state, corrects it.
  useEffect(() => {
    try {
      localStorage.setItem(DASHBOARD_PREFS_STORAGE_KEY, serializeDashboardPrefs({ sorting, columnFilters }));
    } catch {
      // Storage full/unavailable -- not persisting a preference is never fatal.
    }
  }, [sorting, columnFilters]);

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
  const [prepByKey, setPrepByKey] = useState<Record<string, PrepPacketContent>>(initialPrepByGigKey);

  // Row-by-row detail browsing (job-detail-row-browsing story). Tracked by
  // KEY, not array index -- a status change made from inside the panel
  // (e.g. "To review" -> mark Applied) can remove the gig from the
  // CURRENTLY ACTIVE pipeline tab's filtered rows entirely; re-deriving
  // `selectedIndex` from `rows` by key on every render (below, once `rows`
  // exists) means the panel just closes itself via the effect further down
  // rather than pointing at a stale/wrong index into a shifted array.
  const [selectedGigKey, setSelectedGigKey] = useState<string | null>(null);

  // mark-applied-elsewhere-bulk-action story: checkbox multi-select for the
  // manual reconciliation fallback -- a SEPARATE concept from
  // selectedGigKey above (that's the single-row detail-panel selection).
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  const [bulkPending, startBulkTransition] = useTransition();
  const [bulkError, setBulkError] = useState<string | null>(null);

  function toggleChecked(key: string) {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleBulkMarkAppliedElsewhere() {
    setBulkError(null);
    const keys = [...checkedKeys];
    startBulkTransition(async () => {
      const result = await bulkMarkAppliedElsewhereAction(keys);
      if (!result.ok) {
        setBulkError(result.error);
        return;
      }
      if (result.data.errors.length > 0) {
        setBulkError(`${result.data.updated} marked applied; ${result.data.errors.length} failed (${result.data.errors.map((e) => e.message).join("; ")})`);
      }
      setCheckedKeys(new Set());
    });
  }

  const sources = useMemo(() => distinctSources(gigs), [gigs]);

  // Counts are over the FULL `gigs` array, not the currently-filtered rows
  // -- a tab needs to say how many gigs are waiting in it regardless of
  // which tab (or manual filter) happens to be active right now.
  const countByStatus = useMemo(() => {
    const counts: Record<GigStatus, number> = { new: 0, applied: 0, interview: 0, archived: 0, ignored: 0 };
    for (const g of gigs) counts[g.status]++;
    return counts;
  }, [gigs]);

  // gigradar-command-center epic, Signal Deck status-strip: "ready to act"
  // is the owner's own real triage question -- green tier AND still new,
  // the exact combination the pipeline tabs' "To review" tab already
  // filters to when paired with a tier filter, computed here once for the
  // readout tiles rather than re-deriving it from the (possibly
  // differently-filtered) `rows` below.
  const readyToActCount = useMemo(() => gigs.filter((g) => g.status === "new" && g.tier === "green").length, [gigs]);
  const inProgressCount = countByStatus.applied + countByStatus.interview;

  const statusFilterValue = columnFilters.find((f) => f.id === "status")?.value as ReadonlySet<GigStatus> | undefined;
  const activeTabKey = PIPELINE_TABS.find((t) => sameStatusSet(statusFilterValue, t.statuses))?.key;

  function handleTabSelect(statuses: GigStatus[]) {
    setColumnFilters((prev) => {
      const next = prev.filter((f) => f.id !== "status");
      next.push({ id: "status", value: new Set(statuses) });
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

  /**
   * Shared cell content for the "Draft" column -- factored out so the
   * job-detail-row-browsing panel (gig-detail-panel.tsx) can render the
   * EXACT same control + inline error, keyed off the SAME
   * generatingKeys/draftErrorByKey state, instead of a second copy that
   * could drift out of sync with the table's own row.
   */
  function renderDraftSection(gig: StoredGig) {
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
        {draftErrorByKey[gig.key] && <p className="mt-1 max-w-[16rem] text-xs text-red-600">{draftErrorByKey[gig.key]}</p>}
      </>
    );
  }

  /**
   * Same rationale as renderDraftSection() above, for the "Prep" column.
   * Once a gig is interviewing, this becomes a link to its own dedicated
   * workspace page (gigradar-command-center epic, interview-workspace-page
   * story) instead of the inline <details> dump below -- "fire off a full
   * prep packet" is that page's own primary action now.
   */
  function renderPrepSection(gig: StoredGig) {
    const packet = prepByKey[gig.key];
    if (gig.status === "interview") {
      // encodeURIComponent(): gig.key is "sourceId:externalId" (gigKey() in
      // store/gigs.ts) -- the raw colon is a reserved URL character, and
      // leaving it unencoded here made the [key] dynamic segment fail to
      // match its own gig on the interview workspace route (a real 404,
      // caught live during this story's own verification).
      return (
        <Link
          href={`/gigs/${encodeURIComponent(gig.key)}/interview`}
          className="whitespace-nowrap rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm font-medium text-theme-text hover:bg-theme-surface-raised"
        >
          Open interview workspace →
        </Link>
      );
    }
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
  }

  const columns: ColumnDef<StoredGig>[] = [
    {
      id: "select",
      header: () => (
        <input
          type="checkbox"
          aria-label="Select all visible gigs"
          checked={rows.length > 0 && rows.every((r) => checkedKeys.has(r.original.key))}
          onChange={(e) => {
            setCheckedKeys(e.target.checked ? new Set(rows.map((r) => r.original.key)) : new Set());
          }}
        />
      ),
      enableSorting: false,
      enableColumnFilter: false,
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={`Select ${row.original.title}`}
          checked={checkedKeys.has(row.original.key)}
          onChange={() => toggleChecked(row.original.key)}
        />
      ),
      meta: { filterKind: "none" },
    },
    {
      id: "view",
      header: "",
      enableSorting: false,
      enableColumnFilter: false,
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSelectedGigKey(row.original.key)}
            className="whitespace-nowrap rounded-md border border-theme-surface-border px-2 py-1 text-xs font-medium text-theme-text hover:bg-theme-surface-raised"
          >
            View →
          </button>
          <ContextualChatTrigger kind="gig" itemKey={row.original.key} label={row.original.title} />
        </div>
      ),
      meta: { filterKind: "none" },
    },
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
        // Tier (matching/tiering.ts) is a role-AREA classifier only — title/
        // description keyword matching, completely independent of whether
        // this gig actually cleared any of your engagement-type/rate
        // profiles (matching/gate.ts). A tier="green" full-time listing
        // that no configured profile accepts is real and expected (found
        // live: "Software Engineer II" reqs tiering green purely off a
        // broad keyword like "agentic" appearing in the description) — this
        // marker is what makes that visible instead of green silently
        // implying "matches what you'd accept."
        const clearedAProfile = (row.original.matchedProfileIds?.length ?? 0) > 0;
        // customizable-tier-scoring epic: the real, persisted match score
        // behind this tier (title attribute only -- no layout change) —
        // visible regardless of which tierScoring mode actually produced
        // this tier (keyword mode still computes/persists a score, it's
        // just not what decided the tier).
        const score = row.original.matchScore;
        // ai-verify-tier-integration story (config-rebuild-and-match-quality
        // epic): the one place applyAiVerification()'s persisted verdict
        // (StoredGig.aiFlags, already a real DB column, previously never
        // rendered anywhere in src/app) becomes visible. Any group's
        // rejection is shown -- the giglist doesn't know which group is
        // "primary" the way runner.ts does, so this surfaces every
        // real rejection reason rather than guessing one.
        const aiRejections = Object.values(row.original.aiFlags ?? {}).filter((f) => !f.confirmed);
        return (
          <span className="inline-flex items-center gap-1.5">
            <TierSignalMeter tier={tier} firstSeen={row.original.firstSeen} />
            <span
              className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-current/30"
              style={tier ? TIER_BADGE_STYLE[tier] : TIER_BADGE_FALLBACK_STYLE}
              title={score !== undefined ? `Match score: ${score.toFixed(2)}` : undefined}
            >
              {tier ?? "unrated"}
            </span>
            {tier && tier !== "red" && !clearedAProfile && (
              <span
                title="Role-area match only — this gig didn't clear any of your configured engagement-type/rate profiles (Config → Needs)"
                className="cursor-help text-xs text-theme-text-dim"
              >
                ⚠
              </span>
            )}
            {aiRejections.length > 0 && (
              <span
                title={`AI verification flagged this as a likely role-type mismatch: ${aiRejections.map((f) => f.reason).join(" ")}`}
                className="cursor-help text-xs text-amber-600"
              >
                🤖⚠
              </span>
            )}
          </span>
        );
      },
      sortingFn: sortingFnFor("tier"),
      filterFn: (row, _id, value) => !value || row.original.tier === value,
      meta: { filterKind: "select", selectOptions: ["green", "yellow", "red"] },
    },
    {
      id: "profile",
      header: "Profile",
      // dashboard-profile-grouping story — WHICH configured rate/engagement-
      // type profile(s) this gig cleared (matching/gate.ts), a different
      // axis from Tier (role-area only, matching/tiering.ts — see that
      // column's own comment). Sorts by profile count so multi-match gigs
      // group together; ties keep their existing relative order.
      accessorFn: (g) => g.matchedProfileIds?.length ?? 0,
      cell: ({ row }) => {
        const ids = row.original.matchedProfileIds ?? [];
        if (ids.length === 0) return <span className="text-theme-text-dim">—</span>;
        return (
          <span className="flex flex-wrap gap-1">
            {ids.map((id) => {
              const profile = engagementProfiles.find((p) => p.id === id);
              return (
                <span
                  key={id}
                  title={profile?.label ?? id}
                  className="inline-flex rounded-full bg-theme-surface-raised px-1.5 py-0.5 text-[11px] font-medium text-theme-text-dim"
                >
                  {profile ? shortProfileLabel(profile.label) : id}
                </span>
              );
            })}
          </span>
        );
      },
      filterFn: (row, _id, value) => {
        const checked = value as ReadonlySet<string> | undefined;
        if (!checked) return true;
        const ids = row.original.matchedProfileIds ?? [];
        if (ids.length === 0) return checked.has(NO_PROFILE_MATCH);
        return ids.some((id) => checked.has(id));
      },
      meta: { filterKind: "profile-multi" },
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (g) => g.status,
      cell: ({ row }) => {
        const gig = row.original;
        if (!gig.outcomeReason) return STATUS_LABEL[gig.status];
        return (
          <span title={gig.outcomeNote ?? undefined}>
            {STATUS_LABEL[gig.status]} <span className="text-theme-text-dim">({OUTCOME_LABEL[gig.outcomeReason]})</span>
          </span>
        );
      },
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
      cell: ({ row }) => <span className="font-theme-mono">{formatRate(row.original.rate)}</span>,
      sortingFn: sortingFnFor("rate"),
      filterFn: (row, _id, value) =>
        value == null || (row.original.rate?.min != null && row.original.rate.min >= (value as number)),
      meta: { filterKind: "number-min" },
    },
    {
      id: "weeklyHours",
      header: "Weekly hrs",
      accessorFn: (g) => g.weeklyHours ?? null,
      cell: ({ row }) => <span className="font-theme-mono">{row.original.weeklyHours ?? "—"}</span>,
      sortingFn: sortingFnFor("weeklyHours"),
      filterFn: (row, _id, value) =>
        value == null || (row.original.weeklyHours != null && row.original.weeklyHours <= (value as number)),
      meta: { filterKind: "number-max" },
    },
    {
      id: "firstSeen",
      header: "Seen",
      accessorFn: (g) => g.firstSeen,
      cell: ({ row }) => <span className="font-theme-mono">{formatDate(row.original.firstSeen)}</span>,
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
      cell: ({ row }) => renderDraftSection(row.original),
      meta: { filterKind: "none" },
    },
    {
      id: "prep",
      header: "Prep",
      enableSorting: false,
      enableColumnFilter: false,
      cell: ({ row }) => renderPrepSection(row.original),
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

  const selectedIndex = selectedGigKey == null ? -1 : rows.findIndex((r) => r.original.key === selectedGigKey);
  const selectedGig = selectedIndex >= 0 ? (rows[selectedIndex]?.original ?? null) : null;

  // Auto-close when the selected gig falls out of the current view (filter
  // change, tab switch, or a status change made from inside the panel
  // itself moved it to a different pipeline stage) -- see the state
  // declaration above for why this is keyed off identity, not index.
  useEffect(() => {
    if (selectedGigKey != null && selectedIndex === -1) setSelectedGigKey(null);
  }, [selectedGigKey, selectedIndex]);

  function handlePrev() {
    const prev = selectedIndex > 0 ? rows[selectedIndex - 1] : undefined;
    if (prev) setSelectedGigKey(prev.original.key);
  }

  function handleNext() {
    const next = selectedIndex >= 0 && selectedIndex < rows.length - 1 ? rows[selectedIndex + 1] : undefined;
    if (next) setSelectedGigKey(next.original.key);
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      {/*
        gigradar-command-center epic, Signal Deck status-strip: a real,
        computed "what actually needs me today" readout above the pipeline
        tabs -- ready-to-act (green + new) is the owner's own triage
        question, made a first-class number instead of something you'd
        have to derive by eyeballing the table. Each tile doubles as a
        filter shortcut into the pipeline tabs below (clicking it applies
        the matching status filter, same handleTabSelect() the tabs
        themselves use), so it's additive UI over existing filter state,
        never a second source of truth.
      */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-theme-surface-border bg-theme-surface-border sm:grid-cols-4">
        {[
          { label: "Ready to act", hint: "Green & new", value: readyToActCount, onClick: () => handleTabSelect(["new"]) },
          { label: "New", hint: "All tiers", value: countByStatus.new, onClick: () => handleTabSelect(["new"]) },
          { label: "In progress", hint: "Applied + interview", value: inProgressCount, onClick: () => handleTabSelect(["applied", "interview"]) },
          { label: "Tracked", hint: "Every status", value: gigs.length, onClick: () => handleTabSelect(ALL_STATUSES) },
        ].map((tile) => (
          <button
            key={tile.label}
            type="button"
            onClick={tile.onClick}
            className="flex flex-col gap-0.5 bg-theme-surface px-4 py-3 text-left transition-colors hover:bg-theme-surface-raised"
          >
            <span className="font-theme-mono text-2xl font-semibold text-theme-text">{tile.value}</span>
            <span className="text-xs font-medium text-theme-text">{tile.label}</span>
            <span className="text-[11px] text-theme-text-faint">{tile.hint}</span>
          </button>
        ))}
      </div>

      <nav aria-label="Pipeline stage" className="flex flex-wrap gap-1.5 border-b border-theme-surface-border pb-3">
        {PIPELINE_TABS.map((tab) => {
          const count = tab.statuses.reduce((sum, s) => sum + countByStatus[s], 0);
          const active = activeTabKey === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              aria-pressed={active}
              onClick={() => handleTabSelect(tab.statuses)}
              className={[
                "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-theme-accent text-theme-accent-ink"
                  : "border border-theme-surface-border bg-theme-surface text-theme-text-dim hover:bg-theme-surface-raised",
              ].join(" ")}
            >
              {tab.label} <span className={`font-theme-mono ${active ? "opacity-70" : "text-theme-text-dim/70"}`}>{count}</span>
            </button>
          );
        })}
      </nav>

      <p className="text-sm text-theme-text-dim">
        {rows.length} of {gigs.length} gig{gigs.length === 1 ? "" : "s"}
      </p>

      {checkedKeys.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-theme-surface-border bg-theme-surface-raised px-3 py-2 text-sm">
          <span className="font-theme-mono text-theme-text-dim">{checkedKeys.size} selected</span>
          <button
            type="button"
            disabled={bulkPending}
            onClick={handleBulkMarkAppliedElsewhere}
            className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-xs font-medium text-theme-text transition-colors hover:bg-theme-surface-raised disabled:opacity-50"
          >
            {bulkPending ? "Marking…" : "Mark as applied elsewhere"}
          </button>
          <button
            type="button"
            onClick={() => setCheckedKeys(new Set())}
            className="text-xs font-medium text-theme-text-dim hover:underline"
          >
            Clear selection
          </button>
          {bulkError && <span className="text-xs text-red-600">{bulkError}</span>}
        </div>
      )}

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
        <table className="min-w-full divide-y divide-theme-surface-border text-sm">
          <thead className="bg-theme-surface-raised">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortDirection = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className="sticky top-0 z-[1] isolate bg-theme-surface-raised px-3 py-2 text-left font-theme-heading text-[11px] font-semibold uppercase tracking-wide text-theme-text-dim"
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
                    profiles={engagementProfiles}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-surface-border/60 bg-theme-surface">
            {rows.map((row) => (
              <tr key={row.original.key} className="group odd:bg-theme-surface even:bg-theme-surface-raised/60 hover:bg-theme-accent-dim">
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

      {selectedGig && (
        <GigDetailPanel
          gig={selectedGig}
          position={{ index: selectedIndex, total: rows.length }}
          onClose={() => setSelectedGigKey(null)}
          onPrev={handlePrev}
          onNext={handleNext}
          canPrev={selectedIndex > 0}
          canNext={selectedIndex >= 0 && selectedIndex < rows.length - 1}
          statusChangeSection={
            <>
              <select
                value={selectedGig.status}
                disabled={isPending}
                onChange={(e) => handleStatusChange(selectedGig.key, e.target.value as GigStatus)}
                aria-label={`Change status for ${selectedGig.title}`}
                className="rounded-md border border-theme-surface-border px-2 py-1 text-sm text-theme-text disabled:opacity-50"
              >
                {ALL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              {errorByKey[selectedGig.key] && <p className="mt-1 text-xs text-red-600">{errorByKey[selectedGig.key]}</p>}
            </>
          }
          draftSection={renderDraftSection(selectedGig)}
          prepSection={renderPrepSection(selectedGig)}
        />
      )}
    </div>
  );
}
