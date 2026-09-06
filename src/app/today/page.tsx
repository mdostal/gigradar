import { readRawConfig } from "@/lib/config/save";
import { TodayClient } from "./today-client";
import { extractRankBucketLabels, loadDashboardData, resolveHideOutOfBandDefault, resolvePrimaryGroupId } from "../dashboard-data";

// gigradar-command-center epic, daily-shortlist-page story. Same
// force-dynamic reasoning as "/"'s own page.tsx (the standalone scheduler
// process writes gigs/drafts with no Next.js request context, so this
// route must never cache) and the same loadDashboardData() data source --
// /today is a different VIEW of the same real gig data, never a second
// data model.
export const dynamic = "force-dynamic";

export default function TodayPage() {
  const { gigs, engagementProfiles, draftedGigKeys, prepByGigKey } = loadDashboardData();
  const rawConfig = readRawConfig();
  // rate-band-match-quality epic: real, owner-tunable per-group setting
  // (the primary group's own, same anchoring convention every other
  // unscoped-route default already uses), never a hardcoded true/false.
  const hideOutOfBandDefault = resolveHideOutOfBandDefault(rawConfig);
  // rank-buckets epic: the primary group's own real bucket labels -- [] when not configured, same convention.
  const rankBucketLabels = extractRankBucketLabels(rawConfig);
  // rank-buckets epic, grill-pass fix: the real, config-order primary group's id, resolved server-side -- see resolvePrimaryGroupId()'s own header comment.
  const rankBucketGroupId = resolvePrimaryGroupId(rawConfig);

  return (
    <TodayClient
      gigs={gigs}
      draftedGigKeys={draftedGigKeys}
      initialPrepByGigKey={prepByGigKey}
      engagementProfiles={engagementProfiles}
      hideOutOfBandDefault={hideOutOfBandDefault}
      rankBucketLabels={rankBucketLabels}
      rankBucketGroupId={rankBucketGroupId}
    />
  );
}
