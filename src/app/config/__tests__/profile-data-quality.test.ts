import { describe, expect, it } from "vitest";
import { findRoleSkillOverlap } from "../profile-data-quality";

describe("findRoleSkillOverlap", () => {
  it("finds a case-insensitive, trimmed exact match between roles and skills -- the live-verified real contamination shape", () => {
    const roles = ["Fractional CTO", "Principal Architect", "Strategic CTO"];
    const skills = ["Fractional CTO", "Principal Architect", "TypeScript", "AWS"];

    expect(findRoleSkillOverlap(roles, skills)).toEqual(["Fractional CTO", "Principal Architect"]);
  });

  it("returns [] when there is no overlap", () => {
    expect(findRoleSkillOverlap(["Fractional CTO"], ["TypeScript", "AWS"])).toEqual([]);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(findRoleSkillOverlap(["Fractional CTO"], ["  fractional cto  "])).toEqual(["  fractional cto  "]);
  });

  it("ignores blank entries in either list", () => {
    expect(findRoleSkillOverlap(["", "Fractional CTO"], ["", "Fractional CTO"])).toEqual(["Fractional CTO"]);
  });

  it("deduplicates a skill that appears more than once", () => {
    expect(findRoleSkillOverlap(["Fractional CTO"], ["Fractional CTO", "Fractional CTO"])).toEqual(["Fractional CTO"]);
  });

  it("returns [] for empty roles or empty skills", () => {
    expect(findRoleSkillOverlap([], ["TypeScript"])).toEqual([]);
    expect(findRoleSkillOverlap(["Fractional CTO"], [])).toEqual([]);
  });
});
