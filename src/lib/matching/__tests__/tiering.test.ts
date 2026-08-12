import { describe, expect, it } from "vitest";
import type { Gig, RoleAreaConfig } from "../../types.js";
import { EMPTY_ROLE_AREA_CONFIG, tier } from "../tiering.js";

// Golden-fixture tests, one per precedence rule from tiering.ts's doc comment
// — including the precedence-conflict case explicitly (rule 1 must win over
// rule 2 even when both terms are present in the same title).

function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    sourceId: "src-a",
    externalId: "1",
    title: "Senior Backend Engineer",
    url: "https://example.test/1",
    ...overrides,
  };
}

const config: RoleAreaConfig = {
  coreTitles: ["fractional cto", "vp of engineering"],
  keywords: ["kubernetes", "platform engineering"],
  redKeywords: ["recruiter", "sales"],
};

describe("tier: rule 1 — coreTitles matched in TITLE -> GREEN", () => {
  it("matches a core title as a whole phrase in the title", () => {
    const result = tier(makeGig({ title: "Fractional CTO for Seed-Stage Startup" }), config);
    expect(result.tier).toBe("green");
    expect(result.reasons.some((r) => r.includes("core title"))).toBe(true);
  });

  it("does not match a core title inside description only", () => {
    const result = tier(
      makeGig({ title: "Engineering Lead", description: "Basically a Fractional CTO role" }),
      config,
    );
    expect(result.tier).not.toBe("green");
  });
});

describe("tier: precedence conflict — coreTitles AND redKeywords both in title -> GREEN wins", () => {
  it("a title matching both a core title and a red keyword tiers GREEN, not RED", () => {
    // "Recruiter" (red) and "Fractional CTO" (core) both appear in this title.
    const result = tier(makeGig({ title: "Recruiter seeking Fractional CTO candidates" }), config);
    expect(result.tier).toBe("green");
    expect(result.reasons.some((r) => r.includes("core title"))).toBe(true);
    // Explainability: the conflict itself should be visible in the reasons.
    expect(result.reasons.some((r) => r.toLowerCase().includes("red keyword"))).toBe(true);
  });
});

describe("tier: rule 2 — redKeywords matched in TITLE (no coreTitles hit) -> RED", () => {
  it("matches a red keyword in the title when no core title is present", () => {
    const result = tier(makeGig({ title: "Technical Recruiter for Startups" }), config);
    expect(result.tier).toBe("red");
    expect(result.reasons.some((r) => r.includes("red keyword"))).toBe(true);
  });

  it("does not treat a redKeywords hit in the description as RED (title-only rule)", () => {
    const result = tier(
      makeGig({ title: "Senior Backend Engineer", description: "Work closely with our recruiter team" }),
      config,
    );
    expect(result.tier).not.toBe("red");
  });
});

describe("tier: rule 3 — keywords matched in TITLE+DESCRIPTION (neither above hit) -> GREEN", () => {
  it("matches a keyword in the title", () => {
    const result = tier(makeGig({ title: "Kubernetes Platform Engineer" }), config);
    expect(result.tier).toBe("green");
    expect(result.reasons.some((r) => r.includes("matched in title/description"))).toBe(true);
  });

  it("matches a keyword in the description", () => {
    const result = tier(
      makeGig({ title: "Senior Backend Engineer", description: "You'll own our Kubernetes clusters." }),
      config,
    );
    expect(result.tier).toBe("green");
  });
});

describe("tier: rule 4 — nothing matched -> YELLOW (never a hard reject)", () => {
  it("tiers YELLOW when no coreTitles, redKeywords, or keywords match", () => {
    const result = tier(makeGig({ title: "Marketing Copywriter", description: "Write blog posts." }), config);
    expect(result.tier).toBe("yellow");
    expect(result.reasons.some((r) => r.includes("YELLOW"))).toBe(true);
  });

  it("tiers YELLOW for every gig under EMPTY_ROLE_AREA_CONFIG", () => {
    const result = tier(makeGig({ title: "Anything At All" }), EMPTY_ROLE_AREA_CONFIG);
    expect(result.tier).toBe("yellow");
  });
});

describe("tier: word-boundary matching", () => {
  it("does not match a keyword as a substring of another word (\"cto\" must not match inside \"contractor\")", () => {
    const boundaryConfig: RoleAreaConfig = { coreTitles: ["cto"], keywords: [], redKeywords: [] };
    const result = tier(makeGig({ title: "Independent Contractor Needed" }), boundaryConfig);
    expect(result.tier).not.toBe("green");
    expect(result.tier).toBe("yellow");
  });

  it("still matches the whole word 'cto' on its own", () => {
    const boundaryConfig: RoleAreaConfig = { coreTitles: ["cto"], keywords: [], redKeywords: [] };
    const result = tier(makeGig({ title: "Fractional CTO" }), boundaryConfig);
    expect(result.tier).toBe("green");
  });

  it("is case-insensitive", () => {
    const result = tier(makeGig({ title: "fractional cto" }), config);
    expect(result.tier).toBe("green");
  });
});
