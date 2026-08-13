import { readRawConfig } from "@/lib/config/save";
import { listDrafts, listGigs } from "@/lib/store";
import { DashboardClient } from "./dashboard-client";
import { computeStatusStrip } from "@/lib/status/status-strip";

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
export default function HomePage() {
  const gigs = listGigs();
  const rawConfig = readRawConfig();
  const status = computeStatusStrip(gigs, rawConfig);
  // `draft-review-ui` story: which gigs already have a draft (any status) —
  // purely a "Generate draft" vs "Regenerate draft" button label choice on
  // the row (dashboard-draft.ts's draftButtonLabel()), never a visibility
  // gate (that's tier-only, canGenerateDraft()). Cheap: listDrafts() has no
  // pagination either, same tradeoff listGigs() already accepts here.
  const draftedGigKeys = new Set(listDrafts().map((d) => d.gigKey));

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">gigradar</h1>
      <p className="text-sm text-slate-500">
        {gigs.length} gig{gigs.length === 1 ? "" : "s"} tracked.
      </p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
        <span>{status.sourcesLabel}</span>
        <span>{status.profileLabel}</span>
        <span>{status.lastScanLabel}</span>
      </div>
      <DashboardClient gigs={gigs} draftedGigKeys={draftedGigKeys} />
    </main>
  );
}
