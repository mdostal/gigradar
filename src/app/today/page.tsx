import { TodayClient } from "./today-client";
import { loadDashboardData } from "../dashboard-data";

// gigradar-command-center epic, daily-shortlist-page story. Same
// force-dynamic reasoning as "/"'s own page.tsx (the standalone scheduler
// process writes gigs/drafts with no Next.js request context, so this
// route must never cache) and the same loadDashboardData() data source --
// /today is a different VIEW of the same real gig data, never a second
// data model.
export const dynamic = "force-dynamic";

export default function TodayPage() {
  const { gigs, engagementProfiles, draftedGigKeys, prepByGigKey } = loadDashboardData();

  return <TodayClient gigs={gigs} draftedGigKeys={draftedGigKeys} initialPrepByGigKey={prepByGigKey} engagementProfiles={engagementProfiles} />;
}
