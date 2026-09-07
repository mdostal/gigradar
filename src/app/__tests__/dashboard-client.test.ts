import { describe, expect, it } from "vitest";
import { REAL_MISMATCH_TOOLTIP, RATE_NOT_COMPARABLE_TOOLTIP, resolveProfileMismatchTooltip, SIGNAL_DECAY_DAYS, signalStrength } from "../dashboard-client";

// gigradar-command-center epic, Signal Deck theme: signalStrength() is the
// one pure, exported piece of the new radial signal-meter worth unit-
// testing directly -- this repo has no React Testing Library dependency
// (see layout.test.ts's own convention: assert on extracted pure data,
// not rendered SVG/DOM).
describe("signalStrength()", () => {
  it("returns 1 (full ring) for a gig seen right now", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    expect(signalStrength("2026-09-02T12:00:00.000Z", now)).toBe(1);
  });

  it("returns 1 for a firstSeen timestamp in the future (defensive -- clock skew/malformed data, never negative)", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    expect(signalStrength("2026-09-02T13:00:00.000Z", now)).toBe(1);
  });

  it("decays linearly toward the residual floor as the gig ages", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const halfway = new Date(now - (SIGNAL_DECAY_DAYS / 2) * 86_400_000).toISOString();
    expect(signalStrength(halfway, now)).toBeCloseTo(0.5, 5);
  });

  it("never drops below the residual floor (0.12) no matter how old the gig is -- a month-old green match still shows a sliver, not nothing", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const veryOld = new Date(now - 90 * 86_400_000).toISOString();
    expect(signalStrength(veryOld, now)).toBe(0.12);
  });

  it("returns 1 for a malformed firstSeen value rather than NaN propagating into the SVG arc math", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    expect(signalStrength("not-a-real-date", now)).toBe(1);
  });
});

// match-warning-tooltip-clarity-and-reliability story. resolveProfileMismatchTooltip()
// is the one piece of the ⚠ tooltip's copy-selection logic worth unit-testing
// directly (this repo has no React Testing Library dependency -- see this
// file's own header comment). The underlying "which case is this?"
// classification itself is matching/gate.ts's explainProfileMismatch(),
// tested there -- this only covers the UI's own two-message mapping.
describe("resolveProfileMismatchTooltip()", () => {
  it("'rate-not-comparable' -> the source-didn't-publish-data message", () => {
    expect(resolveProfileMismatchTooltip("rate-not-comparable")).toBe(RATE_NOT_COMPARABLE_TOOLTIP);
    expect(RATE_NOT_COMPARABLE_TOOLTIP).toMatch(/doesn't publish a rate\/hours figure/i);
  });

  it("'real-mismatch' -> the genuinely-failed-your-requirements message", () => {
    expect(resolveProfileMismatchTooltip("real-mismatch")).toBe(REAL_MISMATCH_TOOLTIP);
    expect(REAL_MISMATCH_TOOLTIP).toMatch(/didn't meet your configured rate\/hours\/engagement-type requirements/i);
  });

  it("falls back to the 'real-mismatch' message when no classification is available at all (e.g. a malformed config gate.ts's explainProfileMismatch() couldn't classify) -- the same single message this warning showed before this story", () => {
    expect(resolveProfileMismatchTooltip(undefined)).toBe(REAL_MISMATCH_TOOLTIP);
  });

  it("the two messages are genuinely different strings, never the same text with different labels", () => {
    expect(RATE_NOT_COMPARABLE_TOOLTIP).not.toBe(REAL_MISMATCH_TOOLTIP);
  });
});
