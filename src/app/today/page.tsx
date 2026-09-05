import { readRawConfig } from "@/lib/config/save";
import { TodayClient } from "./today-client";
import { loadDashboardData, resolveHideOutOfBandDefault } from "../dashboard-data";

// gigradar-command-center epic, daily-shortlist-page story. Same
// force-dynamic reasoning as "/"'s own page.tsx (the standalone scheduler
// process writes gigs/drafts with no Next.js request context, so this
// route must never cache) and the same loadDashboardData() data source --
// /today is a different VIEW of the same real gig data, never a second
// data model.
export const dynamic = "force-dynamic";

export default function TodayPage() {
  const { gigs, engagementProfiles, draftedGigKeys, prepByGigKey } = loadDashboardData();
  // rate-band-match-quality epic: real, owner-tunable per-group setting
  // (the primary group's own, same anchoring convention every other
  // unscoped-route default already uses), never a hardcoded true/false.
  const hideOutOfBandDefault = resolveHideOutOfBandDefault(readRawConfig());

  return (
    <TodayClient
      gigs={gigs}
      draftedGigKeys={draftedGigKeys}
      initialPrepByGigKey={prepByGigKey}
      engagementProfiles={engagementProfiles}
      hideOutOfBandDefault={hideOutOfBandDefault}
    />
  );
}
