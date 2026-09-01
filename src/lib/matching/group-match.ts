// multi-group-architecture epic. A gig can clear zero, one, or several of
// the owner's configured Groups at once (owner's own words, 2026-09-01:
// "it can cross over and be in multiple lists but still if we apply, we
// only apply to the singular gig ONCE") — mirrors how a gig can already
// clear more than one EngagementProfile (Gig.matchedProfileIds), one level
// up. gate()/tiering.ts's tier() get ZERO signature changes here — this is
// a pure orchestration layer calling each, once per group, never a rewrite
// of either.
import type { Gig, GroupConfig, Profile, Tier } from "../types.js";
import { gate } from "./gate.js";
import { EMPTY_ROLE_AREA_CONFIG, tier } from "./tiering.js";

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
}

/**
 * Evaluates one gig against every group in `groups` (already narrowed to
 * whatever this gig's source is in scope for — see runner.ts's own
 * scoping logic, `SourceConfig.groupIds ?? every configured group`).
 * Pure, no I/O — directly unit-testable without a real Gig/store.
 */
export function matchGroups(gig: Gig, groups: GroupConfig[], profile: Profile): GroupMatchResult {
  const matchedGroupIds: string[] = [];
  const groupTiers: Record<string, Tier> = {};
  for (const group of groups) {
    const gateResult = gate(gig, group.needs, profile);
    if (gateResult.pass) matchedGroupIds.push(group.id);
    groupTiers[group.id] = tier(gig, group.roleArea ?? EMPTY_ROLE_AREA_CONFIG).tier;
  }
  return { matchedGroupIds, groupTiers };
}
