import { getGig, listDrafts } from "@/lib/store";
import { DraftsClient } from "./drafts-client";
import type { DraftListItem } from "./drafts-filter";

// Single-user local app, no CDN — see src/app/page.tsx's header comment.
// Here specifically: the scheduler's auto-draft/auto-fire path writes drafts
// from outside any Next.js request, so this route needs the same fix as
// dashboard/issues even though in-app draft edits already revalidate it.
export const dynamic = "force-dynamic";

// The review/approve UI (`draft-review-ui` story, `assisted-apply-drafting`
// epic) — a Server Component that reads every draft via listDrafts() (see
// src/lib/store/drafts.ts) and, for each, its linked gig via getGig() (the
// real title/company/URL a StoredDraft alone doesn't carry — only its
// gig_key). Status filtering happens client-side (drafts-filter.ts),
// mirroring the dashboard's own "fetch once, filter client-side" tradeoff
// (src/app/page.tsx / dashboard-filter.ts) at the same acceptable scale.
//
// `gig_key` is a real, enforced foreign key (`PRAGMA foreign_keys = ON`,
// src/lib/store/db.ts) and this codebase has no gig-deletion path, so
// getGig() "should" never return undefined for a persisted draft — the
// filter below is defensive, not expected to ever actually drop a row.
export default function DraftsPage() {
  const drafts = listDrafts();
  const items: DraftListItem[] = drafts.flatMap((draft) => {
    const gig = getGig(draft.gigKey);
    if (!gig) return [];
    return [
      {
        gigKey: draft.gigKey,
        content: draft.content,
        status: draft.status,
        generatedAt: draft.generatedAt,
        approvedAt: draft.approvedAt,
        submittedAt: draft.submittedAt,
        gigTitle: gig.title,
        gigCompany: gig.company,
        gigUrl: gig.url,
      },
    ];
  });

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Drafts</h1>
      <p className="text-sm text-slate-500">
        {items.length} draft{items.length === 1 ? "" : "s"}.
      </p>
      <DraftsClient items={items} />
    </main>
  );
}
