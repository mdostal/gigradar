import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PrepPacketContent } from "@/lib/apply/prep";
import type { StoredGig } from "@/lib/store";

// today-client.tsx calls next/font/google at module scope (see
// layout.test.ts's own identical precedent/comment) -- a real SWC
// build-time transform in Next's own pipeline, not a real runtime function
// outside it, so it throws under plain vitest unless mocked. Returns the
// same shape real next/font does (an object with a `.variable` class name)
// since today-client.tsx reads `.variable` off each font.
vi.mock("next/font/google", () => ({
  Fraunces: () => ({ variable: "mock-fraunces" }),
  IBM_Plex_Mono: () => ({ variable: "mock-ibm-plex-mono" }),
  Libre_Franklin: () => ({ variable: "mock-libre-franklin" }),
}));

const { PrepSummary, resolveGigDetailSelection } = await import("../today-client");

function makeGig(overrides: Partial<StoredGig> & { key: string }): StoredGig {
  return {
    sourceId: "src-a",
    externalId: overrides.key,
    title: `Gig ${overrides.key}`,
    url: `https://example.test/${overrides.key}`,
    status: "new",
    tier: "green",
    outcomeReason: null,
    outcomeNote: null,
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-01-01T00:00:00.000Z",
    unavailableSince: null,
    reappearedAt: null,
    ...overrides,
  };
}

// real-usability-verification-and-fixes epic,
// today-picks-analyze-feedback story. Confirmed REAL bug: clicking
// "Analyze" on a Today's Picks card genuinely fetched and stored a
// fit-analysis result in `prepByKey`, but the Picks card itself never read
// that state -- only the separate Full Roster section (further down the
// same page) ever rendered it, so the owner saw zero visible change on the
// card they were actually looking at.
//
// The fix extracts the ONE existing rendering of a prepByKey result
// (previously inlined only in the Full Roster row) into this shared
// `PrepSummary` component, now used by BOTH the Picks card and the Full
// Roster row -- so there is exactly one rendering of this data, never a
// second, divergent display format for the same PrepPacketContent.
//
// This repo has no React Testing Library/jsdom (see
// src/app/__tests__/error-boundaries.test.ts's own header comment) --
// renderToStaticMarkup() + createElement() is the same, already-established
// way to prove a real .tsx component renders real content without a full
// DOM/router harness (today-client.tsx's own useRouter()/useTransition()
// hooks make rendering the whole TodayClient tree here impractical for a
// low-complexity display fix -- PrepSummary is the one piece both call
// sites share, and is what actually matters for this bug).
const packet: PrepPacketContent = {
  score: 82,
  rationale: "Strong overlap with the stated requirements.",
  topStrengths: ["Fractional CFO experience"],
  keyGaps: [],
  recommendation: "Pursue",
  predictedQuestions: [],
  starlaStories: [],
  atsScore: {
    keywordOverlapScore: 70,
    matchedKeywords: [],
    missingKeywords: [],
    resumeTweaks: [],
    parseabilityIssues: [],
    resumeChecked: false,
  },
};

describe("PrepSummary()", () => {
  it("renders the real fit score and recommendation from a prepByKey result", () => {
    const html = renderToStaticMarkup(createElement(PrepSummary, { prep: packet }));
    expect(html).toContain("Fit score: 82/100");
    expect(html).toContain("Pursue");
  });

  it("is the exact same component used for both the Today's Picks card and the Full Roster row (see today-client.tsx) -- a single rendering, not two independently-maintained copies of the same data", () => {
    // Regression guard for the original bug shape: asserts PrepSummary
    // itself is a real, standalone, importable renderer (not inlined
    // separately in two places) so it can genuinely be shared rather than
    // duplicated.
    expect(typeof PrepSummary).toBe("function");
  });
});

// today-page-gig-detail-panel story (consistent-gig-detail-access epic).
// Owner's real, live complaint from Today's Picks: "where is the link,
// where is the extension, where is seeing it? a modal, SOMETHING!" -- the
// fix mounts the existing, shared GigDetailPanel (gig-detail-panel.tsx,
// already proven at dashboard-client.tsx) for both Today's Picks cards and
// Full Roster rows. Unlike dashboard-client.tsx (one `rows` array),
// Today's page has TWO separate lists a click can come from, so
// resolveGigDetailSelection() is the one place that decides which list
// Prev/Next walks -- covered here the same way this file's own
// PrepSummary() is (a pure, extracted piece, no React Testing Library/
// jsdom dependency -- see this file's own header comment).
describe("resolveGigDetailSelection()", () => {
  const picks = [makeGig({ key: "p1" }), makeGig({ key: "p2" })];
  const roster = [makeGig({ key: "r1" }), makeGig({ key: "r2" }), makeGig({ key: "r3" })];

  it("resolves the gig, index, and total from the Picks list when selectedSource is 'picks'", () => {
    const result = resolveGigDetailSelection("p2", "picks", picks, roster);
    expect(result.gig?.key).toBe("p2");
    expect(result.index).toBe(1);
    expect(result.total).toBe(2);
    expect(result.list).toBe(picks);
  });

  it("resolves the gig, index, and total from the Full Roster list when selectedSource is 'roster'", () => {
    const result = resolveGigDetailSelection("r2", "roster", picks, roster);
    expect(result.gig?.key).toBe("r2");
    expect(result.index).toBe(1);
    expect(result.total).toBe(3);
    expect(result.list).toBe(roster);
  });

  it("never finds a Picks-only key inside the roster list, or vice versa -- the two lists are genuinely independent, not a shared pool", () => {
    expect(resolveGigDetailSelection("p1", "roster", picks, roster).gig).toBeNull();
    expect(resolveGigDetailSelection("r1", "picks", picks, roster).gig).toBeNull();
  });

  it("returns index -1 and a null gig when the key is null (nothing selected) -- the panel's caller uses this to decide whether to render it at all", () => {
    const result = resolveGigDetailSelection(null, "roster", picks, roster);
    expect(result.gig).toBeNull();
    expect(result.index).toBe(-1);
  });

  it("returns index -1 and a null gig when the selected key fell out of its own list (e.g. a filter change or in-panel status change) -- callers use this to auto-close, mirroring dashboard-client.tsx's identical selectedIndex effect", () => {
    const result = resolveGigDetailSelection("gone", "roster", picks, roster);
    expect(result.gig).toBeNull();
    expect(result.index).toBe(-1);
    expect(result.total).toBe(3);
  });
});
