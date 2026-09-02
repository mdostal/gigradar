import { describe, expect, it } from "vitest";
import { SIGNAL_DECAY_DAYS, signalStrength } from "../dashboard-client";

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
