import { describe, expect, it } from "vitest";
import type { StoredDraft, StoredGig } from "@/lib/store";
import {
  computeDiscoveredByDay,
  computeDraftFunnel,
  computeOutcomeCounts,
  computeRunRate,
  computeStatusCounts,
  computeSubmissionsByDay,
  filterDraftsByRange,
  filterGigsByRange,
} from "../metrics-calc";

// gigradar-command-center epic, metrics-page story. Pure rollup logic --
// this repo has no React Testing Library dependency, so metrics-calc.ts's
// functions are the assertable contract (same convention dashboard-filter.ts's
// own tests already establish).

function makeGig(overrides: Partial<StoredGig> & { key: string }): StoredGig {
  return {
    sourceId: "braintrust",
    externalId: overrides.key,
    title: "Fractional CTO",
    url: `https://example.test/${overrides.key}`,
    status: "new",
    outcomeReason: null,
    outcomeNote: null,
    firstSeen: "2026-09-01T00:00:00.000Z",
    lastSeen: "2026-09-01T00:00:00.000Z",
    unavailableSince: null,
    reappearedAt: null,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<StoredDraft> & { gigKey: string }): StoredDraft {
  return {
    content: { coverText: "Dear team...", answers: {} },
    status: "draft",
    generatedAt: "2026-09-01T00:00:00.000Z",
    approvedAt: null,
    submittedAt: null,
    ...overrides,
  };
}

describe("computeStatusCounts", () => {
  it("counts every real status, including zero for statuses with no gigs", () => {
    const gigs = [makeGig({ key: "1", status: "new" }), makeGig({ key: "2", status: "new" }), makeGig({ key: "3", status: "applied" })];
    expect(computeStatusCounts(gigs)).toEqual({ new: 2, applied: 1, interview: 0, archived: 0, ignored: 0 });
  });
});

describe("computeOutcomeCounts", () => {
  it("only counts archived gigs that carry a real outcomeReason -- never a plain archived-with-no-reason gig", () => {
    const gigs = [
      makeGig({ key: "1", status: "archived", outcomeReason: "rejected" }),
      makeGig({ key: "2", status: "archived", outcomeReason: "rejected" }),
      makeGig({ key: "3", status: "archived", outcomeReason: "withdrawn" }),
      makeGig({ key: "4", status: "archived", outcomeReason: null }),
      makeGig({ key: "5", status: "ignored", outcomeReason: null }),
    ];
    expect(computeOutcomeCounts(gigs)).toEqual({ rejected: 2, withdrawn: 1, expired_unapplied: 0 });
  });
});

describe("computeDraftFunnel", () => {
  it("counts every real draft status", () => {
    const drafts = [
      makeDraft({ gigKey: "1", status: "draft" }),
      makeDraft({ gigKey: "2", status: "approved" }),
      makeDraft({ gigKey: "3", status: "submitted" }),
      makeDraft({ gigKey: "4", status: "submitted" }),
    ];
    expect(computeDraftFunnel(drafts)).toEqual({ draft: 1, approved: 1, rejected: 0, submitted: 2, submitting: 0 });
  });
});

describe("computeSubmissionsByDay", () => {
  it("builds a dense window with zero-count days present, not silently absent", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const buckets = computeSubmissionsByDay([], 3, now);
    expect(buckets).toEqual([
      { date: "2026-08-31", count: 0 },
      { date: "2026-09-01", count: 0 },
      { date: "2026-09-02", count: 0 },
    ]);
  });

  it("buckets real submissions by their submittedAt calendar day", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const drafts = [
      makeDraft({ gigKey: "1", status: "submitted", submittedAt: "2026-09-01T08:00:00.000Z" }),
      makeDraft({ gigKey: "2", status: "submitted", submittedAt: "2026-09-01T20:00:00.000Z" }),
      makeDraft({ gigKey: "3", status: "submitted", submittedAt: "2026-09-02T09:00:00.000Z" }),
    ];
    const buckets = computeSubmissionsByDay(drafts, 3, now);
    expect(buckets.find((b) => b.date === "2026-09-01")?.count).toBe(2);
    expect(buckets.find((b) => b.date === "2026-09-02")?.count).toBe(1);
    expect(buckets.find((b) => b.date === "2026-08-31")?.count).toBe(0);
  });

  it("never counts a draft with no submittedAt (not yet submitted)", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const drafts = [makeDraft({ gigKey: "1", status: "draft", submittedAt: null })];
    const buckets = computeSubmissionsByDay(drafts, 3, now);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(0);
  });

  it("ignores a submission outside the requested window", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const drafts = [makeDraft({ gigKey: "1", status: "submitted", submittedAt: "2026-08-01T00:00:00.000Z" })];
    const buckets = computeSubmissionsByDay(drafts, 3, now);
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(0);
  });
});

describe("computeDiscoveredByDay", () => {
  it("buckets gigs by their firstSeen calendar day", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const gigs = [makeGig({ key: "1", firstSeen: "2026-09-02T01:00:00.000Z" }), makeGig({ key: "2", firstSeen: "2026-09-02T23:00:00.000Z" })];
    const buckets = computeDiscoveredByDay(gigs, 3, now);
    expect(buckets.find((b) => b.date === "2026-09-02")?.count).toBe(2);
  });
});

describe("computeRunRate", () => {
  it("averages real submissions across the full window, including zero-submission days", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    const drafts = [
      makeDraft({ gigKey: "1", status: "submitted", submittedAt: "2026-09-01T08:00:00.000Z" }),
      makeDraft({ gigKey: "2", status: "submitted", submittedAt: "2026-09-02T08:00:00.000Z" }),
    ];
    // 2 submissions over a 4-day window -> 0.5/day.
    expect(computeRunRate(drafts, 4, now)).toBe(0.5);
  });

  it("returns 0 for an empty draft set, never NaN/Infinity", () => {
    const now = Date.parse("2026-09-02T12:00:00.000Z");
    expect(computeRunRate([], 30, now)).toBe(0);
  });
});

describe("filterGigsByRange", () => {
  const now = Date.parse("2026-09-30T00:00:00.000Z");
  const gigs = [
    makeGig({ key: "recent", firstSeen: "2026-09-29T00:00:00.000Z" }),
    makeGig({ key: "old", firstSeen: "2026-08-01T00:00:00.000Z" }),
  ];

  it('"all" matches every gig regardless of age', () => {
    expect(filterGigsByRange(gigs, "all", now)).toHaveLength(2);
  });

  it('"7d" excludes a gig first seen well outside the window', () => {
    const result = filterGigsByRange(gigs, "7d", now);
    expect(result.map((g) => g.externalId)).toEqual(["recent"]);
  });
});

describe("filterDraftsByRange", () => {
  const now = Date.parse("2026-09-30T00:00:00.000Z");
  const drafts = [
    makeDraft({ gigKey: "recent", generatedAt: "2026-09-29T00:00:00.000Z" }),
    makeDraft({ gigKey: "old", generatedAt: "2026-08-01T00:00:00.000Z" }),
  ];

  it("filters on generatedAt, not submittedAt -- a never-submitted draft must still be included within range", () => {
    const result = filterDraftsByRange(drafts, "7d", now);
    expect(result.map((d) => d.gigKey)).toEqual(["recent"]);
  });
});
