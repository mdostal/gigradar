import { notFound } from "next/navigation";
import { readRawConfig } from "@/lib/config/save";
import { listDrafts } from "@/lib/store";
import { DashboardOverviewClient } from "../dashboard-overview-client";
import { loadDashboardData, resolveGroupLabel } from "../dashboard-data";

// dashboard-drafts-data-integrity epic, dashboard-overview-page story.
// Per-group mirror of src/app/page.tsx's own real Dashboard -- see that
// file's header comment. Drafts are read unscoped (same tradeoff
// dashboard-data.ts's own loadDashboardData() already accepts for prep
// packets) since DashboardOverviewClient's metrics teaser is a
// run-rate/discovered-by-day rollup, not a per-gig list.
export const dynamic = "force-dynamic";

export default async function GroupHomePage({ params }: { params: Promise<{ group: string }> }) {
  const { group: groupId } = await params;
  const rawConfig = readRawConfig();
  const groupLabel = resolveGroupLabel(rawConfig, groupId);
  if (groupLabel === undefined) notFound();

  // sonar-sweep-header-global-masthead story: SonarSweepHeader renders once,
  // globally, from layout.tsx now -- see that file's own header comment.
  const { gigs } = loadDashboardData(groupId);
  const drafts = listDrafts();
  const now = Date.now();

  return (
    <main className="mx-auto max-w-[88rem] p-6">
      <h1 className="font-theme-heading text-2xl font-bold tracking-tight text-theme-text">{groupLabel}</h1>
      <DashboardOverviewClient gigs={gigs} drafts={drafts} now={now} gigsHref={`/${groupId}/gigs`} groupId={groupId} />
    </main>
  );
}
