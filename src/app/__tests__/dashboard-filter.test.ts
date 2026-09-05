import { describe, expect, it } from "vitest";
import type { StoredGig } from "@/lib/store";
import { distinctSources, isWithinSeenWindow, passesBandFilter, resolveDisplayBand, shortProfileLabel } from "../dashboard-filter";

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

describe("resolveDisplayBand", () => {
  it("returns the specific group's own band on a scoped view", () => {
    const gig = makeGig({ key: "1", matchedGroupBands: { a: "in-band", b: "out-of-band" } });
    expect(resolveDisplayBand(gig, "a")).toBe("in-band");
    expect(resolveDisplayBand(gig, "b")).toBe("out-of-band");
  });

  it("falls back to the flat matchBand on a scoped view when that specific group has no entry", () => {
    const gig = makeGig({ key: "1", matchBand: "near-band", matchedGroupBands: { other: "in-band" } });
    expect(resolveDisplayBand(gig, "not-in-map")).toBe("near-band");
  });

  it("on an unscoped view, returns the BEST band across every evaluated group (in-band > near-band > out-of-band)", () => {
    const allOutOfBand = makeGig({ key: "1", matchedGroupBands: { a: "out-of-band", b: "out-of-band" } });
    expect(resolveDisplayBand(allOutOfBand)).toBe("out-of-band");

    const oneNearBand = makeGig({ key: "2", matchedGroupBands: { a: "out-of-band", b: "near-band" } });
    expect(resolveDisplayBand(oneNearBand)).toBe("near-band");

    const oneInBand = makeGig({ key: "3", matchedGroupBands: { a: "near-band", b: "in-band", c: "out-of-band" } });
    expect(resolveDisplayBand(oneInBand)).toBe("in-band");
  });

  it("falls back to in-band (fail OPEN, never hidden by default) for a gig scanned before this epic shipped, with no band data at all -- a real CI-caught regression: failing closed here hid every pre-existing gig in the e2e fixture's database until a re-scan", () => {
    const gig = makeGig({ key: "1" });
    expect(resolveDisplayBand(gig)).toBe("in-band");
    expect(resolveDisplayBand(gig, "any-group")).toBe("in-band");
  });
});

describe("passesBandFilter", () => {
  it("drilling down to one band (filter !== 'all') always matches exactly that band, bypassing hideOutOfBand entirely", () => {
    expect(passesBandFilter("out-of-band", "out-of-band", true)).toBe(true);
    expect(passesBandFilter("in-band", "out-of-band", true)).toBe(false);
    expect(passesBandFilter("in-band", "in-band", true)).toBe(true);
  });

  it("filter 'all' with hideOutOfBand true excludes out-of-band but shows everything else", () => {
    expect(passesBandFilter("out-of-band", "all", true)).toBe(false);
    expect(passesBandFilter("in-band", "all", true)).toBe(true);
    expect(passesBandFilter("near-band", "all", true)).toBe(true);
  });

  it("filter 'all' with hideOutOfBand false shows everything, including out-of-band", () => {
    expect(passesBandFilter("out-of-band", "all", false)).toBe(true);
  });
});
