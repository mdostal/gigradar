import { describe, expect, it } from "vitest";
import type { EngagementProfile, Gig } from "../../types.js";
import { gate } from "../gate.js";
import { computeMatchBand } from "../match-band.js";

// rate-band-match-quality epic, match-band-core story. Same makeGig()/
// profile-fixture convention as gate.test.ts.
function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    sourceId: "test-source",
    externalId: "1",
    title: "Fractional CTO",
    url: "https://example.test/1",
    ...overrides,
  };
}

const FRACTIONAL_HOURLY_PROFILE: EngagementProfile = {
  id: "fractional-hourly",
  label: "Fractional/Hourly",
  types: ["contract", "fractional"],
  minRate: 150,
  highRate: 285,
  maxHours: 20,
  maxHoursAtHighRate: 40,
  rateUnit: "hour",
};

const FULL_TIME_PROFILE: EngagementProfile = {
  id: "full-time",
  label: "Full-Time",
  types: ["full-time"],
  minRate: 250_000,
  highRate: 400_000,
  rateUnit: "year",
};

describe("computeMatchBand", () => {
  it("is in-band when the gig clears at least one applicable profile's real gate", () => {
    const gig = makeGig({ rate: { min: 200, unit: "hour" } });
    const result = computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15);
    expect(result.band).toBe("in-band");
  });

  it("is in-band for a gig with no published rate (matchProfiles() already treats this as an automatic pass)", () => {
    const gig = makeGig();
    const result = computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15);
    expect(result.band).toBe("in-band");
  });

  it("is near-band when the rate fails but is within tolerance of the floor", () => {
    // $150 floor, 15% tolerance -> $127.50/hr and above is near-band.
    const gig = makeGig({ rate: { min: 130, unit: "hour" } });
    const result = computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15);
    expect(result.band).toBe("near-band");
    expect(result.reasons[0]).toMatch(/near-band/);
  });

  it("is out-of-band when the rate fails by more than tolerance", () => {
    // The real live example that triggered this epic: $50-60/hr against a $150 floor.
    const gig = makeGig({ title: "AI Engineering Consultant - Part time", rate: { min: 50, max: 60, unit: "hour" } });
    const result = computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15);
    expect(result.band).toBe("out-of-band");
  });

  it("is out-of-band when no configured profile applies to the gig's engagement type at all", () => {
    const gig = makeGig({ employmentType: "full-time", rate: { min: 300_000, unit: "year" } });
    const result = computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15);
    expect(result.band).toBe("out-of-band");
  });

  it("is out-of-band for the real live salaried examples that triggered this epic", () => {
    const swe = makeGig({ title: "Software Engineer II, Backend", employmentType: "full-time", rate: { min: 146_000, max: 225_000, unit: "year" } });
    expect(computeMatchBand(swe, [FULL_TIME_PROFILE], 15).band).toBe("out-of-band");

    const cobol = makeGig({ title: "Software Developer Lead - COBOL, z/OS Mainframe", employmentType: "full-time", rate: { min: 86_000, max: 158_000, unit: "year" } });
    expect(computeMatchBand(cobol, [FULL_TIME_PROFILE], 15).band).toBe("out-of-band");
  });

  it("is near-band, not out-of-band, for a salaried rate close to the floor (unit-agnostic tolerance math)", () => {
    // $250k floor, 15% tolerance -> $212.5k and above is near-band.
    const gig = makeGig({ employmentType: "full-time", rate: { min: 220_000, unit: "year" } });
    const result = computeMatchBand(gig, [FULL_TIME_PROFILE], 15);
    expect(result.band).toBe("near-band");
  });

  it("is exactly at the tolerance boundary -> near-band (inclusive)", () => {
    // $150 floor, 15% tolerance -> exactly $127.50/hr is the boundary.
    const gig = makeGig({ rate: { min: 127.5, unit: "hour" } });
    expect(computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15).band).toBe("near-band");
  });

  it("is out-of-band just past the tolerance boundary", () => {
    const gig = makeGig({ rate: { min: 127.49, unit: "hour" } });
    expect(computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15).band).toBe("out-of-band");
  });

  it("is out-of-band when the rate clears the floor but hours blow the cap (a non-rate failure)", () => {
    const gig = makeGig({ rate: { min: 200, unit: "hour" }, weeklyHours: 30 });
    // FRACTIONAL_HOURLY_PROFILE's maxHours is 20 (below highRate 285); $200/hr doesn't reach highRate, so cap is 20.
    expect(computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15).band).toBe("out-of-band");
  });

  it("returns out-of-band when there are zero engagement profiles configured at all", () => {
    const gig = makeGig({ rate: { min: 200, unit: "hour" } });
    expect(computeMatchBand(gig, [], 15).band).toBe("out-of-band");
  });

  it("never classifies out-of-band a gig that gate() itself passes, for the same profile set", () => {
    const profile = { name: "Test", roles: [], skills: [], timezone: "UTC" };
    const needs = { engagementProfiles: [FRACTIONAL_HOURLY_PROFILE], freshStageOnly: false, remoteOnly: false };
    const gigs = [
      makeGig({ rate: { min: 150, unit: "hour" } }),
      makeGig({ rate: { min: 285, unit: "hour" }, weeklyHours: 10 }),
      makeGig(),
    ];
    for (const gig of gigs) {
      const gateResult = gate(gig, needs, profile);
      if (gateResult.pass) {
        expect(computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15).band).not.toBe("out-of-band");
      }
    }
  });

  it("includes a human-readable reason string", () => {
    const gig = makeGig({ rate: { min: 200, unit: "hour" } });
    const result = computeMatchBand(gig, [FRACTIONAL_HOURLY_PROFILE], 15);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(typeof result.reasons[0]).toBe("string");
  });
});
