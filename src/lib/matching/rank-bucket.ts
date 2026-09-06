import type { Gig, RankBucketRule } from "../types.js";
import { firstWholeWordMatch } from "./tiering.js";

/**
 * rank-buckets epic, rank-bucket-core story. The deterministic, no-LLM-
 * required base layer — owner's own explicit directive: "we were
 * supposed to have simple rules set anyways, maintain that, then add in
 * the AI suggested on top -- this should be both." This module is the
 * "simple rules" half; the AI overlay is a separate, later story
 * (rank-bucket-ai-overlay) that reviews THIS function's own result and
 * may suggest a different bucket, never replacing it silently.
 *
 * Mirrors tiering.ts's own "first match wins, in declared order" doc
 * comment and precedence exactly: a gig is assigned to the FIRST rule (in
 * `rules`' own list order) it satisfies. Reuses tiering.ts's exported
 * `firstWholeWordMatch()` for keyword matching rather than a second,
 * possibly-divergent implementation.
 *
 * A rule with NO criteria set at all (`minRate`/`maxRate`/`keywords` all
 * absent) matches NOTHING — never a silent catch-all for a bucket the
 * owner hasn't finished configuring yet. When a rule sets MORE than one
 * criterion, ALL of them must match (AND within one rule) — same "every
 * configured check must pass" convention `gate.ts` already uses.
 */
export interface RankBucketResult {
  bucket: string | null;
  reasons: string[];
}

/** Same rate-extraction convention as gate.ts's normalizeRate(): prefers `min`, falls back to `max`, no unit conversion. */
function extractRate(gig: Gig): number | null {
  const r = gig.rate;
  if (!r) return null;
  return r.min ?? r.max ?? null;
}

function ruleHasAnyCriteria(rule: RankBucketRule): boolean {
  return rule.minRate !== undefined || rule.maxRate !== undefined || (rule.keywords !== undefined && rule.keywords.length > 0);
}

/** True iff `gig` satisfies EVERY criterion `rule` actually sets (AND within one rule). A rule with zero criteria is never satisfiable. */
function ruleMatches(gig: Gig, rule: RankBucketRule): { matched: boolean; reasons: string[] } {
  if (!ruleHasAnyCriteria(rule)) {
    return { matched: false, reasons: [`[${rule.label}] no rule criteria configured — never matches`] };
  }

  const reasons: string[] = [];

  if (rule.minRate !== undefined || rule.maxRate !== undefined) {
    const rate = extractRate(gig);
    if (rate === null) {
      return { matched: false, reasons: [`[${rule.label}] rate criterion configured but gig has no published rate`] };
    }
    if (rule.minRate !== undefined && rate < rule.minRate) {
      return { matched: false, reasons: [`[${rule.label}] rate $${rate} below minRate $${rule.minRate}`] };
    }
    if (rule.maxRate !== undefined && rate > rule.maxRate) {
      return { matched: false, reasons: [`[${rule.label}] rate $${rate} above maxRate $${rule.maxRate}`] };
    }
    reasons.push(`[${rule.label}] rate $${rate} within configured range`);
  }

  if (rule.keywords !== undefined && rule.keywords.length > 0) {
    const haystack = `${gig.title ?? ""} ${gig.description ?? ""}`;
    const hit = firstWholeWordMatch(haystack, rule.keywords);
    if (!hit) {
      // Grill-pass fix: must include `reasons` accumulated so far (e.g. a
      // passing rate check above) -- a fresh array here silently dropped
      // that context, under-reporting why a rule almost matched, contrary
      // to this module's own "explanatory reasons for every rule tried" contract.
      return { matched: false, reasons: [...reasons, `[${rule.label}] no configured keyword matched title/description`] };
    }
    reasons.push(`[${rule.label}] keyword "${hit}" matched`);
  }

  return { matched: true, reasons };
}

/**
 * Evaluates `rules` in list order and returns the FIRST one `gig`
 * satisfies. `bucket: null` (with explanatory reasons for every rule
 * tried) when none match, or when `rules` is empty/unset — never guesses,
 * never falls back to the first rule as a default.
 */
export function assignRankBucket(gig: Gig, rules: RankBucketRule[]): RankBucketResult {
  if (rules.length === 0) {
    return { bucket: null, reasons: ["no rank buckets configured for this group"] };
  }

  const reasons: string[] = [];
  for (const rule of rules) {
    const { matched, reasons: ruleReasons } = ruleMatches(gig, rule);
    reasons.push(...ruleReasons);
    if (matched) {
      reasons.unshift(`✓ assigned to "${rule.label}" (first matching rule, in declared order)`);
      return { bucket: rule.label, reasons };
    }
  }

  reasons.unshift("✗ no configured rule matched — unassigned");
  return { bucket: null, reasons };
}
