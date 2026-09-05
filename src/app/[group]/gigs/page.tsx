import { notFound } from "next/navigation";
import { readRawConfig } from "@/lib/config/save";
import { DashboardClient } from "../../dashboard-client";
import { SyncStatusDropdown } from "../../sync-status-dropdown";
import { SonarSweepHeader } from "../../sonar-sweep-header";
import { sweepNowAction } from "../../actions";
import { SYNC_STATUS_SOURCES } from "../../sync-status-registry";
import { loadDashboardData, resolveGroupLabel, resolveHideOutOfBandDefault } from "../../dashboard-data";

// dashboard-drafts-data-integrity epic, relocate-giglist-to-all-gigs story.
// Relocated verbatim from src/app/[group]/page.tsx — the per-group mirror
// of src/app/gigs/page.tsx's own relocation; see that file's header
// comment for why. force-dynamic for the same reason every other
// data-reading route in this app needs it (the standalone scheduler
// process writes gigs/drafts with no Next.js request context, so this
// route must never cache stale data).
export const dynamic = "force-dynamic";

export default async function GroupAllGigsPage({ params }: { params: Promise<{ group: string }> }) {
  const { group: groupId } = await params;
  const rawConfig = readRawConfig();
  const groupLabel = resolveGroupLabel(rawConfig, groupId);
  if (groupLabel === undefined) notFound();

  const { gigs, status, lastScanIso, engagementProfiles, draftedGigKeys, prepByGigKey } = loadDashboardData(groupId);
  const now = Date.now();
  // rate-band-match-quality epic: THIS specific group's own real setting.
  const hideOutOfBandDefault = resolveHideOutOfBandDefault(rawConfig, groupId);

  return (
    <main className="mx-auto max-w-[88rem] p-6">
      <SonarSweepHeader status={status} lastScanIso={lastScanIso} now={now} sweepAction={sweepNowAction} />

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-theme-heading text-2xl font-bold tracking-tight text-theme-text">{groupLabel} — All Gigs</h1>
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
        groupId={groupId}
        hideOutOfBandDefault={hideOutOfBandDefault}
      />
    </main>
  );
}
