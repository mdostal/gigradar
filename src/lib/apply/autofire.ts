// Trust math for the graduated-auto-fire-trust epic. See
// .pHive/epics/graduated-auto-fire-trust/docs/design-discussion.md §3.1 for
// the full rationale: graduation is a PURE COMPUTATION over
// application_drafts/gigs, never a separate stored counter, so it can never
// drift from the real approval history it represents.
//
// This module knows nothing about HOW a submission actually happens (that's
// src/lib/submit/'s SubmitAdapter registry, a later story) or about the full
// evaluateAutoFire() decision tree (also a later story) -- it only answers
// "how many approvals does this pair have" and "has it graduated."
import type { AutoFireRuleConfig, Config, Tier } from "../types.js";
import { getDb } from "../store/index.js";
import type { DbOption } from "../store/index.js";

/**
 * Counts every `application_drafts` row for gigs from `sourceId` tiered
 * `tier` whose status is `'approved'` OR `'submitted'` -- `'submitted'`
 * counts too because every submission this codebase can produce today was,
 * at minimum, approved along the way first (there is no other path to
 * `'submitted'` yet). Never counts `'draft'`/`'rejected'`/`'submitting'`.
 */
export function approvedCount(sourceId: string, tier: Tier, opts: DbOption = {}): number {
  const db = opts.db ?? getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM application_drafts
       JOIN gigs ON gigs.key = application_drafts.gig_key
       WHERE gigs.source_id = :source_id
         AND gigs.tier = :tier
         AND application_drafts.status IN ('approved', 'submitted')`,
    )
    .get({ source_id: sourceId, tier }) as { n: number };
  return row.n;
}

/** Finds the configured rule for `(sourceId, tier)`, or undefined if none exists. */
export function findAutoFireRule(sourceId: string, tier: Tier, config: Config): AutoFireRuleConfig | undefined {
  return config.autoFire?.rules.find((r) => r.sourceId === sourceId && r.tier === tier);
}

/**
 * True once `approvedCount(sourceId, tier)` reaches the pair's own
 * `minApprovals` threshold. False (never throws) when no rule is configured
 * for the pair at all -- an unconfigured pair can never be "graduated".
 */
export function isGraduated(sourceId: string, tier: Tier, config: Config, opts: DbOption = {}): boolean {
  const rule = findAutoFireRule(sourceId, tier, config);
  if (!rule) return false;
  return approvedCount(sourceId, tier, opts) >= rule.minApprovals;
}
