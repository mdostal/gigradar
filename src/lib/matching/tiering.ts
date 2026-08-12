import type { Gig, RoleAreaConfig, Tier } from "../types.js";

/**
 * Deterministic, explainable GREEN/YELLOW/RED role-area classifier. Mirrors
 * gate.ts's shape: pure function, no I/O, every verdict comes with a
 * human-readable reason. Unlike the gate, this is never a hard reject —
 * "no match" is YELLOW ("surface it, worth a look"), not dropped.
 *
 * Precedence (checked in this exact order; first match wins):
 *   1. config.coreTitles matched in the gig TITLE           -> GREEN
 *      (wins even if a redKeywords term also appears in that title —
 *      title-role wins over domain/industry words)
 *   2. config.redKeywords matched in the TITLE               -> RED
 *      (only reached if rule 1 didn't match)
 *   3. config.keywords matched in TITLE + DESCRIPTION         -> GREEN
 *      (only reached if rules 1 and 2 didn't match)
 *   4. nothing matched                                        -> YELLOW
 *
 * All matching is whole-word only (case-insensitive) — a keyword must match
 * a full word/phrase boundary, e.g. "cto" must never match inside
 * "contractor". Multi-word keywords ("fractional cto") are matched as a
 * bounded phrase the same way.
 *
 * The keyword sets themselves are 100% user-supplied via RoleAreaConfig
 * (see ../types.ts) — this file contains no hardcoded titles or keywords,
 * per this repo's core/user-layer boundary (docs/ARCHITECTURE.md).
 */
export interface TierResult {
  tier: Tier;
  reasons: string[];
}

/** A RoleAreaConfig with no keywords set at all — every gig tiers YELLOW. Used by the runner when the user hasn't configured one. */
export const EMPTY_ROLE_AREA_CONFIG: RoleAreaConfig = { coreTitles: [], keywords: [], redKeywords: [] };

export function tier(gig: Gig, config: RoleAreaConfig): TierResult {
  const reasons: string[] = [];
  const title = gig.title ?? "";
  const titleAndDescription = `${title} ${gig.description ?? ""}`;

  // ---- 1. coreTitles in TITLE -> GREEN, wins over everything ----
  const coreHit = firstWholeWordMatch(title, config.coreTitles);
  if (coreHit) {
    reasons.push(`✓ GREEN — title matches core title "${coreHit}"`);
    const redAlsoPresent = firstWholeWordMatch(title, config.redKeywords);
    if (redAlsoPresent) {
      reasons.push(`(red keyword "${redAlsoPresent}" also present in title — core title wins)`);
    }
    return { tier: "green", reasons };
  }

  // ---- 2. redKeywords in TITLE (no coreTitles hit) -> RED ----
  const redHit = firstWholeWordMatch(title, config.redKeywords);
  if (redHit) {
    reasons.push(`✗ RED — title matches red keyword "${redHit}"`);
    return { tier: "red", reasons };
  }

  // ---- 3. keywords in TITLE+DESCRIPTION (neither above hit) -> GREEN ----
  const keywordHit = firstWholeWordMatch(titleAndDescription, config.keywords);
  if (keywordHit) {
    reasons.push(`✓ GREEN — keyword "${keywordHit}" matched in title/description`);
    return { tier: "green", reasons };
  }

  // ---- 4. nothing matched -> YELLOW (never a hard reject) ----
  reasons.push("— YELLOW — no core title, red keyword, or green keyword matched; surfaced for manual review");
  return { tier: "yellow", reasons };
}

/** Escape a string for safe use inside a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True iff `needle` matches `haystack` as a whole word/phrase (case-insensitive). */
function isWholeWordMatch(haystack: string, needle: string): boolean {
  const trimmed = needle.trim();
  if (!trimmed) return false;
  return new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "i").test(haystack);
}

/** First needle (in list order) that whole-word-matches `haystack`, or undefined. */
function firstWholeWordMatch(haystack: string, needles: string[]): string | undefined {
  return needles.find((n) => isWholeWordMatch(haystack, n));
}
