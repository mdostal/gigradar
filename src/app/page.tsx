import { DashboardClient } from "./dashboard-client";
import { SyncStatusButton } from "./sync-status-button";
import { reconcileGoFractionalStatusesAction, reconcileWellfoundStatusesAction } from "./actions";
import { loadDashboardData } from "./dashboard-data";

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
// multi-group-architecture epic, Slice 3: this is now the "All groups"
// unscoped view specifically — see src/app/[group]/page.tsx for the
// per-group equivalent. Both routes share their data-assembly logic via
// dashboard-data.ts's loadDashboardData(), called here with no groupId
// (every gig, byte-identical to this page's own pre-Slice-3 behavior).
export default function HomePage() {
  const { gigs, status, engagementProfiles, draftedGigKeys, prepByGigKey } = loadDashboardData();

  return (
    <main className="mx-auto max-w-[88rem] p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-theme-heading text-2xl font-bold tracking-tight text-theme-text">Dashboard</h1>
        <p className="font-theme-mono text-sm text-theme-text-dim">
          {gigs.length} gig{gigs.length === 1 ? "" : "s"} tracked
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 font-theme-mono text-xs uppercase tracking-wide text-theme-text-dim">
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
