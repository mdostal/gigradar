"use client";

// rate-band-match-quality epic, match-quality-settings-page story.
// Deliberately a SMALL, STANDALONE client component -- NOT another
// section added to config-client.tsx (already 3000+ lines). Owner's own
// words, live, the same night this epic was scoped: "we aren't doing this
// right... instead letting claude do shitty one-offs." A small, focused
// file for exactly two real settings per group is the lower-risk choice.
//
// Edits the FULL `groups` array and submits it via saveConfigAction() --
// saveConfig()'s own merge is TOP-LEVEL only (see save.ts's header
// comment: an edit that includes `groups` replaces the entire array), so
// every group's untouched fields are carried through unchanged alongside
// the one being edited here.
import { useState, useTransition } from "react";
import { saveConfigAction } from "./actions";
import {
  DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT,
  DEFAULT_NEAR_BAND_TOLERANCE_PCT,
} from "@/lib/matching/match-band";
import type { GroupConfig } from "@/lib/types";

interface DraftRow {
  id: string;
  label: string;
  nearBandTolerancePct: string;
  hideOutOfBandByDefault: boolean;
}

function draftRowsFrom(groups: readonly GroupConfig[]): DraftRow[] {
  return groups.map((g) => ({
    id: g.id,
    label: g.label,
    nearBandTolerancePct: String(g.matchQuality?.nearBandTolerancePct ?? DEFAULT_NEAR_BAND_TOLERANCE_PCT),
    hideOutOfBandByDefault: g.matchQuality?.hideOutOfBandByDefault ?? DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT,
  }));
}

export function MatchQualityClient({ initialGroups }: { initialGroups: GroupConfig[] }) {
  const [rows, setRows] = useState<DraftRow[]>(() => draftRowsFrom(initialGroups));
  const [isPending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function updateRow(id: string, patch: Partial<DraftRow>) {
    setSaved(false);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  function handleSave() {
    setSaveError(null);
    const parsedRows = rows.map((r) => ({ id: r.id, pct: Number(r.nearBandTolerancePct), hide: r.hideOutOfBandByDefault }));
    const badRow = parsedRows.find((r) => !Number.isFinite(r.pct) || r.pct < 0 || r.pct > 100);
    if (badRow) {
      setSaveError(`Tolerance must be a number between 0 and 100 (group "${badRow.id}").`);
      return;
    }
    const groups = initialGroups.map((g) => {
      const row = parsedRows.find((r) => r.id === g.id);
      if (!row) return g;
      return { ...g, matchQuality: { nearBandTolerancePct: row.pct, hideOutOfBandByDefault: row.hide } };
    });
    startTransition(async () => {
      const result = await saveConfigAction({ groups });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setSaved(true);
    });
  }

  if (rows.length === 0) {
    return <p className="text-sm text-theme-text-dim">No groups configured yet — set up a group under Groups & Needs first.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-theme-text-dim">
        Every gig gets a rate-based Match Band (In-band / Near-band / Out-of-band) alongside its existing tier. These
        two numbers control it per group — tune them however you like.
      </p>
      <div className="flex flex-col gap-5">
        {rows.map((row) => (
          <fieldset key={row.id} className="flex flex-col gap-3 rounded-lg border border-theme-surface-border p-4">
            <legend className="px-1 font-theme-heading text-sm font-semibold text-theme-text">{row.label}</legend>
            <label className="flex flex-col gap-1 text-sm text-theme-text">
              Near-band tolerance (%)
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={row.nearBandTolerancePct}
                onChange={(e) => updateRow(row.id, { nearBandTolerancePct: e.target.value })}
                className="w-32 rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm text-theme-text"
              />
              <span className="text-xs text-theme-text-dim">
                How far under this group's rate floor still counts as "near-band" (worth a glance) instead of
                "out-of-band" (hidden by default).
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-theme-text">
              <input
                type="checkbox"
                checked={row.hideOutOfBandByDefault}
                onChange={(e) => updateRow(row.id, { hideOutOfBandByDefault: e.target.checked })}
              />
              Hide out-of-band gigs by default on Today / All Gigs
            </label>
          </fieldset>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={handleSave}
          className="rounded-md bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-ink disabled:opacity-50"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-sm text-theme-tier-green">Saved.</span>}
        {saveError && <span className="text-sm text-theme-tier-red">{saveError}</span>}
      </div>
    </div>
  );
}
