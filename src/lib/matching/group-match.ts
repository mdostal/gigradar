// multi-group-architecture epic. A gig can clear zero, one, or several of
// the owner's configured Groups at once (owner's own words, 2026-09-01:
// "it can cross over and be in multiple lists but still if we apply, we
// only apply to the singular gig ONCE") — mirrors how a gig can already
// clear more than one EngagementProfile (Gig.matchedProfileIds), one level
// up. gate()/tiering.ts's tier() get ZERO signature changes here — this is
// a pure orchestration layer calling each, once per group, never a rewrite
// of either.
//
// customizable-tier-scoring epic extends this to also compute/return each
// group's own MatchResult.score (gate()'s own return already computes it
// — previously discarded, never surfaced past this function) and to
// choose HOW each group's tier is computed: the existing keyword
// classifier (tiering.ts's tier(), default, unchanged) or, per
// GroupConfig.tierScoring, matching/score-tiering.ts's computeTier().
// `scorePopulations` is the one caller-supplied, optional input that
// keeps this function 100% pure (no I/O) even for "percentile" mode — see
// score-tiering.ts's own header comment for why the population is fetched
// by the caller (apply/runner.ts), never here.
import type { Gig, GroupConfig, MatchBand, Profile, Tier } from "../types.js";
import { gate } from "./gate.js";
import { EMPTY_ROLE_AREA_CONFIG, tier } from "./tiering.js";
import { computeTier } from "./score-tiering.js";
import { computeMatchBand, DEFAULT_NEAR_BAND_TOLERANCE_PCT } from "./match-band.js";

export interface GroupMatchResult {
  /** Every group whose gate this gig cleared — never a partial/fabricated list, empty when it cleared none. */
  matchedGroupIds: string[];
  /**
   * Every evaluated group's OWN tier result, independent of whether that
   * group's gate passed — mirrors how the existing flat `tier` field is
   * already independent of gate pass/fail (see tiering.ts's own header
   * comment). A group a gig failed can still be worth showing as, say,
   * "yellow" rather than silently omitted.
   */
  groupTiers: Record<string, Tier>;
  /** Every evaluated group's OWN score (gate()'s MatchResult.score), independent of pass/fail — customizable-tier-scoring epic. */
  groupScores: Record<string, number>;
  /**
   * rate-band-match-quality epic. Every evaluated group's OWN MatchBand
   * (match-band.ts's computeMatchBand()), independent of pass/fail — same
   * per-group shape as groupTiers/groupScores above. TODO(match-quality-
   * settings-page): tolerance is DEFAULT_NEAR_BAND_TOLERANCE_PCT for every
   * group until that story wires a real per-group GroupConfig.matchQuality
   * value through.
   */
  groupBands: Record<string, MatchBand>;
}

/**
 * Evaluates one gig against every group in `groups` (already narrowed to
 * whatever this gig's source is in scope for — see runner.ts's own
 * scoping logic, `SourceConfig.groupIds ?? every configured group`).
 * Pure, no I/O — directly unit-testable without a real Gig/store.
 *
 * `scorePopulations` (optional, customizable-tier-scoring epic): a
 * pre-fetched `Record<groupId, number[]>` of OTHER gigs' scores for any
 * group whose `tierScoring.kind === "percentile"` — omitted or missing an
 * entry for a given group falls back to an empty population (see
 * score-tiering.ts's `computeTier()` for what that means: ranks at the
 * middle, 0.5, rather than crashing or silently favoring one tier).
 */
export function matchGroups(
  gig: Gig,
  groups: GroupConfig[],
  profile: Profile,
  scorePopulations: Record<string, number[]> = {},
): GroupMatchResult {
  const matchedGroupIds: string[] = [];
  const groupTiers: Record<string, Tier> = {};
  const groupScores: Record<string, number> = {};
  const groupBands: Record<string, MatchBand> = {};
  for (const group of groups) {
    const gateResult = gate(gig, group.needs, profile);
    if (gateResult.pass) matchedGroupIds.push(group.id);
    groupScores[group.id] = gateResult.score;

    const mode = group.tierScoring ?? { kind: "keyword" as const };
    groupTiers[group.id] =
      mode.kind === "keyword"
        ? tier(gig, group.roleArea ?? EMPTY_ROLE_AREA_CONFIG).tier
        : computeTier(gateResult.score, mode, scorePopulations[group.id] ?? []).tier;

    groupBands[group.id] = computeMatchBand(gig, group.needs.engagementProfiles, DEFAULT_NEAR_BAND_TOLERANCE_PCT).band;
  }
  return { matchedGroupIds, groupTiers, groupScores, groupBands };
}
