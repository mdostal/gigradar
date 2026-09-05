import type { EngagementProfile, Gig, GroupConfig, MatchBand } from "../types.js";
import { matchProfiles, normalizeRate } from "./gate.js";

/**
 * rate-band-match-quality epic, match-band-core story. A NEW, additive
 * per-group signal, orthogonal to tiering.ts's tier() (which answers "is
 * this the right KIND of role" via title/keyword matching, with zero
 * awareness of rate) — this answers "is the rate actually in range."
 * Neither gate.ts nor tiering.ts is modified by this module.
 *
 * Live-confirmed trigger (2026-09-05, owner's own real gigs.db): a
 * $50-60/hr consulting gig and several $86k-225k/yr engineer roles were
 * tiering GREEN ("Strong fit") despite failing every group's rate floor
 * entirely — tier() has no rate concept, and matchedGroupIds being empty
 * was never checked anywhere the owner could see. See
 * .pHive/epics/rate-band-match-quality/docs/design-discussion.md for the
 * full investigation and the owner's sign-off on this exact model.
 *
 *   - "in-band"      — cleared at least one applicable profile's real
 *                       gate (rate >= floor, hours within cap). Reuses
 *                       gate.ts's own matchProfiles() so this can never
 *                       silently disagree with what the real gate
 *                       enforces.
 *   - "near-band"     — failed every applicable profile, but at least one
 *                       failed ON RATE ONLY, within `tolerancePct` of that
 *                       profile's floor (e.g. 15% tolerance, $150/hr floor
 *                       -> $127.50/hr+ is near-band). Worth a glance,
 *                       not clutter.
 *   - "out-of-band"   — failed by more than `tolerancePct`, OR failed for
 *                       any non-rate reason (no applicable profile at all
 *                       — wrong engagement type — or cleared rate but
 *                       blew the hours cap).
 *
 * A gig with no published rate is "in-band": matchProfiles() already
 * treats an unpublished rate as an automatic pass ("confirm on the
 * call") for every applicable profile, so `matched.length > 0` and this
 * function never reaches its near/out-of-band branches for that case.
 *
 * `MatchBand` itself lives in types.ts (mirrors `Tier`'s own location) —
 * re-exported here so existing callers of this module don't need a second
 * import.
 */
export type { MatchBand };

/**
 * match-quality-settings-page story: the real, owner-tunable defaults —
 * used whenever a group hasn't (or hasn't yet) set its own
 * `GroupConfig.matchQuality` value. Both are genuinely editable per group
 * via `/config/match-quality`; these are only the do-nothing-default
 * fallback, same pattern every other optional Config field uses.
 */
export const DEFAULT_NEAR_BAND_TOLERANCE_PCT = 15;
export const DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT = true;

/** The real per-group tolerance, falling back to `DEFAULT_NEAR_BAND_TOLERANCE_PCT` when unset. */
export function resolveNearBandTolerancePct(group: Pick<GroupConfig, "matchQuality">): number {
  return group.matchQuality?.nearBandTolerancePct ?? DEFAULT_NEAR_BAND_TOLERANCE_PCT;
}

/** The real per-group hide-out-of-band preference, falling back to `DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT` when unset. */
export function resolveHideOutOfBandByDefault(group: Pick<GroupConfig, "matchQuality">): boolean {
  return group.matchQuality?.hideOutOfBandByDefault ?? DEFAULT_HIDE_OUT_OF_BAND_BY_DEFAULT;
}

export interface MatchBandResult {
  band: MatchBand;
  reasons: string[];
}

/**
 * `tolerancePct` is a REQUIRED parameter, never a hardcoded constant in
 * this module — the owner's explicit directive this epic exists to honor:
 * "make EVERY FUCKING VARIABLE TOGGLEABLE IN SETTINGS." Callers resolve
 * the real per-group value (match-quality-settings-page story); this
 * module stays exactly as pure/unit-testable as gate.ts and tiering.ts.
 */
export function computeMatchBand(gig: Gig, profiles: EngagementProfile[], tolerancePct: number): MatchBandResult {
  const { matched, applicable } = matchProfiles(gig, profiles);

  if (matched.length > 0) {
    return {
      band: "in-band",
      reasons: [`✓ IN-BAND — cleared ${matched.map((m) => m.profile.label).join(", ")}`],
    };
  }

  if (applicable.length === 0) {
    return {
      band: "out-of-band",
      reasons: ["✗ OUT-OF-BAND — no configured profile applies to this gig's engagement type"],
    };
  }

  // applicable.length > 0 but matched none: check whether any applicable
  // profile failed ON RATE ONLY, within tolerance of its floor.
  const reasons: string[] = [];
  let nearBand = false;
  for (const p of applicable) {
    const rate = normalizeRate(gig, p.rateUnit);
    if (rate == null) continue; // unreachable in practice — matchProfiles() would have already matched this profile.
    const unitLabel = p.rateUnit === "hour" ? "/hr" : "/yr";
    if (rate >= p.minRate) {
      // Cleared rate but failed for a non-rate reason (hours over cap) —
      // never counts toward near-band, per this module's own contract.
      continue;
    }
    const distancePct = ((p.minRate - rate) / p.minRate) * 100;
    if (distancePct <= tolerancePct) {
      nearBand = true;
      reasons.push(
        `near-band — [${p.label}] $${rate.toLocaleString()}${unitLabel} is ${distancePct.toFixed(1)}% under floor $${p.minRate.toLocaleString()}${unitLabel}, within ${tolerancePct}% tolerance`,
      );
    }
  }

  if (nearBand) return { band: "near-band", reasons };
  return {
    band: "out-of-band",
    reasons: reasons.length > 0 ? reasons : ["✗ OUT-OF-BAND — failed every applicable profile's rate/hours threshold beyond tolerance"],
  };
}
