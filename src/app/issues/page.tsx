import { readRawConfig } from "@/lib/config/save";
import { listIssues } from "@/lib/notify/issues";
import { SOURCE_ORIGINS } from "@/lib/sources/origins";
import { IssuesClient } from "./issues-client";

/**
 * Same eligibility rule as /config's own `showsCaptureLogin()`
 * (config-client.tsx): every `SOURCE_ORIGINS`-registered source, OR a
 * custom source explicitly declared `settings.customAuth: "browser-session"`
 * — read from the RAW (unresolved) config document, never `loadConfig()`
 * (CLAUDE.md's Secret handling contract: this is a read-only UI-gating
 * check, not the pipeline runner). Reused here so a "Source fetch failed" /
 * "Needs human verification" issue on one of these sources can offer an
 * inline "Capture login" action, not just "Resolve."
 */
function captureEligibleSourceIds(): string[] {
  const raw = readRawConfig();
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const ids: string[] = [];
  for (const s of sources) {
    if (typeof s !== "object" || s === null) continue;
    const entry = s as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : undefined;
    if (!id) continue;
    const settings = typeof entry.settings === "object" && entry.settings !== null ? (entry.settings as Record<string, unknown>) : undefined;
    if (id in SOURCE_ORIGINS || settings?.customAuth === "browser-session") ids.push(id);
  }
  return ids;
}

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
      <IssuesClient open={open} resolved={resolved} captureEligibleSourceIds={captureEligibleSourceIds()} />
    </main>
  );
}
