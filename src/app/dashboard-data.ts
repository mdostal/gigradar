// multi-group-architecture epic, Slice 3. Shared between src/app/page.tsx
// (the unscoped "All groups" dashboard) and src/app/[group]/page.tsx (a
// single group's dashboard) so both routes assemble their
// DashboardClient props through the exact same logic -- no parallel copy
// to drift out of sync. `groupId` omitted/undefined means "every group"
// (today's pre-Slice-3 behavior, unchanged).
import { readRawConfig } from "@/lib/config/save";
import { listDrafts, listGigs, listInterviewPrep } from "@/lib/store";
import type { StoredGig } from "@/lib/store";
import type { PrepPacketContent } from "@/lib/apply/prep";
import { computeStatusStrip, type StatusStripView } from "@/lib/status/status-strip";

export interface DashboardData {
  gigs: StoredGig[];
  status: StatusStripView;
  engagementProfiles: { id: string; label: string }[];
  draftedGigKeys: Set<string>;
  prepByGigKey: Record<string, PrepPacketContent>;
}

/**
 * Extracts just `{id, label}` for one group's configured engagement
 * profiles from the RAW (unresolved, no-secrets-possible) config document.
 * `readRawConfig()` returns `Record<string, unknown>`, so this is a
 * defensive, tolerant extraction: a missing/malformed
 * `groups[].needs.engagementProfiles` (first-run, no config yet, an
 * unexpected shape) yields `[]` rather than throwing — the dashboard's own
 * Profile column/filter degrades to "no profiles configured" instead of
 * crashing the page.
 *
 * `groupId` omitted (the `/` route) reads the FIRST/primary group — same
 * single-group convention every other pre-Slice-3 UI surface used;
 * `groupId` given (the `/[group]/` route) reads that SPECIFIC group by id,
 * never assuming it's first.
 */
export function extractEngagementProfileSummaries(rawConfig: Record<string, unknown>, groupId?: string): { id: string; label: string }[] {
  const groups = rawConfig.groups;
  if (!Array.isArray(groups)) return [];
  const group = groupId ? groups.find((g) => typeof g === "object" && g !== null && (g as Record<string, unknown>).id === groupId) : groups[0];
  if (typeof group !== "object" || group === null) return [];
  const needs = (group as Record<string, unknown>).needs;
  if (typeof needs !== "object" || needs === null) return [];
  const profiles = (needs as Record<string, unknown>).engagementProfiles;
  if (!Array.isArray(profiles)) return [];
  const result: { id: string; label: string }[] = [];
  for (const p of profiles) {
    if (typeof p !== "object" || p === null) continue;
    const { id, label } = p as Record<string, unknown>;
    if (typeof id === "string" && typeof label === "string") result.push({ id, label });
  }
  return result;
}

/**
 * Resolves `groupId` (a `/[group]/` route param) against
 * `config.groups[].id` — never a slug re-derived from `label` (which the
 * owner can freely rename; see `GroupConfig.id`'s own doc comment in
 * types.ts). Returns `undefined` for an id with no matching configured
 * group (a stale bookmark after the group was renamed/removed, or a
 * genuinely wrong URL) — `[group]/page.tsx` treats that as a real 404,
 * not a silently-empty dashboard.
 */
export function resolveGroupLabel(rawConfig: Record<string, unknown>, groupId: string): string | undefined {
  const groups = rawConfig.groups;
  if (!Array.isArray(groups)) return undefined;
  const group = groups.find((g) => typeof g === "object" && g !== null && (g as Record<string, unknown>).id === groupId);
  if (typeof group !== "object" || group === null) return undefined;
  const label = (group as Record<string, unknown>).label;
  return typeof label === "string" ? label : undefined;
}

/**
 * Assembles everything DashboardClient needs — no server-side pagination
 * (see page.tsx's own long-standing header comment on why that's an
 * accepted tradeoff at current scale; unchanged by this scoping). Drafts/
 * prep packets are read UNSCOPED regardless of `groupId` — harmless
 * (DashboardClient only ever looks up entries for gigs it's actually
 * rendering, and `gigs` itself is already correctly scoped below), and
 * avoids adding new group-scoping logic to store layers that have no
 * other reason to need it.
 */
export function loadDashboardData(groupId?: string): DashboardData {
  const gigs = listGigs(groupId ? { groupId } : {});
  const rawConfig = readRawConfig();
  const status = computeStatusStrip(gigs, rawConfig);
  const engagementProfiles = extractEngagementProfileSummaries(rawConfig, groupId);
  const draftedGigKeys = new Set(listDrafts().map((d) => d.gigKey));
  const prepByGigKey: Record<string, PrepPacketContent> = {};
  for (const p of listInterviewPrep()) prepByGigKey[p.gigKey] = p.content;
  return { gigs, status, engagementProfiles, draftedGigKeys, prepByGigKey };
}
