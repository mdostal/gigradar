// stale-tier-retier-and-archive story (config-rebuild-and-match-quality
// epic). Real, confirmed bug: recordScan()'s UPSERT already re-tiers a gig
// on every RE-SEEN scan, but a gig that stops being returned by its source
// (delisted, or the source's own listing churn) never gets touched again
// — it keeps whatever tier it was stamped with at first-seen forever, even
// after the owner's own redKeywords/coreTitles config changes. Live-
// reproduced: a gig unseen for 18+ days still tiered green despite the
// owner's CURRENT redKeywords now correctly excluding it.
//
// Two real, separate remediations (owner: "Both"):
//   1. RE-TIER: gigs unseen for RETIER_AFTER_DAYS+ get their tier
//      recomputed against CURRENT config — closes the exact bug above.
//   2. ARCHIVE: gigs unseen for the longer ARCHIVE_AFTER_DAYS+ get
//      archived via the existing status-reconciliation-outcomes mechanism
//      (outcomeReason: "expired_unapplied") instead of sitting in the
//      owner's "new" queue forever.
//
// Only ever touches status:"new" gigs — a gig the owner has already
// applied to / is interviewing for is never silently re-tiered or
// archived by this pass, regardless of staleness.
//
// stale-band-retier-alongside-tier story (rate-band-match-quality epic
// follow-up). Real, confirmed bug found via a live picks-quality audit
// (2026-09-15): this pass already re-tiers a stale gig's KEYWORD tier
// against current config, but never touched `matchBand`/`matchedGroupBands`
// at all — those are stamped once, at original scan time, by
// apply/runner.ts, and NEVER recomputed here. dashboard-filter.ts's
// resolveDisplayBand() deliberately fails OPEN (treats missing band data
// as "in-band") for any gig that predates the rate-band-match-quality
// epic, or was simply never re-scanned since — so a large, silently-
// growing population of stale "green" gigs (live-confirmed: 43 of 44
// stale BuiltIn listings in the owner's own database) sail straight
// through the "Hide out-of-band" filter, which defaults ON, completely
// unchecked. Unlike tier's percentile tierScoring mode, band recompute
// needs no score population at all (match-band.ts's computeMatchBand()
// is a pure per-gig rate check) — so it's always safe to recompute here,
// even for a group whose tier this pass otherwise skips.
import { computeMatchBand, resolveNearBandTolerancePct } from "../matching/match-band.js";
import { tier as classifyTier } from "../matching/tiering.js";
import type { Config, Gig, GroupConfig, MatchBand } from "../types.js";
import { type DbOption, listGigs, setMatchBand, setOutcome, setStatus, setTier } from "./gigs.js";

/** Real, tunable defaults — stated explicitly here, not buried. */
export const RETIER_AFTER_DAYS = 3;
export const ARCHIVE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleGigMaintenanceResult {
  retiered: number;
  rebanded: number;
  archived: number;
}

/** Every group a gig's own source is in scope for — runner.ts's own `scopedGroups` pattern, kept in lockstep so a re-check here produces the exact same result a fresh scan would have. */
function resolveScopedGroups(gig: Gig, config: Config): GroupConfig[] {
  const source = config.sources.find((s) => s.id === gig.sourceId);
  const scopedGroupIds = source?.groupIds ?? config.groups.map((g) => g.id);
  return config.groups.filter((g) => scopedGroupIds.includes(g.id));
}

/**
 * Runs one maintenance pass over every currently-"new" gig. The tier half
 * is deliberately scoped to the KEYWORD classifier only (matching/tiering.
 * ts's tier()) — a group using score-based tierScoring (percentile/
 * threshold) needs the full population of other tracked gigs' scores to
 * re-derive a tier correctly (see matchGroups()'s own scorePopulations),
 * which this maintenance pass does not attempt to reconstruct outside a
 * real scan; those gigs are left untouched by the RE-TIER half (still
 * eligible for the ARCHIVE half, and for the RE-BAND half below, which
 * has no such restriction).
 */
export function runStaleGigMaintenance(config: Config, opts: DbOption & { now?: number } = {}): StaleGigMaintenanceResult {
  const now = opts.now ?? Date.now();
  const gigs = listGigs({ status: "new" }, opts);

  let retiered = 0;
  let rebanded = 0;
  let archived = 0;

  for (const gig of gigs) {
    const ageDays = (now - new Date(gig.lastSeen).getTime()) / DAY_MS;
    if (ageDays < RETIER_AFTER_DAYS) continue;

    if (ageDays >= ARCHIVE_AFTER_DAYS) {
      setStatus(gig.key, "archived", opts);
      setOutcome(gig.key, "expired_unapplied", `Not re-seen in ${Math.floor(ageDays)}+ days.`, opts);
      archived++;
      continue;
    }

    const scopedGroups = resolveScopedGroups(gig, config);
    const primaryGroup = scopedGroups[0];

    if (!primaryGroup || primaryGroup.tierScoring === undefined || primaryGroup.tierScoring.kind === "keyword") {
      const { tier: recomputed } = classifyTier(gig, primaryGroup?.roleArea ?? { coreTitles: [], keywords: [], redKeywords: [] });
      if (recomputed !== gig.tier) {
        setTier(gig.key, recomputed, opts);
        retiered++;
      }
    }

    const groupBands: Record<string, MatchBand> = {};
    for (const group of scopedGroups) {
      groupBands[group.id] = computeMatchBand(gig, group.needs.engagementProfiles, resolveNearBandTolerancePct(group)).band;
    }
    const flatMatchBand: MatchBand = primaryGroup ? groupBands[primaryGroup.id]! : "out-of-band";
    const bandsChanged =
      flatMatchBand !== (gig.matchBand ?? undefined) ||
      JSON.stringify(groupBands) !== JSON.stringify(gig.matchedGroupBands ?? {});
    if (scopedGroups.length > 0 && bandsChanged) {
      setMatchBand(gig.key, flatMatchBand, groupBands, opts);
      rebanded++;
    }
  }

  return { retiered, rebanded, archived };
}
