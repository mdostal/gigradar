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
import { tier as classifyTier } from "../matching/tiering.js";
import type { Config, Gig } from "../types.js";
import { type DbOption, listGigs, setOutcome, setStatus, setTier } from "./gigs.js";

/** Real, tunable defaults — stated explicitly here, not buried. */
export const RETIER_AFTER_DAYS = 3;
export const ARCHIVE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StaleGigMaintenanceResult {
  retiered: number;
  archived: number;
}

/**
 * Resolves the same "primary group" a gig would anchor its flat tier to
 * during a real scan (runner.ts's own `scopedGroups[0]` pattern) — kept
 * in lockstep with that logic so a re-tier here produces the exact same
 * result a fresh scan of this gig would have.
 */
function resolvePrimaryGroup(gig: Gig, config: Config) {
  const source = config.sources.find((s) => s.id === gig.sourceId);
  const scopedGroupIds = source?.groupIds ?? config.groups.map((g) => g.id);
  return config.groups.filter((g) => scopedGroupIds.includes(g.id))[0];
}

/**
 * Runs one maintenance pass over every currently-"new" gig. Deliberately
 * scoped to the KEYWORD tier classifier only (matching/tiering.ts's
 * tier()) — a group using score-based tierScoring (percentile/threshold)
 * needs the full population of other tracked gigs' scores to re-derive a
 * tier correctly (see matchGroups()'s own scorePopulations), which this
 * maintenance pass does not attempt to reconstruct outside a real scan;
 * those gigs are left untouched by the RE-TIER half (still eligible for
 * the ARCHIVE half on their own staleness, independent of tier).
 */
export function runStaleGigMaintenance(config: Config, opts: DbOption & { now?: number } = {}): StaleGigMaintenanceResult {
  const now = opts.now ?? Date.now();
  const gigs = listGigs({ status: "new" }, opts);

  let retiered = 0;
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

    const primaryGroup = resolvePrimaryGroup(gig, config);
    if (primaryGroup?.tierScoring && primaryGroup.tierScoring.kind !== "keyword") continue; // see header comment
    const { tier: recomputed } = classifyTier(gig, primaryGroup?.roleArea ?? { coreTitles: [], keywords: [], redKeywords: [] });
    if (recomputed !== gig.tier) {
      setTier(gig.key, recomputed, opts);
      retiered++;
    }
  }

  return { retiered, archived };
}
