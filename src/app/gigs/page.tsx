import { readRawConfig } from "@/lib/config/save";
import { DashboardClient } from "../dashboard-client";
import { SyncStatusDropdown } from "../sync-status-dropdown";
import { SonarSweepHeader } from "../sonar-sweep-header";
import { sweepNowAction } from "../actions";
import { SYNC_STATUS_SOURCES } from "../sync-status-registry";
import { loadDashboardData, resolveHideOutOfBandDefault } from "../dashboard-data";

// gigradar is a single-user, 127.0.0.1-bound local app with no CDN/edge cache
// in front of it — static optimization here has no benefit and one real cost:
// gigs/drafts written by the standalone scheduler process (which has no
// Next.js request context and so can never call revalidatePath()) would
// otherwise be invisible until an unrelated in-app mutation happened to
// revalidate this route. force-dynamic removes the cache entirely rather than
// chasing every write path with a revalidatePath() call.
export const dynamic = "force-dynamic";

// dashboard-drafts-data-integrity epic, relocate-giglist-to-all-gigs story.
// Relocated verbatim from "/" (src/app/page.tsx) — the owner's own
// correction: "the table view IS NOT THE DASHBOARD -- that is our giglist
// or all gigs -- dashboard is a mix of metrics, charts, the last scan,
// etc." "/" now redirects here; dashboard-overview-page (depends on this
// story) builds the real Dashboard at "/". Zero behavior change vs. the
// route this replaces — same DashboardClient, same loadDashboardData(),
// same default sort (listGigs()'s own first_seen DESC).
//
// multi-group-architecture epic, Slice 3: this is the "All groups"
// unscoped view specifically — see src/app/[group]/gigs/page.tsx for the
// per-group equivalent. Both routes share their data-assembly logic via
// dashboard-data.ts's loadDashboardData(), called here with no groupId
// (every gig, byte-identical to this page's own pre-relocation behavior).
export default function AllGigsPage() {
  const { gigs, status, lastScanIso, engagementProfiles, draftedGigKeys, prepByGigKey } = loadDashboardData();
  // Computed once, server-side — see sonar-sweep-header.tsx's own header
  // comment on why (a client component calling Date.now() itself during
  // render would produce a hydration-mismatch, the exact bug metrics/
  // page.tsx already hit and documented once).
  const now = Date.now();
  // rate-band-match-quality epic: the primary group's own real setting,
  // same anchoring convention every other unscoped-route default uses.
  const hideOutOfBandDefault = resolveHideOutOfBandDefault(readRawConfig());

  return (
    <main className="mx-auto max-w-[88rem] p-6">
      <SonarSweepHeader status={status} lastScanIso={lastScanIso} now={now} sweepAction={sweepNowAction} />

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-theme-heading text-2xl font-bold tracking-tight text-theme-text">All Gigs</h1>
        <p className="font-theme-mono text-sm text-theme-text-dim">
          {gigs.length} gig{gigs.length === 1 ? "" : "s"} tracked
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 font-theme-mono text-xs uppercase tracking-wide text-theme-text-dim">
        <SyncStatusDropdown sources={SYNC_STATUS_SOURCES} />
      </div>
      <DashboardClient
        gigs={gigs}
        draftedGigKeys={draftedGigKeys}
        initialPrepByGigKey={prepByGigKey}
        engagementProfiles={engagementProfiles}
        hideOutOfBandDefault={hideOutOfBandDefault}
      />
    </main>
  );
}
