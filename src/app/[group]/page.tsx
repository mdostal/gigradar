import { notFound } from "next/navigation";
import { readRawConfig } from "@/lib/config/save";
import { DashboardClient } from "../dashboard-client";
import { SyncStatusButton } from "../sync-status-button";
import { reconcileGoFractionalStatusesAction, reconcileWellfoundStatusesAction } from "../actions";
import { loadDashboardData, resolveGroupLabel } from "../dashboard-data";

// multi-group-architecture epic, Slice 3. The per-group dashboard — the
// SAME DashboardClient the unscoped "/" route renders, just fed a
// groupId-scoped gig set (dashboard-data.ts's loadDashboardData(),
// shared with page.tsx so both routes assemble props identically). A gig
// matching multiple groups appears on each one's page — same row, same
// key, same status, per the owner's own "apply once" requirement
// (design-discussion.md).
//
// force-dynamic for the same reason page.tsx's own header comment gives:
// gigs/drafts written by the standalone scheduler process (no Next.js
// request context, can never revalidatePath()) must never be hidden
// behind a cache.
export const dynamic = "force-dynamic";

export default async function GroupDashboardPage({ params }: { params: Promise<{ group: string }> }) {
  const { group: groupId } = await params;
  const rawConfig = readRawConfig();
  const groupLabel = resolveGroupLabel(rawConfig, groupId);
  if (groupLabel === undefined) notFound();

  const { gigs, status, engagementProfiles, draftedGigKeys, prepByGigKey } = loadDashboardData(groupId);

  return (
    <main className="mx-auto max-w-[88rem] p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-theme-text">{groupLabel}</h1>
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
