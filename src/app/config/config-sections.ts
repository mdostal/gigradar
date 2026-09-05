// config-dashboard-and-section-pages story: the single source of truth for
// the 6 real config sections — shared between the collapsible sidebar
// (config-sidebar.tsx) and the dashboard home's card grid (page.tsx) so
// the two navigation surfaces can never drift out of sync with each other.
//
// config-detail-and-scan-hardening epic, config-dashboard-rich-cards story:
// `summary()` (a single line) replaced by `details()` (a real, multi-row
// breakdown) — owner's own screenshot comparison against the approved
// "Concept C" design: the shipped cards were far sparser than what was
// designed and confirmed ("this is what i asked for -- not [this]").
// Every row here traces to a real field on `ConfigPageData` — nothing
// fabricated, nothing hardcoded, matching the reasoning `status()` already
// used before this story.
import type { ConfigSection } from "./config-client";
import type { ConfigPageData } from "./config-data";
import { computeProfileComplete, computeSourceCounts } from "@/lib/status/status-strip";
import { describeCron } from "@/lib/schedule/describe-cron";
import {
  DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT,
  DEFAULT_NEAR_BAND_TOLERANCE_PCT,
  resolveHideOutOfBandByDefault,
  resolveNearBandTolerancePct,
} from "@/lib/matching/match-band";
import type { EngagementProfile } from "@/lib/types";

export interface ConfigDetailRow {
  label: string;
  value: string;
}

export interface ConfigSectionMeta {
  id: ConfigSection;
  label: string;
  href: string;
  /** Real, computed detail rows — one line each, shown on the dashboard card. Never a placeholder or fabricated value. */
  details: (data: ConfigPageData) => ConfigDetailRow[];
  /** "ok" (checkmark), "warn" (amber, needs a look), "danger" (Auto-fire's own distinct treatment), "neutral" (nothing to flag either way, e.g. Appearance). */
  status: (data: ConfigPageData) => "ok" | "warn" | "danger" | "neutral";
}

/** "$150+/hr" for an hourly profile, "$250k-$400k TC" for a salaried one — real minRate/highRate, never invented numbers. */
function formatRateRange(profile: EngagementProfile): string {
  if (profile.rateUnit === "year") {
    const fmtK = (n: number) => `$${Math.round(n / 1000)}k`;
    return profile.highRate > profile.minRate ? `${fmtK(profile.minRate)}-${fmtK(profile.highRate)} TC` : `${fmtK(profile.minRate)}+ TC`;
  }
  return profile.highRate > profile.minRate ? `$${profile.minRate}-${profile.highRate}/hr` : `$${profile.minRate}+/hr`;
}

/** One row per group's real rate range(s) — a group can carry more than one engagement profile, each formatted and joined. */
function groupRateSummary(profiles: readonly EngagementProfile[]): string {
  if (profiles.length === 0) return "no rate profile configured";
  return profiles.map(formatRateRange).join(" / ");
}

export const CONFIG_SECTIONS: readonly ConfigSectionMeta[] = [
  {
    id: "profile",
    label: "Profile",
    href: "/config/profile",
    details: (data) => {
      const p = data.initial.profile;
      if (!p.name) return [{ label: "Name", value: "Not filled in yet" }];
      const rows: ConfigDetailRow[] = [
        { label: "Name", value: p.name },
        { label: "Roles", value: p.roles.slice(0, 2).join(", ") || "None set" },
      ];
      if (data.initial.applyProfile?.rateAnchor) rows.push({ label: "Rate anchor", value: `$${data.initial.applyProfile.rateAnchor}/hr` });
      if (p.homeBase?.city) rows.push({ label: "Home base", value: p.homeBase.city });
      if (p.timezone) rows.push({ label: "Timezone", value: p.timezone });
      return rows;
    },
    status: (data) => (computeProfileComplete(data.initial as unknown as Record<string, unknown>) ? "ok" : "warn"),
  },
  {
    id: "sources",
    label: "Sources",
    href: "/config/sources",
    details: (data) => {
      const { configured } = computeSourceCounts(data.initial as unknown as Record<string, unknown>);
      const readiness = Object.values(data.sessionReadiness);
      const healthy = readiness.filter((r) => r === "connected" || r === "no-login-needed").length;
      const needsLogin = readiness.filter((r) => r === "needs-login").length;
      const rows: ConfigDetailRow[] = [{ label: "Configured", value: String(configured) }];
      if (readiness.length > 0) {
        rows.push({ label: "Healthy", value: String(healthy) });
        if (needsLogin > 0) rows.push({ label: "Needs login", value: String(needsLogin) });
      }
      return rows;
    },
    status: (data) => (computeSourceCounts(data.initial as unknown as Record<string, unknown>).needingAttention > 0 ? "warn" : "ok"),
  },
  {
    id: "groups",
    label: "Groups & Needs",
    href: "/config/groups",
    details: (data) => {
      if (data.initial.groups.length === 0) return [{ label: "Groups", value: "None configured" }];
      return data.initial.groups.map((g) => ({
        label: g.label,
        value: `${groupRateSummary(g.needs.engagementProfiles)} · AI-verify ${g.aiVerify ? "on" : "off"}`,
      }));
    },
    status: (data) => (data.initial.groups.every((g) => g.needs.engagementProfiles.length > 0) ? "ok" : "warn"),
  },
  {
    id: "match-quality",
    label: "Match Quality",
    href: "/config/match-quality",
    details: (data) => {
      if (data.initial.groups.length === 0) return [{ label: "Match Quality", value: "None configured" }];
      return data.initial.groups.map((g) => ({
        label: g.label,
        value: `${resolveNearBandTolerancePct(g)}% tolerance · hide out-of-band ${resolveHideOutOfBandByDefault(g) ? "on" : "off"}`,
      }));
    },
    // "neutral" (nothing to flag) when every group's RESOLVED values still
    // match the documented defaults; "ok" once at least one group's real
    // value actually differs. Compares resolved values, not
    // `matchQuality`'s mere presence (grill-pass fix) -- match-quality-
    // client.tsx's Save always writes a full object for every group, so a
    // no-op Save (defaults, re-saved unchanged) must never flip this to
    // "ok" -- same "distinguishable from an untouched default" signal
    // Automation's own status() already gives kill-switch/rules.
    status: (data) =>
      data.initial.groups.some(
        (g) => resolveNearBandTolerancePct(g) !== DEFAULT_NEAR_BAND_TOLERANCE_PCT || resolveHideOutOfBandByDefault(g) !== DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT,
      )
        ? "ok"
        : "neutral",
  },
  {
    id: "schedule",
    label: "Schedule",
    href: "/config/schedule",
    details: (data) => {
      if (!data.initial.schedule) return [{ label: "Schedule", value: "Not set — runs on-demand only" }];
      const described = describeCron(data.initial.schedule);
      return [{ label: described ? "Runs" : "Cron", value: described ?? data.initial.schedule }];
    },
    status: (data) => (data.initial.schedule ? "ok" : "neutral"),
  },
  {
    id: "automation",
    label: "Automation",
    href: "/config/automation",
    details: (data) => {
      const rules = data.initial.autoFire?.rules ?? [];
      const armed = rules.filter((r) => r.enabled).length;
      const killSwitch = data.initial.autoFire?.killSwitch ?? false;
      return [
        { label: "Kill switch", value: killSwitch ? "Engaged — nothing can fire" : "Off" },
        { label: "Rules", value: `${armed} of ${rules.length} armed` },
      ];
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
    details: () => [{ label: "Appearance", value: "Icon & theme" }],
    status: () => "neutral",
  },
] as const;
