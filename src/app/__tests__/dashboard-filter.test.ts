import { describe, expect, it } from "vitest";
import type { StoredGig } from "@/lib/store";
import { distinctSources, isWithinSeenWindow, shortProfileLabel } from "../dashboard-filter";

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

describe("distinctSources", () => {
  it("returns each distinct sourceId present in the gigs, alphabetically sorted", () => {
    const gigs = [
      makeGig({ key: "1", sourceId: "wellfound" }),
      makeGig({ key: "2", sourceId: "ateam" }),
      makeGig({ key: "3", sourceId: "wellfound" }), // duplicate -- must not appear twice
    ];
    expect(distinctSources(gigs)).toEqual(["ateam", "wellfound"]);
  });

  it("returns an empty array for an empty gigs list", () => {
    expect(distinctSources([])).toEqual([]);
  });
});

describe("isWithinSeenWindow", () => {
  const NOW = new Date("2026-03-10T12:00:00.000Z").getTime();

  it("'any' always matches, regardless of firstSeen", () => {
    expect(isWithinSeenWindow("2020-01-01T00:00:00.000Z", "any", NOW)).toBe(true);
  });

  it("'24h': a gig seen 2 hours ago matches, one seen 2 days ago doesn't", () => {
    const twoHoursAgo = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(isWithinSeenWindow(twoHoursAgo, "24h", NOW)).toBe(true);
    expect(isWithinSeenWindow(twoDaysAgo, "24h", NOW)).toBe(false);
  });

  it("'7d': a gig seen 3 days ago matches, one seen 10 days ago doesn't", () => {
    const threeDaysAgo = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(isWithinSeenWindow(threeDaysAgo, "7d", NOW)).toBe(true);
    expect(isWithinSeenWindow(tenDaysAgo, "7d", NOW)).toBe(false);
  });

  it("'30d': a gig seen 20 days ago matches, one seen 40 days ago doesn't", () => {
    const twentyDaysAgo = new Date(NOW - 20 * 24 * 60 * 60 * 1000).toISOString();
    const fortyDaysAgo = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();
    expect(isWithinSeenWindow(twentyDaysAgo, "30d", NOW)).toBe(true);
    expect(isWithinSeenWindow(fortyDaysAgo, "30d", NOW)).toBe(false);
  });

  it("an unparseable firstSeen never matches a bounded window", () => {
    expect(isWithinSeenWindow("not-a-date", "24h", NOW)).toBe(false);
  });

  it("exactly at the boundary counts as within the window (<=, not <)", () => {
    const exactlyOneDayAgo = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
    expect(isWithinSeenWindow(exactlyOneDayAgo, "24h", NOW)).toBe(true);
  });
});

describe("shortProfileLabel", () => {
  it("extracts the leading token before an em-dash separator (real owner label shape)", () => {
    expect(shortProfileLabel("A — Fractional/Hourly ($150+)")).toBe("A");
    expect(shortProfileLabel("B — Full-Time ($250k–$400k TC)")).toBe("B");
    expect(shortProfileLabel("C — Fallback Hourly ($90–$200)")).toBe("C");
  });

  it("also splits on a plain hyphen or colon separator", () => {
    expect(shortProfileLabel("Fractional - CTO roles")).toBe("Fractional");
    expect(shortProfileLabel("Tier1: Senior roles")).toBe("Tier1");
  });

  it("uses the whole label when there is no separator", () => {
    expect(shortProfileLabel("FullTimeOnly")).toBe("FullTimeOnly");
  });

  it("trims surrounding whitespace before extracting", () => {
    expect(shortProfileLabel("  A — Fractional  ")).toBe("A");
  });
});
