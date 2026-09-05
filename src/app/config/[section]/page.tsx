import { notFound } from "next/navigation";
import { loadConfigPageData } from "../config-data";
import { CONFIG_SECTIONS } from "../config-sections";
import { ConfigClient, type ConfigSection } from "../config-client";
import { MatchQualityClient } from "../match-quality-client";

// config-dashboard-and-section-pages story: one real, dedicated page per
// config section (/config/profile, /config/sources, /config/groups,
// /config/schedule, /config/automation, /config/appearance) — both the
// sidebar's own link and the dashboard home's card for a section land
// here, on the SAME page, never an inline expand/accordion. Mounts the
// SAME ConfigClient the old single-page form used, with `activeSection`
// set so only that one section's already-individually-wrapped <section>
// block renders — the field logic/validation/draft-state/save action
// itself is completely unchanged, only what's visible per route changed.
export const dynamic = "force-dynamic";

const VALID_SECTIONS = new Set(CONFIG_SECTIONS.map((s) => s.id));

export default async function ConfigSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!VALID_SECTIONS.has(section as ConfigSection)) notFound();
  const activeSection = section as ConfigSection;

  const data = await loadConfigPageData();
  const label = CONFIG_SECTIONS.find((s) => s.id === activeSection)?.label ?? activeSection;

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="font-theme-heading text-2xl font-bold tracking-tight text-theme-text">{label}</h1>
      {activeSection === "match-quality" ? (
        // rate-band-match-quality epic: a small, standalone component,
        // deliberately NOT routed through ConfigClient (already 3000+
        // lines) -- see match-quality-client.tsx's own header comment.
        <MatchQualityClient initialGroups={data.initial.groups} />
      ) : (
        <ConfigClient
          initial={data.initial}
          portunusAvailable={data.portunusAvailable}
          sessionReadiness={data.sessionReadiness}
          sourcesWithOpenIssues={data.sourcesWithOpenIssues}
          activeSection={activeSection}
        />
      )}
    </main>
  );
}
