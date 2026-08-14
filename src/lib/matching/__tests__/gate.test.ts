import { describe, expect, it } from "vitest";
import type { EngagementProfile, Gig, Needs, Profile } from "../../types.js";
import { effectiveEngagementType, gate } from "../gate.js";

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    sourceId: "test-source",
    externalId: "1",
    title: "Fractional CTO",
    url: "https://example.test/1",
    ...overrides,
  };
}

const EMPTY_PROFILE: Profile = { name: "Test User", roles: [], skills: [], timezone: "UTC" };

const FRACTIONAL_CONTRACT_PROFILE: EngagementProfile = {
  id: "fractional-contract",
  label: "Fractional/contract",
  types: ["contract", "fractional"],
  minRate: 250,
  highRate: 300,
  maxHours: 20,
  maxHoursAtHighRate: 40,
  rateUnit: "hour",
};

const FULL_TIME_700K_PROFILE: EngagementProfile = {
  id: "full-time-700k",
  label: "Full-time (700k+)",
  types: ["full-time"],
  minRate: 700_000,
  highRate: 900_000,
  rateUnit: "year",
};

const CTH_PROFILE: EngagementProfile = {
  id: "cth",
  label: "Contract-to-hire",
  types: ["contract-to-hire"],
  minRate: 200,
  highRate: 220,
  maxHours: 40,
  maxHoursAtHighRate: 40,
  rateUnit: "hour",
};

function makeNeeds(engagementProfiles: EngagementProfile[], overrides: Partial<Needs> = {}): Needs {
  return { engagementProfiles, freshStageOnly: false, remoteOnly: false, ...overrides };
}

describe("effectiveEngagementType", () => {
  it("contractToHire === true takes priority over employmentType", () => {
    const gig = makeGig({ contractToHire: true, employmentType: "full-time" });
    expect(effectiveEngagementType(gig)).toBe("contract-to-hire");
  });

  it("falls back to the explicit employmentType signal when contractToHire isn't set", () => {
    const gig = makeGig({ employmentType: "full-time" });
    expect(effectiveEngagementType(gig)).toBe("full-time");
  });

  it("infers 'full-time' from a $/year rate when there's no other signal", () => {
    const gig = makeGig({ rate: { min: 150_000, unit: "year" } });
    expect(effectiveEngagementType(gig)).toBe("full-time");
  });

  it("returns undefined when there's no signal at all (hourly or unpriced listing)", () => {
    expect(effectiveEngagementType(makeGig())).toBeUndefined();
    expect(effectiveEngagementType(makeGig({ rate: { min: 200, unit: "hour" } }))).toBeUndefined();
  });
});

describe("gate: the user's own worked example (fractional @ $250/hr, full-time only above $700k)", () => {
  const needs = makeNeeds([FRACTIONAL_CONTRACT_PROFILE, FULL_TIME_700K_PROFILE]);

  it("a $260/hr contract gig clears the fractional/contract profile", () => {
    const gig = makeGig({ rate: { min: 260, unit: "hour" }, weeklyHours: 15 });
    const result = gate(gig, needs, EMPTY_PROFILE);
    expect(result.pass).toBe(true);
    expect(result.matchedProfiles).toEqual(["fractional-contract"]);
  });

  it("a $500,000/yr full-time listing is EXCLUDED -- doesn't clear the $700k floor, and no other profile covers full-time", () => {
    const gig = makeGig({ rate: { min: 500_000, unit: "year" } });
    const result = gate(gig, needs, EMPTY_PROFILE);
    expect(result.pass).toBe(false);
    expect(result.matchedProfiles).toEqual([]);
    expect(result.reasons.some((r) => r.includes("500,000") && r.includes("700,000"))).toBe(true);
  });

  it("a $750,000/yr full-time listing clears the full-time-700k profile", () => {
    const gig = makeGig({ rate: { min: 750_000, unit: "year" } });
    const result = gate(gig, needs, EMPTY_PROFILE);
    expect(result.pass).toBe(true);
    expect(result.matchedProfiles).toEqual(["full-time-700k"]);
  });
});

describe("gate: multi-match -- a gig can clear more than one profile at once", () => {
  it("marks every profile a gig clears, not just the first", () => {
    const needs = makeNeeds([FRACTIONAL_CONTRACT_PROFILE, CTH_PROFILE]);
    // contractToHire=true makes the effective type "contract-to-hire" ONLY
    // (see effectiveEngagementType's priority order) -- so only the CTH
    // profile is applicable here, not the fractional/contract one. This
    // test instead proves multi-match via two profiles that share a type.
    const sharedTypeProfileA: EngagementProfile = { ...FRACTIONAL_CONTRACT_PROFILE, id: "profile-a", minRate: 200 };
    const sharedTypeProfileB: EngagementProfile = { ...FRACTIONAL_CONTRACT_PROFILE, id: "profile-b", minRate: 240 };
    const multiNeeds = makeNeeds([sharedTypeProfileA, sharedTypeProfileB]);
    const gig = makeGig({ rate: { min: 260, unit: "hour" }, weeklyHours: 10 });
    const result = gate(gig, multiNeeds, EMPTY_PROFILE);
    expect(result.pass).toBe(true);
    expect(result.matchedProfiles.sort()).toEqual(["profile-a", "profile-b"]);
  });
});

describe("gate: contract-to-hire routes to its own profile, distinct from plain contract/fractional", () => {
  const needs = makeNeeds([FRACTIONAL_CONTRACT_PROFILE, CTH_PROFILE]);

  it("a contractToHire=true gig at $210/hr clears the CTH profile even though it's below the fractional profile's floor", () => {
    const gig = makeGig({ contractToHire: true, rate: { min: 210, unit: "hour" }, weeklyHours: 30 });
    const result = gate(gig, needs, EMPTY_PROFILE);
    expect(result.pass).toBe(true);
    expect(result.matchedProfiles).toEqual(["cth"]);
  });

  it("a contractToHire=true gig is excluded entirely when no profile accepts 'contract-to-hire'", () => {
    const gig = makeGig({ contractToHire: true, rate: { min: 260, unit: "hour" } });
    const result = gate(gig, makeNeeds([FRACTIONAL_CONTRACT_PROFILE]), EMPTY_PROFILE);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes('"contract-to-hire" not accepted'))).toBe(true);
  });
});

describe("gate: BuiltIn's real employmentType signal (FULL_TIME -> 'full-time')", () => {
  it("an explicit employmentType routes the same as inferring from a $/year rate", () => {
    const gig = makeGig({ employmentType: "full-time", rate: { min: 750_000, unit: "year" } });
    const result = gate(gig, makeNeeds([FULL_TIME_700K_PROFILE]), EMPTY_PROFILE);
    expect(result.pass).toBe(true);
    expect(result.matchedProfiles).toEqual(["full-time-700k"]);
  });
});

describe("gate: unknown engagement type falls back to hourly profiles (backward compatible with pre-profile behavior)", () => {
  const needs = makeNeeds([FRACTIONAL_CONTRACT_PROFILE, FULL_TIME_700K_PROFILE]);

  it("an unpriced, unlabeled gig passes permissively against the hourly profile, same as before this feature existed", () => {
    const gig = makeGig();
    const result = gate(gig, needs, EMPTY_PROFILE);
    expect(result.pass).toBe(true);
    expect(result.matchedProfiles).toEqual(["fractional-contract"]);
    expect(result.reasons.some((r) => r.includes("rate not published"))).toBe(true);
  });

  it("an hourly-priced but unlabeled gig is never checked against the full-time profile", () => {
    const gig = makeGig({ rate: { min: 260, unit: "hour" } });
    const result = gate(gig, needs, EMPTY_PROFILE);
    expect(result.matchedProfiles).toEqual(["fractional-contract"]);
  });
});

describe("gate: hours cap is per-profile", () => {
  it("weeklyHours over the matched profile's cap fails, even though the rate clears", () => {
    const gig = makeGig({ rate: { min: 260, unit: "hour" }, weeklyHours: 30 }); // 260 < highRate(300) -> capped at maxHours(20)
    const result = gate(gig, makeNeeds([FRACTIONAL_CONTRACT_PROFILE]), EMPTY_PROFILE);
    expect(result.pass).toBe(false);
    expect(result.matchedProfiles).toEqual([]);
  });

  it("a high-enough rate unlocks the higher hours cap", () => {
    const gig = makeGig({ rate: { min: 300, unit: "hour" }, weeklyHours: 35 }); // >= highRate(300) -> capped at maxHoursAtHighRate(40)
    const result = gate(gig, makeNeeds([FRACTIONAL_CONTRACT_PROFILE]), EMPTY_PROFILE);
    expect(result.pass).toBe(true);
    expect(result.matchedProfiles).toEqual(["fractional-contract"]);
  });
});

describe("gate: other checks are unaffected by the engagement-profiles rewrite", () => {
  it("freshStageOnly still excludes a stale gig", () => {
    const gig = makeGig({ rate: { min: 260, unit: "hour" }, stage: "stale" });
    const needs = makeNeeds([FRACTIONAL_CONTRACT_PROFILE], { freshStageOnly: true });
    const result = gate(gig, needs, EMPTY_PROFILE);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes('stage "stale" not fresh'))).toBe(true);
  });

  it("remoteOnly still excludes a non-remote gig", () => {
    const gig = makeGig({ rate: { min: 260, unit: "hour" }, remote: false });
    const needs = makeNeeds([FRACTIONAL_CONTRACT_PROFILE], { remoteOnly: true });
    const result = gate(gig, needs, EMPTY_PROFILE);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("not remote"))).toBe(true);
  });

  it("role/skill fit still gates on zero keyword overlap", () => {
    const gig = makeGig({ rate: { min: 260, unit: "hour" }, title: "Warehouse Associate", description: "" });
    const profile: Profile = { name: "Test User", roles: ["Fractional CTO"], skills: ["Kubernetes"], timezone: "UTC" };
    const result = gate(gig, makeNeeds([FRACTIONAL_CONTRACT_PROFILE]), profile);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("no role/skill keyword match"))).toBe(true);
    // Still records the profile match even though the overall gate fails on fit --
    // matchedProfiles reflects rate/hours/type clearance specifically, not the final pass/fail.
    expect(result.matchedProfiles).toEqual(["fractional-contract"]);
  });
});

describe("gate: no applicable profile at all produces a clear, distinct reason from 'rate too low'", () => {
  it("a full-time gig with zero full-time profiles configured names the type in the failure reason", () => {
    const gig = makeGig({ employmentType: "full-time", rate: { min: 750_000, unit: "year" } });
    const result = gate(gig, makeNeeds([FRACTIONAL_CONTRACT_PROFILE]), EMPTY_PROFILE);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes('"full-time" not accepted by any configured profile'))).toBe(true);
  });
});
