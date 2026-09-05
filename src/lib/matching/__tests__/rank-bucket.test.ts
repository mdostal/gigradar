import { describe, expect, it } from "vitest";
import type { Gig, RankBucketRule } from "../../types.js";
import { assignRankBucket } from "../rank-bucket.js";

// rank-buckets epic, rank-bucket-core story.
function makeGig(overrides: Partial<Gig> = {}): Gig {
  return {
    sourceId: "test-source",
    externalId: "1",
    title: "Fractional CTO",
    url: "https://example.test/1",
    ...overrides,
  };
}

describe("assignRankBucket", () => {
  it("returns null with zero configured rules", () => {
    const result = assignRankBucket(makeGig(), []);
    expect(result.bucket).toBeNull();
  });

  it("a rule with NO criteria at all matches nothing -- never a silent catch-all", () => {
    const rules: RankBucketRule[] = [{ label: "Tier 1" }];
    const result = assignRankBucket(makeGig({ rate: { min: 999, unit: "hour" } }), rules);
    expect(result.bucket).toBeNull();
  });

  it("assigns by a minRate-only rule", () => {
    const rules: RankBucketRule[] = [{ label: "Premium", minRate: 200 }];
    expect(assignRankBucket(makeGig({ rate: { min: 250, unit: "hour" } }), rules).bucket).toBe("Premium");
    expect(assignRankBucket(makeGig({ rate: { min: 150, unit: "hour" } }), rules).bucket).toBeNull();
  });

  it("assigns by a maxRate-only rule", () => {
    const rules: RankBucketRule[] = [{ label: "Budget", maxRate: 100 }];
    expect(assignRankBucket(makeGig({ rate: { min: 80, unit: "hour" } }), rules).bucket).toBe("Budget");
    expect(assignRankBucket(makeGig({ rate: { min: 150, unit: "hour" } }), rules).bucket).toBeNull();
  });

  it("assigns by a keywords-only rule, whole-word, case-insensitive", () => {
    const rules: RankBucketRule[] = [{ label: "Leadership", keywords: ["CTO"] }];
    expect(assignRankBucket(makeGig({ title: "Fractional cto" }), rules).bucket).toBe("Leadership");
    expect(assignRankBucket(makeGig({ title: "Contractor" }), rules).bucket).toBeNull(); // "cto" must not match inside "Contractor"
  });

  it("a rule with BOTH rate and keywords requires ALL of them to match (AND within one rule)", () => {
    const rules: RankBucketRule[] = [{ label: "Elite", minRate: 200, keywords: ["CTO"] }];
    expect(assignRankBucket(makeGig({ title: "Fractional CTO", rate: { min: 250, unit: "hour" } }), rules).bucket).toBe("Elite");
    // Rate matches, keyword doesn't.
    expect(assignRankBucket(makeGig({ title: "Fractional Engineer", rate: { min: 250, unit: "hour" } }), rules).bucket).toBeNull();
    // Keyword matches, rate doesn't.
    expect(assignRankBucket(makeGig({ title: "Fractional CTO", rate: { min: 100, unit: "hour" } }), rules).bucket).toBeNull();
  });

  it("a rate criterion with no published rate on the gig never matches", () => {
    const rules: RankBucketRule[] = [{ label: "Premium", minRate: 200 }];
    expect(assignRankBucket(makeGig(), rules).bucket).toBeNull();
  });

  it("first match wins, in declared order -- a later rule that would ALSO match is never reached", () => {
    const rules: RankBucketRule[] = [
      { label: "Tier 1", minRate: 150 },
      { label: "Tier 2", minRate: 100 },
    ];
    const gig = makeGig({ rate: { min: 300, unit: "hour" } }); // clears BOTH rules' thresholds
    expect(assignRankBucket(gig, rules).bucket).toBe("Tier 1");
  });

  it("falls through to a later rule when an earlier one doesn't match", () => {
    const rules: RankBucketRule[] = [
      { label: "Tier 1", minRate: 250 },
      { label: "Tier 2", minRate: 100 },
    ];
    const gig = makeGig({ rate: { min: 150, unit: "hour" } }); // fails Tier 1, clears Tier 2
    expect(assignRankBucket(gig, rules).bucket).toBe("Tier 2");
  });

  it("keyword matching reuses tiering.ts's exact whole-word/multi-word-phrase semantics", () => {
    const rules: RankBucketRule[] = [{ label: "CTO Roles", keywords: ["fractional cto"] }];
    expect(assignRankBucket(makeGig({ title: "Fractional CTO at Acme" }), rules).bucket).toBe("CTO Roles");
    expect(assignRankBucket(makeGig({ title: "Fractional Engineer, CTO advisory" }), rules).bucket).toBeNull(); // phrase not contiguous
  });

  it("includes human-readable reasons for both matched and unmatched cases", () => {
    const rules: RankBucketRule[] = [{ label: "Premium", minRate: 200 }];
    const matched = assignRankBucket(makeGig({ rate: { min: 250, unit: "hour" } }), rules);
    expect(matched.reasons.length).toBeGreaterThan(0);
    expect(matched.reasons[0]).toMatch(/assigned to "Premium"/);

    const unmatched = assignRankBucket(makeGig({ rate: { min: 50, unit: "hour" } }), rules);
    expect(unmatched.reasons.length).toBeGreaterThan(0);
    expect(unmatched.reasons[0]).toMatch(/no configured rule matched/);
  });
});
