import { SonarSweepHeader } from "./sonar-sweep-header";
import { DashboardOverviewClient } from "./dashboard-overview-client";
import { sweepNowAction } from "./actions";
import { loadDashboardData } from "./dashboard-data";
import { listDrafts } from "@/lib/store";

// Same force-dynamic reasoning as every other data-reading route in this
// app (the standalone scheduler process writes gigs/drafts with no
// Next.js request context, so this route must never cache stale data).
export const dynamic = "force-dynamic";

// dashboard-drafts-data-integrity epic, dashboard-overview-page story. The
// real Dashboard -- owner's own correction: "the table view IS NOT THE
// DASHBOARD -- that is our giglist or all gigs -- dashboard is a mix of
// metrics, charts, the last scan, etc." Depends on (and mounts) the two
// stories that cleared the ground for this: the sonar-sweep header
// (sonar-sweep-header-widget) and the giglist's relocation to /gigs
// (relocate-giglist-to-all-gigs). See dashboard-overview-client.tsx for
// the glance-tiles/Today/metrics-teaser composition itself.
export default function HomePage() {
  const { gigs, status, lastScanIso } = loadDashboardData();
  const drafts = listDrafts();
  const now = Date.now();

  return (
    <main className="mx-auto max-w-[88rem] p-6">
      <SonarSweepHeader status={status} lastScanIso={lastScanIso} now={now} sweepAction={sweepNowAction} />
      <DashboardOverviewClient gigs={gigs} drafts={drafts} now={now} />
    </main>
  );
}
