// config-dashboard-and-section-pages story: the single source of truth for
// the 6 real config sections — shared between the collapsible sidebar
// (config-sidebar.tsx) and the dashboard home's card grid (page.tsx) so
// the two navigation surfaces can never drift out of sync with each other.
import type { ConfigSection } from "./config-client";
import type { ConfigPageData } from "./config-data";
import { computeProfileComplete, computeSourceCounts } from "@/lib/status/status-strip";

export interface ConfigSectionMeta {
  id: ConfigSection;
  label: string;
  href: string;
  /** One line, real config state — not a placeholder. */
  summary: (data: ConfigPageData) => string;
  /** "ok" (checkmark), "warn" (amber, needs a look), "danger" (Auto-fire's own distinct treatment), "neutral" (nothing to flag either way, e.g. Appearance). */
  status: (data: ConfigPageData) => "ok" | "warn" | "danger" | "neutral";
}

export const CONFIG_SECTIONS: readonly ConfigSectionMeta[] = [
  {
    id: "profile",
    label: "Profile",
    href: "/config/profile",
    summary: (data) => (data.initial.profile.name ? data.initial.profile.name : "Not filled in yet"),
    status: (data) => (computeProfileComplete(data.initial as unknown as Record<string, unknown>) ? "ok" : "warn"),
  },
  {
    id: "sources",
    label: "Sources",
    href: "/config/sources",
    summary: (data) => {
      const { configured, needingAttention } = computeSourceCounts(data.initial as unknown as Record<string, unknown>);
      return needingAttention > 0 ? `${configured} configured (${needingAttention} need attention)` : `${configured} configured`;
    },
    status: (data) => (computeSourceCounts(data.initial as unknown as Record<string, unknown>).needingAttention > 0 ? "warn" : "ok"),
  },
  {
    id: "groups",
    label: "Groups & Needs",
    href: "/config/groups",
    summary: (data) => `${data.initial.groups.length} group${data.initial.groups.length === 1 ? "" : "s"}`,
    status: (data) => (data.initial.groups.every((g) => g.needs.engagementProfiles.length > 0) ? "ok" : "warn"),
  },
  {
    id: "schedule",
    label: "Schedule",
    href: "/config/schedule",
    summary: (data) => (data.initial.schedule ? data.initial.schedule : "Not set — runs on-demand only"),
    status: (data) => (data.initial.schedule ? "ok" : "neutral"),
  },
  {
    id: "automation",
    label: "Automation",
    href: "/config/automation",
    summary: (data) => {
      const rules = data.initial.autoFire?.rules ?? [];
      const armed = rules.filter((r) => r.enabled).length;
      if (data.initial.autoFire?.killSwitch) return "Kill switch engaged — nothing can fire";
      return armed > 0 ? `${armed} of ${rules.length} rule${rules.length === 1 ? "" : "s"} armed` : "Off";
    },
    status: (data) => {
      const rules = data.initial.autoFire?.rules ?? [];
      const armed = rules.some((r) => r.enabled);
      return armed && !data.initial.autoFire?.killSwitch ? "danger" : "neutral";
    },
  },
  {
    id: "appearance",
    label: "Appearance",
    href: "/config/appearance",
    summary: () => "Icon & theme",
    status: () => "neutral",
  },
] as const;
