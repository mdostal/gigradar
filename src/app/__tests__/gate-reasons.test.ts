import { describe, expect, it } from "vitest";
import type { GateExplanation } from "@/lib/matching/gate";
import { RATE_NOT_COMPARABLE_TOOLTIP, REAL_MISMATCH_TOOLTIP } from "../dashboard-client";
import { failedGateRules, formatGateTooltip } from "../gate-reasons";

// gate-reasons-in-dashboard story. The ⚠ tooltip's text mapping from
// explainGate()'s structured rules (explainGate() itself is tested in
// lib/matching/__tests__/gate.test.ts).
const FAILING: GateExplanation = {
  pass: false,
  rules: [
    { id: "engagement-type", label: "Engagement type", outcome: "pass", reason: "contract is accepted by: Hourly", blocking: false },
    { id: "profile:p1", label: "Hourly", outcome: "fail", reason: "$26/hr is below your $120/hr floor", blocking: true },
    { id: "profile:p2", label: "Full-time", outcome: "skipped", reason: "covers full-time only; this gig is contract", blocking: false },
    { id: "remote", label: "Remote only", outcome: "fail", reason: "listing is not remote — you require remote", blocking: true },
    { id: "role-area", label: "Role area", outcome: "fail", reason: 'title matches your red keyword "intern"', blocking: false },
  ],
};

describe("failedGateRules()", () => {
  it("returns only blocking failures, in rule order", () => {
    expect(failedGateRules(FAILING).map((r) => r.id)).toEqual(["profile:p1", "remote"]);
  });
});

describe("formatGateTooltip()", () => {
  it("lists every blocking failed rule as 'Label: reason', naming the group", () => {
    expect(formatGateTooltip(FAILING, "Fractional CTO", "real-mismatch")).toBe(
      [
        "Didn't pass 2 rules in your config (Fractional CTO):",
        "• Hourly: $26/hr is below your $120/hr floor",
        "• Remote only: listing is not remote — you require remote",
      ].join("\n"),
    );
  });

  it("keeps the source-didn't-publish note first for the rate-not-comparable case", () => {
    const text = formatGateTooltip(FAILING, "G", "rate-not-comparable");
    expect(text.split("\n")[0]).toBe(RATE_NOT_COMPARABLE_TOOLTIP);
    expect(text).toContain("• Hourly:");
  });

  it("falls back to the previous fixed copy only when no explanation exists (no parseable config)", () => {
    expect(formatGateTooltip(undefined, undefined, undefined)).toBe(REAL_MISMATCH_TOOLTIP);
    expect(formatGateTooltip(undefined, undefined, "rate-not-comparable")).toBe(RATE_NOT_COMPARABLE_TOOLTIP);
  });

  it("says so (never an empty list) when the gig passes the current config", () => {
    expect(formatGateTooltip({ pass: true, rules: [] }, "G", undefined)).toMatch(/^Passes your current config \(G\)/);
  });
});
