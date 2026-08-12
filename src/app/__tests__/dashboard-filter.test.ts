import { describe, expect, it } from "vitest";
import type { StoredGig } from "@/lib/store";
import { filterGigs } from "../dashboard-filter";

function makeGig(overrides: Partial<StoredGig> & { key: string }): StoredGig {
  return {
    sourceId: "src-a",
    externalId: overrides.key,
    title: "Fractional CTO",
    url: `https://example.test/${overrides.key}`,
    status: "new",
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    unavailableSince: null,
    reappearedAt: null,
    ...overrides,
  };
}

const ALL_STATUSES = new Set<StoredGig["status"]>(["new", "applied", "interview", "archived", "ignored"]);

describe("filterGigs", () => {
  it("tier filter: 'all' passes every gig regardless of tier", () => {
    const gigs = [makeGig({ key: "1", tier: "green" }), makeGig({ key: "2", tier: undefined })];
    expect(filterGigs(gigs, { tier: "all", statuses: ALL_STATUSES, search: "" })).toHaveLength(2);
  });

  it("tier filter: a specific tier excludes non-matching and untiered gigs", () => {
    const gigs = [
      makeGig({ key: "1", tier: "green" }),
      makeGig({ key: "2", tier: "yellow" }),
      makeGig({ key: "3", tier: undefined }),
    ];
    const result = filterGigs(gigs, { tier: "green", statuses: ALL_STATUSES, search: "" });
    expect(result.map((g) => g.key)).toEqual(["1"]);
  });

  it("status filter: only gigs whose status is in the checked set pass", () => {
    const gigs = [makeGig({ key: "1", status: "new" }), makeGig({ key: "2", status: "applied" })];
    const result = filterGigs(gigs, { tier: "all", statuses: new Set(["applied"]), search: "" });
    expect(result.map((g) => g.key)).toEqual(["2"]);
  });

  it("combines tier and status as AND, not OR", () => {
    const gigs = [
      makeGig({ key: "1", tier: "green", status: "new" }), // tier matches, status doesn't
      makeGig({ key: "2", tier: "red", status: "applied" }), // status matches, tier doesn't
      makeGig({ key: "3", tier: "green", status: "applied" }), // both match
    ];
    const result = filterGigs(gigs, { tier: "green", statuses: new Set(["applied"]), search: "" });
    expect(result.map((g) => g.key)).toEqual(["3"]);
  });

  it("search matches company or title, case-insensitively, as a substring", () => {
    const gigs = [
      makeGig({ key: "1", title: "Fractional CTO", company: "Acme" }),
      makeGig({ key: "2", title: "Backend Engineer", company: "Other Co" }),
      makeGig({ key: "3", title: "Something", company: "ACME Corp" }),
    ];
    const byTitle = filterGigs(gigs, { tier: "all", statuses: ALL_STATUSES, search: "fractional" });
    expect(byTitle.map((g) => g.key)).toEqual(["1"]);

    const byCompany = filterGigs(gigs, { tier: "all", statuses: ALL_STATUSES, search: "acme" });
    expect(byCompany.map((g) => g.key)).toEqual(["1", "3"]);
  });

  it("empty search matches everything", () => {
    const gigs = [makeGig({ key: "1" }), makeGig({ key: "2" })];
    expect(filterGigs(gigs, { tier: "all", statuses: ALL_STATUSES, search: "   " })).toHaveLength(2);
  });

  it("all three filters combine as AND", () => {
    const gigs = [
      makeGig({ key: "1", tier: "green", status: "applied", title: "Fractional CTO", company: "Acme" }),
      makeGig({ key: "2", tier: "green", status: "applied", title: "Backend Engineer", company: "Acme" }),
    ];
    const result = filterGigs(gigs, {
      tier: "green",
      statuses: new Set(["applied"]),
      search: "fractional",
    });
    expect(result.map((g) => g.key)).toEqual(["1"]);
  });
});
