"use client";

// rank-buckets epic, rank-bucket-settings-page story. Same deliberate
// "small, standalone client component, NOT another section added to the
// 3000+ line config-client.tsx" pattern as match-quality-client.tsx (the
// most recent, most directly relevant precedent -- read in full before
// writing this file).
//
// Owner-confirmed shape: owner-NAMED, ORDERED bucket labels per group.
// Order is a REAL, persisted rule-precedence signal (assignRankBucket()'s
// own "first match wins, in declared order" contract) -- the up/down
// reorder controls below actually change stored list order, never a
// cosmetic-only reorder.
import { useState, useTransition } from "react";
import { saveConfigAction } from "./actions";
import type { GroupConfig, RankBucketRule } from "@/lib/types";

interface DraftBucket {
  label: string;
  description: string;
  minRate: string;
  maxRate: string;
  keywords: string; // comma-separated in the UI, parsed to string[] on save
}

interface DraftGroup {
  id: string;
  label: string;
  buckets: DraftBucket[];
  aiOverlay: boolean;
}

function draftBucketFrom(rule: RankBucketRule): DraftBucket {
  return {
    label: rule.label,
    description: rule.description ?? "",
    minRate: rule.minRate === undefined ? "" : String(rule.minRate),
    maxRate: rule.maxRate === undefined ? "" : String(rule.maxRate),
    keywords: (rule.keywords ?? []).join(", "),
  };
}

function draftGroupsFrom(groups: readonly GroupConfig[]): DraftGroup[] {
  return groups.map((g) => ({
    id: g.id,
    label: g.label,
    buckets: (g.rankBuckets ?? []).map(draftBucketFrom),
    aiOverlay: g.rankBucketAiOverlay ?? false,
  }));
}

function emptyBucket(): DraftBucket {
  return { label: "", description: "", minRate: "", maxRate: "", keywords: "" };
}

export function RankBucketClient({ initialGroups }: { initialGroups: GroupConfig[] }) {
  const [groups, setGroups] = useState<DraftGroup[]>(() => draftGroupsFrom(initialGroups));
  const [isPending, startTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function updateGroup(groupId: string, patch: Partial<DraftGroup>) {
    setSaved(false);
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, ...patch } : g)));
  }

  function updateBucket(groupId: string, index: number, patch: Partial<DraftBucket>) {
    setSaved(false);
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, buckets: g.buckets.map((b, i) => (i === index ? { ...b, ...patch } : b)) } : g)),
    );
  }

  function addBucket(groupId: string) {
    setSaved(false);
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, buckets: [...g.buckets, emptyBucket()] } : g)));
  }

  function removeBucket(groupId: string, index: number) {
    setSaved(false);
    setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, buckets: g.buckets.filter((_, i) => i !== index) } : g)));
  }

  function moveBucket(groupId: string, index: number, direction: -1 | 1) {
    setSaved(false);
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const target = index + direction;
        if (target < 0 || target >= g.buckets.length) return g;
        const next = [...g.buckets];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved!);
        return { ...g, buckets: next };
      }),
    );
  }

  function handleSave() {
    setSaveError(null);

    for (const g of groups) {
      const seenLabels = new Set<string>();
      for (const b of g.buckets) {
        if (b.label.trim().length === 0) {
          setSaveError(`Every bucket needs a name (group "${g.label}" has an unnamed bucket).`);
          return;
        }
        // Grill-pass fix: mirror RankBucketRuleSchema's own uniqueness
        // refine() here too, so the owner gets an immediate, in-place
        // error instead of a generic save failure from the server round-trip.
        if (seenLabels.has(b.label.trim().toLowerCase())) {
          setSaveError(`Bucket name "${b.label}" is used more than once in group "${g.label}" — names must be unique.`);
          return;
        }
        seenLabels.add(b.label.trim().toLowerCase());
        if (b.label.trim().toLowerCase() === "all") {
          setSaveError(`"All" is reserved and can't be used as a bucket name (group "${g.label}").`);
          return;
        }
        // Grill-pass fix: Number.isFinite("−5") is true, so a bare
        // finite-check let negative rates through even though the schema's
        // own RankBucketRuleSchema requires .min(0) -- match it here.
        if (b.minRate.trim() !== "" && (!Number.isFinite(Number(b.minRate)) || Number(b.minRate) < 0)) {
          setSaveError(`"${b.label}" (group "${g.label}") has an invalid minimum rate.`);
          return;
        }
        if (b.maxRate.trim() !== "" && (!Number.isFinite(Number(b.maxRate)) || Number(b.maxRate) < 0)) {
          setSaveError(`"${b.label}" (group "${g.label}") has an invalid maximum rate.`);
          return;
        }
      }
    }

    const nextGroups = initialGroups.map((g) => {
      const draft = groups.find((d) => d.id === g.id);
      if (!draft) return g;
      const rankBuckets: RankBucketRule[] = draft.buckets.map((b) => ({
        label: b.label.trim(),
        ...(b.description.trim() ? { description: b.description.trim() } : {}),
        ...(b.minRate.trim() !== "" ? { minRate: Number(b.minRate) } : {}),
        ...(b.maxRate.trim() !== "" ? { maxRate: Number(b.maxRate) } : {}),
        ...(b.keywords.trim() !== ""
          ? { keywords: b.keywords.split(",").map((k) => k.trim()).filter((k) => k.length > 0) }
          : {}),
      }));
      return { ...g, rankBuckets, rankBucketAiOverlay: draft.aiOverlay };
    });

    startTransition(async () => {
      const result = await saveConfigAction({ groups: nextGroups });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      setSaved(true);
    });
  }

  if (groups.length === 0) {
    return <p className="text-sm text-theme-text-dim">No groups configured yet — set up a group under Groups & Needs first.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-theme-text-dim">
        Rank a group's own matches into your own named buckets (e.g. "Tier 1", "Tier 2") — separate from tier and
        match band. A gig is assigned to the FIRST bucket, in the order below, whose rate/keyword rule it satisfies.
        Turn on the AI overlay to have the model suggest a different bucket (with a reason) when the simple rule
        might be missing something — you always confirm or override before it's final.
      </p>
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <fieldset key={g.id} className="flex flex-col gap-3 rounded-lg border border-theme-surface-border p-4">
            <legend className="px-1 font-theme-heading text-sm font-semibold text-theme-text">{g.label}</legend>

            <div className="flex flex-col gap-3">
              {g.buckets.map((b, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-md border border-theme-surface-border p-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Bucket name (e.g. Tier 1)"
                      value={b.label}
                      onChange={(e) => updateBucket(g.id, i, { label: e.target.value })}
                      className="flex-1 rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm text-theme-text"
                    />
                    <button type="button" disabled={i === 0} onClick={() => moveBucket(g.id, i, -1)} className="rounded px-2 py-1 text-sm text-theme-text-dim disabled:opacity-30" aria-label={`Move ${b.label || "bucket"} up`}>
                      ↑
                    </button>
                    <button type="button" disabled={i === g.buckets.length - 1} onClick={() => moveBucket(g.id, i, 1)} className="rounded px-2 py-1 text-sm text-theme-text-dim disabled:opacity-30" aria-label={`Move ${b.label || "bucket"} down`}>
                      ↓
                    </button>
                    <button type="button" onClick={() => removeBucket(g.id, i)} className="rounded px-2 py-1 text-sm text-theme-tier-red" aria-label={`Remove ${b.label || "bucket"}`}>
                      Remove
                    </button>
                  </div>
                  <input
                    type="text"
                    placeholder="Plain-English description (used by the AI overlay, e.g. 'Series B+, remote-first')"
                    value={b.description}
                    onChange={(e) => updateBucket(g.id, i, { description: e.target.value })}
                    className="rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm text-theme-text"
                  />
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="number"
                      placeholder="Min rate"
                      value={b.minRate}
                      onChange={(e) => updateBucket(g.id, i, { minRate: e.target.value })}
                      className="w-28 rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm text-theme-text"
                    />
                    <input
                      type="number"
                      placeholder="Max rate"
                      value={b.maxRate}
                      onChange={(e) => updateBucket(g.id, i, { maxRate: e.target.value })}
                      className="w-28 rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm text-theme-text"
                    />
                    <input
                      type="text"
                      placeholder="Keywords, comma-separated"
                      value={b.keywords}
                      onChange={(e) => updateBucket(g.id, i, { keywords: e.target.value })}
                      className="flex-1 rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1 text-sm text-theme-text"
                    />
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => addBucket(g.id)}
                className="self-start rounded-md border border-theme-surface-border px-3 py-1.5 text-sm text-theme-text-dim hover:bg-theme-surface-raised"
              >
                + Add bucket
              </button>
            </div>

            <label className="flex items-center gap-2 text-sm text-theme-text">
              <input type="checkbox" checked={g.aiOverlay} onChange={(e) => updateGroup(g.id, { aiOverlay: e.target.checked })} />
              AI-suggested overlay (reviews the rule-based bucket, may suggest a different one for you to confirm)
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
