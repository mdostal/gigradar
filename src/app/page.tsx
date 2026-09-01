import { readRawConfig } from "@/lib/config/save";
import { listDrafts, listGigs, listInterviewPrep } from "@/lib/store";
import type { PrepPacketContent } from "@/lib/apply/prep";
import { DashboardClient } from "./dashboard-client";
import { SyncStatusButton } from "./sync-status-button";
import { reconcileGoFractionalStatusesAction, reconcileWellfoundStatusesAction } from "./actions";
import { computeStatusStrip } from "@/lib/status/status-strip";

// gigradar is a single-user, 127.0.0.1-bound local app with no CDN/edge cache
// in front of it — static optimization here has no benefit and one real cost:
// gigs/drafts written by the standalone scheduler process (which has no
// Next.js request context and so can never call revalidatePath()) would
// otherwise be invisible until an unrelated in-app mutation happened to
// revalidate this route. force-dynamic removes the cache entirely rather than
// chasing every write path with a revalidatePath() call.
export const dynamic = "force-dynamic";

// The real dashboard (dashboard-results-view story). A Server Component that
// reads the full gig set via listGigs() — no server-side filter/pagination:
// listGigs() has none today, and tier/status/search filtering all happen
// client-side over this fetched set (see dashboard-client.tsx /
// dashboard-filter.ts, and this story's spec / docs/ARCHITECTURE.md for why
// that's an acceptable tradeoff at current scale). listGigs()'s own default
// order (first_seen DESC) is exactly this view's required default sort, so
// no re-sort is needed here.
//
// Status strip (`overview-nav-status` story): "sources configured" /
// "Profile" derive from ONE new readRawConfig() call — the same
// non-resolving, ENOENT-tolerant reader config/page.tsx already uses, never
// loadConfig() (see status-strip.ts's header comment) — while "last scan"
// reuses this page's existing `gigs` fetch (MAX of lastSeen), genuinely
// free. Both computeStatusStrip() inputs tolerate the first-run / empty
// state (no config.json yet -> `{}`; zero gigs ever scanned -> `[]`)
// without throwing.
/**
 * Extracts just `{id, label}` for each configured engagement profile from
 * the RAW (unresolved, no-secrets-possible) config document — dashboard-
 * profile-grouping story. `readRawConfig()` returns `Record<string,
 * unknown>` (see this file's own header comment on why raw, never
 * `loadConfig()`), so this is a defensive, tolerant extraction: a missing/
 * malformed `groups[0].needs.engagementProfiles` (first-run, no config yet,
 * a shape this reader doesn't expect) yields `[]` rather than throwing —
 * the dashboard's own Profile column/filter degrades to "no profiles
 * configured" instead of crashing the page.
 *
 * multi-group-architecture epic: Slice 1 has no group-management UI yet —
 * this only ever reads the FIRST/primary group's needs (same single-group
 * convention as the config UI and setup wizard).
 */
function extractEngagementProfileSummaries(rawConfig: Record<string, unknown>): { id: string; label: string }[] {
  const groups = rawConfig.groups;
  if (!Array.isArray(groups)) return [];
  const group = groups[0];
  if (typeof group !== "object" || group === null) return [];
  const needs = (group as Record<string, unknown>).needs;
  if (typeof needs !== "object" || needs === null) return [];
  const profiles = (needs as Record<string, unknown>).engagementProfiles;
  if (!Array.isArray(profiles)) return [];
  const result: { id: string; label: string }[] = [];
  for (const p of profiles) {
    if (typeof p !== "object" || p === null) continue;
    const { id, label } = p as Record<string, unknown>;
    if (typeof id === "string" && typeof label === "string") result.push({ id, label });
  }
  return result;
}

export default function HomePage() {
  const gigs = listGigs();
  const rawConfig = readRawConfig();
  const status = computeStatusStrip(gigs, rawConfig);
  const engagementProfiles = extractEngagementProfileSummaries(rawConfig);
  // `draft-review-ui` story: which gigs already have a draft (any status) —
  // purely a "Generate draft" vs "Regenerate draft" button label choice on
  // the row (dashboard-draft.ts's draftButtonLabel()), never a visibility
  // gate (that's tier-only, canGenerateDraft()). Cheap: listDrafts() has no
  // pagination either, same tradeoff listGigs() already accepts here.
  const draftedGigKeys = new Set(listDrafts().map((d) => d.gigKey));
  // dashboard-redesign story, prep-packet-integration slice: owner's own
  // words, "once we apply we can see the applied, the interviewing and
  // packets etc." A prep packet already persists (interview_prep table,
  // saveInterviewPrep()) once generated, but the dashboard never LOADED
  // existing ones -- dashboard-client.tsx's prepByKey state started empty
  // every render, so a reload (or a different browser/session) made an
  // already-generated packet invisible again until "Regenerate" was
  // clicked. listInterviewPrep() has no pagination either, same accepted
  // tradeoff listGigs()/listDrafts() already make on this page.
  const prepByGigKey: Record<string, PrepPacketContent> = {};
  for (const p of listInterviewPrep()) prepByGigKey[p.gigKey] = p.content;

  return (
    <main className="mx-auto max-w-[88rem] p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-theme-text">Dashboard</h1>
        <p className="text-sm text-theme-text-dim">
          {gigs.length} gig{gigs.length === 1 ? "" : "s"} tracked
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-theme-text-dim">
        <span className="rounded-full border border-theme-surface-border bg-theme-surface px-3 py-1">{status.sourcesLabel}</span>
        <span className="rounded-full border border-theme-surface-border bg-theme-surface px-3 py-1">{status.profileLabel}</span>
        <span className="rounded-full border border-theme-surface-border bg-theme-surface px-3 py-1">{status.lastScanLabel}</span>
        <SyncStatusButton sourceLabel="GoFractional" action={reconcileGoFractionalStatusesAction} />
        <SyncStatusButton sourceLabel="Wellfound" action={reconcileWellfoundStatusesAction} />
      </div>
      <DashboardClient gigs={gigs} draftedGigKeys={draftedGigKeys} initialPrepByGigKey={prepByGigKey} engagementProfiles={engagementProfiles} />
    </main>
  );
}
