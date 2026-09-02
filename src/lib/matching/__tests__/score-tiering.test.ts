import { describe, expect, it } from "vitest";
import type { TierScoringMode } from "../../types.js";
import { computeTier } from "../score-tiering.js";

describe("computeTier: score-threshold mode", () => {
  const mode: TierScoringMode = { kind: "score-threshold", green: 0.7, yellow: 0.4 };

  it("scores at or above the green threshold tier green", () => {
    expect(computeTier(0.7, mode).tier).toBe("green");
    expect(computeTier(0.9, mode).tier).toBe("green");
  });

  it("scores between yellow and green tier yellow", () => {
    expect(computeTier(0.4, mode).tier).toBe("yellow");
    expect(computeTier(0.69, mode).tier).toBe("yellow");
  });

  it("scores below yellow tier red", () => {
    expect(computeTier(0.39, mode).tier).toBe("red");
    expect(computeTier(0, mode).tier).toBe("red");
  });

  it("every verdict carries a specific, human-readable reason naming the score and threshold", () => {
    expect(computeTier(0.8, mode).reasons[0]).toMatch(/0\.800.*green threshold 0\.7/);
    expect(computeTier(0.5, mode).reasons[0]).toMatch(/0\.500.*yellow threshold 0\.4/);
    expect(computeTier(0.1, mode).reasons[0]).toMatch(/0\.100.*yellow threshold 0\.4/);
  });
});

describe("computeTier: percentile mode", () => {
  const mode: TierScoringMode = { kind: "percentile", greenPercentile: 80, yellowPercentile: 40 };
  const population = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]; // 10 scores

  it("a score ranking at/above the greenPercentile tiers green", () => {
    // 0.85 is greater than 8 of the 10 population values (0.1..0.8) -> rank 80% -> green
    expect(computeTier(0.85, mode, population).tier).toBe("green");
  });

  it("a score ranking between yellowPercentile and greenPercentile tiers yellow", () => {
    // 0.45 is greater than 4 of 10 -> rank 40% -> yellow (>= 40th, < 80th)
    expect(computeTier(0.45, mode, population).tier).toBe("yellow");
  });

  it("a score ranking below yellowPercentile tiers red", () => {
    // 0.05 is greater than 0 of 10 -> rank 0% -> red
    expect(computeTier(0.05, mode, population).tier).toBe("red");
  });

  it("an empty population ranks at the middle (0.5) rather than always-red or always-green", () => {
    const result = computeTier(0.5, mode, []);
    // rank 0.5 >= yellowPercentile(0.4) but < greenPercentile(0.8) -> yellow
    expect(result.tier).toBe("yellow");
    expect(result.reasons[0]).toContain("0 tracked gig(s)");
  });

  it("population defaults to empty when omitted entirely", () => {
    expect(computeTier(0.5, mode).tier).toBe("yellow");
  });

  it("every verdict names the percentile rank and population size", () => {
    expect(computeTier(0.85, mode, population).reasons[0]).toMatch(/top 20%.*10 tracked gig\(s\)/);
  });
});

describe("computeTier: keyword mode is rejected, never silently mishandled", () => {
  it("throws a specific error pointing at tiering.ts's tier(), rather than returning a wrong-but-plausible tier", () => {
    expect(() => computeTier(0.5, { kind: "keyword" })).toThrow(/use tiering\.ts's tier\(\) instead/);
  });
});
