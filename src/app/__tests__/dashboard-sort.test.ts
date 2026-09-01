import { describe, expect, it } from "vitest";
import type { StoredGig } from "@/lib/store";
import { sortGigs } from "../dashboard-sort";

function makeGig(overrides: Partial<StoredGig> & { key: string }): StoredGig {
  return {
    sourceId: "src-a",
    externalId: overrides.key,
    title: "Fractional CTO",
    url: `https://example.test/${overrides.key}`,
    status: "new",
    outcomeReason: null,
    outcomeNote: null,
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    unavailableSince: null,
    reappearedAt: null,
    ...overrides,
  };
}

describe("sortGigs", () => {
  it("sort === null returns the gigs unchanged (a fresh copy, same order)", () => {
    const gigs = [makeGig({ key: "1" }), makeGig({ key: "2" })];
    const result = sortGigs(gigs, null);
    expect(result.map((g) => g.key)).toEqual(["1", "2"]);
    expect(result).not.toBe(gigs);
  });

  it("source: ascending alphabetical", () => {
    const gigs = [makeGig({ key: "1", sourceId: "wellfound" }), makeGig({ key: "2", sourceId: "ateam" })];
    const result = sortGigs(gigs, { field: "source", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["2", "1"]);
  });

  it("source: descending reverses it", () => {
    const gigs = [makeGig({ key: "1", sourceId: "wellfound" }), makeGig({ key: "2", sourceId: "ateam" })];
    const result = sortGigs(gigs, { field: "source", direction: "desc" });
    expect(result.map((g) => g.key)).toEqual(["1", "2"]);
  });

  it("title: ascending alphabetical", () => {
    const gigs = [makeGig({ key: "1", title: "VP Engineering" }), makeGig({ key: "2", title: "Fractional CTO" })];
    const result = sortGigs(gigs, { field: "title", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["2", "1"]);
  });

  it("company: missing company always sorts last, in both directions", () => {
    const gigs = [
      makeGig({ key: "1", company: "Zebra Inc" }),
      makeGig({ key: "2", company: undefined }),
      makeGig({ key: "3", company: "Acme" }),
    ];
    expect(sortGigs(gigs, { field: "company", direction: "asc" }).map((g) => g.key)).toEqual(["3", "1", "2"]);
    expect(sortGigs(gigs, { field: "company", direction: "desc" }).map((g) => g.key)).toEqual(["1", "3", "2"]);
  });

  it("tier: ascending is green < yellow < red < untiered, NOT alphabetical", () => {
    const gigs = [
      makeGig({ key: "1", tier: "red" }),
      makeGig({ key: "2", tier: undefined }),
      makeGig({ key: "3", tier: "green" }),
      makeGig({ key: "4", tier: "yellow" }),
    ];
    const result = sortGigs(gigs, { field: "tier", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["3", "4", "1", "2"]);
  });

  it("tier: descending is red < yellow < green, untiered still last", () => {
    const gigs = [
      makeGig({ key: "1", tier: "green" }),
      makeGig({ key: "2", tier: undefined }),
      makeGig({ key: "3", tier: "red" }),
    ];
    const result = sortGigs(gigs, { field: "tier", direction: "desc" });
    expect(result.map((g) => g.key)).toEqual(["3", "1", "2"]);
  });

  it("status: follows the lifecycle order (new -> applied -> interview -> archived -> ignored), not alphabetical", () => {
    const gigs = [
      makeGig({ key: "1", status: "ignored" }),
      makeGig({ key: "2", status: "new" }),
      makeGig({ key: "3", status: "interview" }),
    ];
    const result = sortGigs(gigs, { field: "status", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["2", "3", "1"]);
  });

  it("rate: sorts by rate.min, missing rate sorts last", () => {
    const gigs = [
      makeGig({ key: "1", rate: { min: 300, unit: "hour" } }),
      makeGig({ key: "2", rate: undefined }),
      makeGig({ key: "3", rate: { min: 150, unit: "hour" } }),
    ];
    const result = sortGigs(gigs, { field: "rate", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["3", "1", "2"]);
  });

  it("rate: a gig with only rate.max (no min) sorts by missing min, not by max", () => {
    const gigs = [
      makeGig({ key: "1", rate: { min: 100, unit: "hour" } }),
      makeGig({ key: "2", rate: { max: 500, unit: "hour" } }),
    ];
    const result = sortGigs(gigs, { field: "rate", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["1", "2"]);
  });

  it("weeklyHours: numeric ascending, missing sorts last", () => {
    const gigs = [
      makeGig({ key: "1", weeklyHours: 40 }),
      makeGig({ key: "2", weeklyHours: undefined }),
      makeGig({ key: "3", weeklyHours: 10 }),
    ];
    const result = sortGigs(gigs, { field: "weeklyHours", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["3", "1", "2"]);
  });

  it("firstSeen: ISO 8601 lexicographic order matches chronological order", () => {
    const gigs = [
      makeGig({ key: "1", firstSeen: "2026-03-01T00:00:00.000Z" }),
      makeGig({ key: "2", firstSeen: "2026-01-15T00:00:00.000Z" }),
      makeGig({ key: "3", firstSeen: "2026-02-10T00:00:00.000Z" }),
    ];
    const result = sortGigs(gigs, { field: "firstSeen", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["2", "3", "1"]);
  });

  it("is a stable sort -- equal-rank gigs keep their relative input order", () => {
    const gigs = [
      makeGig({ key: "1", tier: "green" }),
      makeGig({ key: "2", tier: "green" }),
      makeGig({ key: "3", tier: "green" }),
    ];
    const result = sortGigs(gigs, { field: "tier", direction: "asc" });
    expect(result.map((g) => g.key)).toEqual(["1", "2", "3"]);
  });
});
