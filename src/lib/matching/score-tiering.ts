// customizable-tier-scoring epic. Pure functions only, no I/O — mirrors
// matching/tiering.ts's own discipline exactly. This module never calls
// tier()/gate() itself; it's an ALTERNATIVE way to arrive at a Tier from
// a gig's already-computed MatchResult.score, selected per group via
// GroupConfig.tierScoring (see types.ts's TierScoringMode doc comment for
// the full contract). matching/group-match.ts's matchGroups() is the one
// caller, choosing between this module and tiering.ts's tier() per group
// based on that group's own tierScoring.kind.
//
// "percentile" mode needs a POPULATION of other scores to rank against —
// deliberately passed in by the caller (a plain number[], no DB handle,
// no query) rather than fetched here, so this file stays exactly as pure
// and unit-testable as tiering.ts/gate.ts. apply/runner.ts is the one
// place that actually fetches that population (store/gigs.ts's
// listGroupScores()), once per source batch, before matchGroups() runs.
import type { Tier, TierScoringMode } from "../types.js";

/**
 * `score`'s rank among `population` as a fraction in [0,1] — the share of
 * `population` STRICTLY LESS than `score`. An empty population ranks
 * everything at the middle (0.5, "no data yet, call it average") rather
 * than 0 or 1, which would otherwise make the very first gig for a fresh
 * percentile-mode group either always-green or always-red depending on
 * threshold direction — an arbitrary artifact of having no data, not a
 * real signal.
 */
function percentileRank(score: number, population: number[]): number {
  if (population.length === 0) return 0.5;
  const below = population.filter((s) => s < score).length;
  return below / population.length;
}

/** Mirrors tiering.ts's own TierResult shape exactly — every tiering method in this codebase reports a human-readable "why," not just a bare Tier. */
export interface ScoreTierResult {
  tier: Tier;
  reasons: string[];
}

/**
 * Computes a Tier from `score` per `mode` — never calls the keyword
 * classifier (matching/tiering.ts's tier()); that's the caller's job when
 * `mode.kind === "keyword"`. `population` is only consulted for
 * `"percentile"` mode (ignored otherwise) — see this file's header
 * comment for why it's caller-supplied, never fetched here.
 */
export function computeTier(score: number, mode: TierScoringMode, population: number[] = []): ScoreTierResult {
  if (mode.kind === "score-threshold") {
    if (score >= mode.green) return { tier: "green", reasons: [`✓ GREEN — score ${score.toFixed(3)} >= green threshold ${mode.green}`] };
    if (score >= mode.yellow) return { tier: "yellow", reasons: [`score ${score.toFixed(3)} >= yellow threshold ${mode.yellow}, below green threshold ${mode.green}`] };
    return { tier: "red", reasons: [`✗ RED — score ${score.toFixed(3)} below yellow threshold ${mode.yellow}`] };
  }

  if (mode.kind === "percentile") {
    const rank = percentileRank(score, population);
    const rankPct = Math.round(rank * 100);
    if (rank >= mode.greenPercentile / 100) {
      return { tier: "green", reasons: [`✓ GREEN — score ranks in the top ${100 - rankPct}% of ${population.length} tracked gig(s) for this group (>= ${mode.greenPercentile}th percentile)`] };
    }
    if (rank >= mode.yellowPercentile / 100) {
      return { tier: "yellow", reasons: [`score ranks at the ${rankPct}th percentile of ${population.length} tracked gig(s) for this group (between the ${mode.yellowPercentile}th and ${mode.greenPercentile}th cutoffs)`] };
    }
    return { tier: "red", reasons: [`✗ RED — score ranks at the ${rankPct}th percentile of ${population.length} tracked gig(s) for this group, below the ${mode.yellowPercentile}th percentile cutoff`] };
  }

  // mode.kind === "keyword" should never reach this function (the caller
  // branches before calling it) -- but a defensive, honest fallback (never
  // a silent wrong-but-plausible answer) beats a runtime crash if a future
  // caller forgets the branch.
  throw new Error(`gigradar matching: computeTier() called with mode.kind === "keyword" -- use tiering.ts's tier() instead.`);
}
