import { listIssues } from "@/lib/notify/issues";
import { IssuesClient } from "./issues-client";

// Notifications-epic's dashboard surface — a Server Component reading
// listIssues() directly (mirrors src/app/drafts/page.tsx's own "fetch
// once, render" shape). Open issues first (what needs attention right
// now), resolved issues below as a secondary/collapsed section.
export default function IssuesPage() {
  const open = listIssues({ open: true });
  const resolved = listIssues({ open: false });

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">Issues</h1>
      <p className="text-sm text-slate-500">
        {open.length === 0 ? "Nothing needs attention right now." : `${open.length} open issue${open.length === 1 ? "" : "s"}.`}
      </p>
      <IssuesClient open={open} resolved={resolved} />
    </main>
  );
}
