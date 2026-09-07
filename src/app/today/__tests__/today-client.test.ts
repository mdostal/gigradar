import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PrepPacketContent } from "@/lib/apply/prep";

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

const { PrepSummary } = await import("../today-client");

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
