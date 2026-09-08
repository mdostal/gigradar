// multi-group-architecture epic, Slice 3. Shared between src/app/page.tsx
// (the unscoped "All groups" dashboard) and src/app/[group]/page.tsx (a
// single group's dashboard) so both routes assemble their
// DashboardClient props through the exact same logic -- no parallel copy
// to drift out of sync. `groupId` omitted/undefined means "every group"
// (today's pre-Slice-3 behavior, unchanged).
import { readRawConfig } from "@/lib/config/save";
import { getLastScanCycle, getLastSeenMax, listDrafts, listGigs, listInterviewPrep } from "@/lib/store";
import type { StoredGig } from "@/lib/store";
import type { PrepPacketContent } from "@/lib/apply/prep";
import { computeLastScanIso, computeStatusStrip, type StatusStripView } from "@/lib/status/status-strip";
import { DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT } from "@/lib/matching/match-band";
import { z } from "zod";
import { explainProfileMismatch, type ProfileMismatchKind } from "@/lib/matching/gate";
import { EngagementProfileSchema } from "@/lib/config/schema";
import type { EngagementProfile } from "@/lib/types";

export interface DashboardData {
  gigs: StoredGig[];
  status: StatusStripView;
  /** Same MAX(gig.lastSeen) computeStatusStrip() already formats into status.lastScanLabel — surfaced separately here so the sonar-sweep header can tick it live client-side rather than render a frozen string (sonar-sweep-header-widget story). */
  lastScanIso: string | null;
  engagementProfiles: { id: string; label: string }[];
  draftedGigKeys: Set<string>;
  prepByGigKey: Record<string, PrepPacketContent>;
  /**
   * match-warning-tooltip-clarity-and-reliability story: for every gig that
   * didn't clear an engagement-type/rate profile, WHY -- reused verbatim
   * from `matching/gate.ts`'s own `explainProfileMismatch()` (which itself
   * just calls the exact same `matchProfiles()`/`effectiveEngagementType()`
   * gate() uses, never a second copy of that comparison logic) rather than
   * re-deriving the distinction in the UI layer. Keyed by `StoredGig.key`;
   * a gig with no entry either cleared a profile or couldn't be classified
   * (e.g. malformed engagementProfiles config) -- dashboard-client.tsx
   * treats a missing entry as "real-mismatch", the same single message
   * this warning showed before this story.
   */
  profileMismatchByGigKey: Record<string, ProfileMismatchKind>;
}

/**
 * Full, schema-validated `EngagementProfile`s for one group (or the
 * primary/first group when `groupId` is omitted) -- same group-lookup
 * convention as `extractEngagementProfileSummaries()` below, but returning
 * everything `matching/gate.ts`'s `matchProfiles()`/`explainProfileMismatch()`
 * need (minRate/highRate/maxHours/rateUnit/types), not just `{id, label}`.
 * `readRawConfig()`'s document is only ever produced by `saveConfig()`
 * (which validates against this same schema), so a real installation's
 * config always parses here; a missing/malformed shape (first-run, no
 * config yet) yields `[]` rather than throwing, same tolerance as every
 * other extractor in this file.
 */
export function extractEngagementProfiles(rawConfig: Record<string, unknown>, groupId?: string): EngagementProfile[] {
  const groups = rawConfig.groups;
  if (!Array.isArray(groups)) return [];
  const group = groupId ? groups.find((g) => typeof g === "object" && g !== null && (g as Record<string, unknown>).id === groupId) : groups[0];
  if (typeof group !== "object" || group === null) return [];
  const needs = (group as Record<string, unknown>).needs;
  if (typeof needs !== "object" || needs === null) return [];
  const profiles = (needs as Record<string, unknown>).engagementProfiles;
  if (!Array.isArray(profiles)) return [];
  const parsed = z.array(EngagementProfileSchema).safeParse(profiles);
  return parsed.success ? parsed.data : [];
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
 * rank-buckets epic. The relevant group's own configured bucket LABELS,
 * tolerantly extracted from the RAW config document the same way
 * extractEngagementProfileSummaries() above already does — a missing/
 * malformed `rankBuckets` array (not configured at all, the common case)
 * yields `[]`, never throws. `groupId` omitted reads the FIRST/primary
 * group, same unscoped-route convention every other extractor here uses.
 * Drives the Rank Bucket filter's option list — never a hardcoded enum,
 * since bucket labels are entirely owner-named.
 */
export function extractRankBucketLabels(rawConfig: Record<string, unknown>, groupId?: string): string[] {
  const groups = rawConfig.groups;
  if (!Array.isArray(groups)) return [];
  const group = groupId ? groups.find((g) => typeof g === "object" && g !== null && (g as Record<string, unknown>).id === groupId) : groups[0];
  if (typeof group !== "object" || group === null) return [];
  const rankBuckets = (group as Record<string, unknown>).rankBuckets;
  if (!Array.isArray(rankBuckets)) return [];
  const result: string[] = [];
  for (const b of rankBuckets) {
    if (typeof b !== "object" || b === null) continue;
    const label = (b as Record<string, unknown>).label;
    if (typeof label === "string") result.push(label);
  }
  return result;
}

/**
 * rank-buckets epic, grill-pass fix. The real, config-order primary
 * group's own id -- `groups[0].id`, same anchoring convention every other
 * extractor in this file already uses for unscoped routes. Resolved HERE,
 * server-side, from the real config document, rather than guessed
 * client-side per-gig from `Object.keys(gig.matchedRankBuckets)[0]` (the
 * bug this replaces: that guess breaks when the primary group has no
 * rankBuckets configured but a secondary one does, and JS object key
 * enumeration order for integer-like keys doesn't reliably reflect
 * insertion order anyway). `undefined` when there's no configured group at
 * all (first-run, no config yet).
 */
export function resolvePrimaryGroupId(rawConfig: Record<string, unknown>): string | undefined {
  const groups = rawConfig.groups;
  if (!Array.isArray(groups)) return undefined;
  const group = groups[0];
  if (typeof group !== "object" || group === null) return undefined;
  const id = (group as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
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
 * rate-band-match-quality epic, band-filter-everywhere story. The real,
 * owner-tunable `GroupConfig.matchQuality.hideOutOfBandByDefault` for the
 * relevant group, tolerantly extracted from the RAW (unresolved) config
 * document the same way `extractEngagementProfileSummaries()`/
 * `resolveGroupLabel()` above already do — a missing/malformed field
 * falls back to `DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT` (matching.match-band.ts's
 * own default) rather than throwing. `groupId` omitted reads the FIRST/
 * primary group, same single-group convention `extractEngagementProfileSummaries()`
 * already uses for the unscoped `/gigs`/`/today` routes.
 */
export function resolveHideOutOfBandDefault(rawConfig: Record<string, unknown>, groupId?: string): boolean {
  const groups = rawConfig.groups;
  if (!Array.isArray(groups)) return DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT;
  const group = groupId ? groups.find((g) => typeof g === "object" && g !== null && (g as Record<string, unknown>).id === groupId) : groups[0];
  if (typeof group !== "object" || group === null) return DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT;
  const matchQuality = (group as Record<string, unknown>).matchQuality;
  if (typeof matchQuality !== "object" || matchQuality === null) return DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT;
  const hide = (matchQuality as Record<string, unknown>).hideOutOfBandByDefault;
  return typeof hide === "boolean" ? hide : DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT;
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
  // status-strip-reflects-cycle-completion story: the real per-cycle
  // completion signal (getLastScanCycle()) is unscoped by group -- a scan
  // cycle covers every configured source across every group in one pass,
  // there's no per-group notion of "this group's own cycle completed".
  const lastCycle = getLastScanCycle();
  const status = computeStatusStrip(gigs, rawConfig, Date.now(), lastCycle ?? null);
  const lastScanIso = computeLastScanIso(gigs);
  const engagementProfiles = extractEngagementProfileSummaries(rawConfig, groupId);
  const draftedGigKeys = new Set(listDrafts().map((d) => d.gigKey));
  const prepByGigKey: Record<string, PrepPacketContent> = {};
  for (const p of listInterviewPrep()) prepByGigKey[p.gigKey] = p.content;

  // match-warning-tooltip-clarity-and-reliability story: same primary/
  // first-group-when-unscoped convention `engagementProfiles` above already
  // uses -- see this function's own tolerance for a missing/malformed
  // config (extractEngagementProfiles() -> []), which just means no gig
  // gets classified rather than throwing.
  const engagementProfilesFull = extractEngagementProfiles(rawConfig, groupId);
  const profileMismatchByGigKey: Record<string, ProfileMismatchKind> = {};
  for (const gig of gigs) {
    const kind = explainProfileMismatch(gig, engagementProfilesFull);
    if (kind) profileMismatchByGigKey[gig.key] = kind;
  }

  return { gigs, status, lastScanIso, engagementProfiles, draftedGigKeys, prepByGigKey, profileMismatchByGigKey };
}

export interface SonarSweepStatusData {
  status: StatusStripView;
  /** Same MAX(gig.lastSeen) value computeLastScanIso(listGigs()) would produce -- see getLastSeenMax()'s own doc comment (src/lib/store/gigs.ts). */
  lastScanIso: string | null;
}

/**
 * sonar-sweep-header-global-masthead story (header-layout-cleanup epic).
 * The lightweight, aggregate-only equivalent of the `status`/`lastScanIso`
 * slice of `loadDashboardData()` above -- `computeStatusStrip()`/
 * `computeLastScanIso()` never actually needed the full gig rows
 * `listGigs()` fetches, only a `MAX(lastSeen)` aggregate (`getLastSeenMax()`)
 * plus the lightweight config/source-count reads `computeStatusStrip()`
 * already does internally. Used by `layout.tsx`, which renders the
 * sonar-sweep masthead on EVERY route (not just the Dashboard-shaped routes
 * that already pay for `listGigs()` to render their own gig table/tiles) --
 * reusing `loadDashboardData()` here would turn a full 2000+-row table scan
 * into a per-page-load cost across the whole app. `loadDashboardData()`
 * itself is UNCHANGED and still what the Dashboard/`/gigs`/`/today`-shaped
 * routes use for their own gig-table needs; this is a separate, narrower
 * read for the masthead alone.
 *
 * Feeds `computeStatusStrip()` a single-element (or empty) `gigs`-shaped
 * array carrying just the aggregate `lastSeen` value, rather than changing
 * that function's own signature -- `computeLastScanIso()` applied to a
 * one-item list simply returns that item's `lastSeen`, so this produces the
 * byte-identical `StatusStripView`/`lastScanIso` `loadDashboardData()` would
 * have, without ever touching a full row.
 */
export function loadSonarSweepStatus(): SonarSweepStatusData {
  const lastScanIso = getLastSeenMax();
  const rawConfig = readRawConfig();
  const lastCycle = getLastScanCycle();
  const gigsForStatus = lastScanIso === null ? [] : [{ lastSeen: lastScanIso }];
  const status = computeStatusStrip(gigsForStatus, rawConfig, Date.now(), lastCycle ?? null);
  return { status, lastScanIso };
}
