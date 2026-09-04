import Link from "next/link";
import { loadConfigPageData } from "./config-data";
import { CONFIG_SECTIONS } from "./config-sections";
import { TauriVersionReadout } from "./tauri-version-readout";

// config-dashboard-and-section-pages story: the real Config Dashboard home
// — owner's own verbatim synthesis: "maintain the top level view of the
// config to have a config dashboard like the nice card design." Ported
// from Concept C (Artifact 0bb8af7b-cb7d-47ec-a54c-d55b984371ba) — a card
// per section, each a compact real-data summary, clicking through to that
// section's own full page (the SAME destination the sidebar's own link
// for that section goes to). Auto-fire keeps a visibly distinct, more-
// serious card treatment (a hazard-stripe top edge) — this section can
// trigger real applications, it should never look as casual as Appearance.
export const dynamic = "force-dynamic";

const STATUS_BADGE_CLASS: Record<"ok" | "warn" | "danger" | "neutral", string> = {
  ok: "bg-theme-tier-green/15 text-theme-tier-green",
  warn: "bg-theme-tier-yellow/15 text-theme-tier-yellow",
  danger: "bg-theme-tier-red/15 text-theme-tier-red",
  neutral: "bg-theme-surface-raised text-theme-text-dim",
};

const STATUS_LABEL: Record<"ok" | "warn" | "danger" | "neutral", string> = {
  ok: "Ready",
  warn: "Needs attention",
  danger: "Armed",
  neutral: "—",
};

export default async function ConfigDashboardPage() {
  const data = await loadConfigPageData();

  return (
    <main className="mx-auto max-w-6xl p-6">
      <h1 className="font-theme-heading text-2xl font-bold tracking-tight text-theme-text">Config Dashboard</h1>
      <p className="text-sm text-theme-text-dim">{data.subtitle}</p>
      <TauriVersionReadout />

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CONFIG_SECTIONS.map((section) => {
          const status = section.status(data);
          const isAutomation = section.id === "automation";
          return (
            <Link
              key={section.id}
              href={section.href}
              className={`relative flex flex-col gap-2 overflow-hidden rounded-lg border p-4 transition-colors hover:bg-theme-surface-raised ${
                isAutomation && status === "danger"
                  ? "border-theme-tier-red/40 bg-theme-tier-red/5"
                  : "border-theme-surface-border bg-theme-surface"
              }`}
            >
              {isAutomation && status === "danger" && (
                <div
                  className="absolute inset-x-0 top-0 h-1"
                  style={{ background: "repeating-linear-gradient(135deg, var(--tier-yellow) 0 8px, transparent 8px 16px)" }}
                  aria-hidden="true"
                />
              )}
              <div className="flex items-center justify-between">
                <span className="font-theme-heading text-sm font-semibold text-theme-text">{section.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATUS_BADGE_CLASS[status]}`}>
                  {STATUS_LABEL[status]}
                </span>
              </div>
              <dl className="flex flex-col gap-0.5">
                {section.details(data).map((row, i) => (
                  // grill pass (config-detail-and-scan-hardening epic): row.label alone
                  // isn't a safe key -- e.g. two groups can share the same label (only
                  // `id` is constrained unique on GroupConfig), so index is folded in.
                  <div key={`${row.label}-${i}`} className="flex items-baseline justify-between gap-2 font-theme-mono text-xs">
                    <dt className="text-theme-text-dim">{row.label}</dt>
                    <dd className="truncate text-right text-theme-text-dim">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
