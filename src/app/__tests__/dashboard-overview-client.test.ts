import { describe, expect, it } from "vitest";
import type { StoredGig } from "@/lib/store";
import { computeTileValue } from "../dashboard-overview-client";

// remaining-cross-group-tier-leaks story: computeTileValue() is the one
// pure, exported piece of the overview tiles worth unit-testing directly --
// this repo has no React Testing Library dependency (see
// dashboard-client.test.ts's own convention: assert on extracted pure
// data, not rendered DOM).
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

describe("computeTileValue('readyToAct')", () => {
  it("with no groupId, counts the flat/primary-group tier -- legacy, pre-multi-group behavior", () => {
    const gigs = [makeGig({ key: "1", tier: "green" }), makeGig({ key: "2", tier: "red" })];
    expect(computeTileValue("readyToAct", gigs, undefined)).toBe(1);
  });

  it("with a groupId, counts THAT group's own tier via matchedGroupTiers, not the flat/primary-group tier -- the real cross-group leak this story closes", () => {
    // Flat tier says green (group A's verdict, e.g. the primary group), but
    // this gig is red for group B -- viewing group B's own Dashboard must
    // NOT count it toward "ready to act".
    const leakyGig = makeGig({ key: "1", tier: "green", matchedGroupTiers: { A: "green", B: "red" } });
    const genuineGig = makeGig({ key: "2", tier: "red", matchedGroupTiers: { A: "red", B: "green" } });
    expect(computeTileValue("readyToAct", [leakyGig, genuineGig], "B")).toBe(1);
  });

  it("a gig with no entry at all for the scoped group falls back to 'yellow' (never counted as ready-to-act), matching resolveDisplayTier()'s own fail-open contract", () => {
    const gig = makeGig({ key: "1", tier: "green", matchedGroupTiers: { A: "green" } });
    expect(computeTileValue("readyToAct", [gig], "B")).toBe(0);
  });
});

describe("computeTileValue() -- other tile ids are groupId-independent", () => {
  it("'newSignals' counts every 'new' status gig regardless of tier or groupId", () => {
    const gigs = [makeGig({ key: "1", status: "new", tier: "red" }), makeGig({ key: "2", status: "applied", tier: "green" })];
    expect(computeTileValue("newSignals", gigs, "B")).toBe(1);
  });

  it("'inPlay' counts applied+interview gigs regardless of groupId", () => {
    const gigs = [makeGig({ key: "1", status: "applied" }), makeGig({ key: "2", status: "interview" }), makeGig({ key: "3", status: "new" })];
    expect(computeTileValue("inPlay", gigs, "B")).toBe(2);
  });

  it("'trackedTotal' counts every gig regardless of groupId", () => {
    const gigs = [makeGig({ key: "1" }), makeGig({ key: "2" })];
    expect(computeTileValue("trackedTotal", gigs, "B")).toBe(2);
  });
});
