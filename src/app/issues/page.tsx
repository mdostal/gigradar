import { listIssues } from "@/lib/notify/issues";
import { IssuesClient } from "./issues-client";

// Single-user local app, no CDN — see src/app/page.tsx's header comment for
// the full reasoning. Here specifically: raiseIssue() is called only from
// the standalone scheduler process, which has no revalidatePath() path at
// all — resolving an issue already revalidates this route, but nothing ever
// revalidated it for a newly-raised one, so a fresh issue was invisible
// until an unrelated dashboard mutation happened to also touch this route.
export const dynamic = "force-dynamic";

// Notifications-epic's dashboard surface — a Server Component reading
// listIssues() directly (mirrors src/app/drafts/page.tsx's own "fetch
// once, render" shape). Open issues first (what needs attention right
// now), resolved issues below as a secondary/collapsed section.
export default function IssuesPage() {
  const open = listIssues({ open: true });
  const resolved = listIssues({ open: false });

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold tracking-tight text-theme-text">Issues</h1>
      <p className="text-sm text-theme-text-dim">
        {open.length === 0 ? "Nothing needs attention right now." : `${open.length} open issue${open.length === 1 ? "" : "s"}.`}
      </p>
      <IssuesClient open={open} resolved={resolved} />
    </main>
  );
}
