// gate-reasons-in-dashboard story. Pure UI mapping from matching/gate.ts's
// structured explainGate() output to the two dashboard surfaces that show
// it: the All Gigs ⚠ tooltip (failed rules only) and the gig detail
// panel's "Gate check" section (every rule). No rule list lives here --
// which rules exist, their labels and their reasons all come from
// explainGate() run against the user's own config (dashboard-data.ts's
// extractGateConfig()); this file only groups and formats them.
import type { GateExplanation, GateRuleCheck, GateRuleOutcome, ProfileMismatchKind } from "@/lib/matching/gate";
import { RATE_NOT_COMPARABLE_TOOLTIP, resolveProfileMismatchTooltip } from "./dashboard-client";

export const OUTCOME_ICON: Record<GateRuleOutcome, string> = {
  pass: "✓",
  fail: "✗",
  skipped: "–",
  info: "·",
};

/** True for the per-engagement-profile rows (`profile:<id>`), which the panel groups under one "any one must clear" heading. */
export function isProfileRule(rule: GateRuleCheck): boolean {
  return rule.id.startsWith("profile:");
}

/** The rules that actually decided a failing verdict -- what the ⚠ tooltip lists. */
export function failedGateRules(explanation: GateExplanation): GateRuleCheck[] {
  return explanation.rules.filter((r) => r.outcome === "fail" && r.blocking);
}

/** One line per rule: "Label: reason". */
export function formatRuleLine(rule: GateRuleCheck): string {
  return `${rule.label}: ${rule.reason}`;
}

/**
 * The ⚠ tooltip text. Lists every blocking failed rule from the user's own
 * config. Falls back to the previous fixed copy only when no explanation
 * could be computed at all (no parseable config). When the gig passes the
 * CURRENT config (the stored match is from a scan run against older
 * settings), says so rather than showing an empty list.
 */
export function formatGateTooltip(
  explanation: GateExplanation | undefined,
  groupLabel: string | undefined,
  kind: ProfileMismatchKind | undefined,
): string {
  if (!explanation) return resolveProfileMismatchTooltip(kind);
  const failed = failedGateRules(explanation);
  const where = groupLabel ? ` (${groupLabel})` : "";
  if (failed.length === 0) {
    return `Passes your current config${where} — this gig's stored match is from an earlier scan; the next sweep will refresh it.`;
  }
  const header = `Didn't pass ${failed.length} rule${failed.length === 1 ? "" : "s"} in your config${where}:`;
  const lines = failed.map((r) => `• ${formatRuleLine(r)}`);
  return [...(kind === "rate-not-comparable" ? [RATE_NOT_COMPARABLE_TOOLTIP] : []), header, ...lines].join("\n");
}
