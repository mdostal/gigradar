import { describe, expect, it } from "vitest";
import { DRAFT_STATUS_TABS, filterDrafts, formatCopyReadyDraft, resolveDraftMatchedGroups, type DraftListItem } from "../drafts-filter";

function makeItem(overrides: Partial<DraftListItem> & { gigKey: string }): DraftListItem {
  return {
    content: { coverText: "Hello", answers: {} },
    status: "draft",
    generatedAt: "2026-01-01T00:00:00.000Z",
    approvedAt: null,
    submittedAt: null,
    gigTitle: "Fractional CTO",
    gigCompany: "Acme",
    gigUrl: `https://example.test/${overrides.gigKey}`,
    gigSourceId: "gofractional",
    matchedGroups: [],
    ...overrides,
  };
}

describe("DRAFT_STATUS_TABS", () => {
  it("is 'all' plus every DraftStatus value, in review-workflow order", () => {
    expect(DRAFT_STATUS_TABS).toEqual(["all", "draft", "approved", "rejected", "submitted"]);
  });
});

describe("filterDrafts", () => {
  it("'all' returns every item unchanged", () => {
    const items = [makeItem({ gigKey: "1", status: "draft" }), makeItem({ gigKey: "2", status: "approved" })];
    expect(filterDrafts(items, "all")).toEqual(items);
  });

  it("filters to only the matching status", () => {
    const items = [
      makeItem({ gigKey: "1", status: "draft" }),
      makeItem({ gigKey: "2", status: "approved" }),
      makeItem({ gigKey: "3", status: "approved" }),
    ];
    expect(filterDrafts(items, "approved").map((i) => i.gigKey)).toEqual(["2", "3"]);
  });

  it("returns an empty array when nothing matches", () => {
    const items = [makeItem({ gigKey: "1", status: "draft" })];
    expect(filterDrafts(items, "submitted")).toEqual([]);
  });
});

// Review step's acceptance criteria: "the copy-ready draft doesn't
// accidentally include any raw LLM-internal formatting."
describe("formatCopyReadyDraft", () => {
  it("with no structured answers, returns just the cover text — no JSON, no empty-object noise", () => {
    const result = formatCopyReadyDraft({ coverText: "Dear hiring team,\n\nI'd love to help.", answers: {} });
    expect(result).toBe("Dear hiring team,\n\nI'd love to help.");
    expect(result).not.toContain("{");
    expect(result).not.toContain("}");
  });

  it("with structured answers, appends each as a plain 'Q: ... / A: ...' pair, never JSON-stringified", () => {
    const result = formatCopyReadyDraft({
      coverText: "Cover message.",
      answers: { "Why are you a fit?": "Ten years of experience.", "Rate?": "$200/hr" },
    });
    expect(result).toBe(
      "Cover message.\n\nQ: Why are you a fit?\nA: Ten years of experience.\n\nQ: Rate?\nA: $200/hr",
    );
    expect(result).not.toContain('"coverText"');
    expect(result).not.toContain('"answers"');
  });

  it("never JSON.stringifies the content wholesale", () => {
    const content = { coverText: "Hi", answers: { Q1: "A1" } };
    const result = formatCopyReadyDraft(content);
    expect(result).not.toBe(JSON.stringify(content));
  });
});

// drafts-page-group-context story (group-scoped-automation-fixes epic):
// real usability gap this closes -- a gig can now be auto-drafted purely
// because it's green for a NON-primary group, so the Drafts list needs to
// show WHICH group(s) actually matched, each with its own real tier, not
// the flat/primary tier alone.
describe("resolveDraftMatchedGroups", () => {
  const groups = [
    { id: "fractional", label: "Fractional Work" },
    { id: "drone", label: "Drone Services" },
  ];

  it("with only ONE group configured, returns [] -- zero added visual noise for the common single-group case", () => {
    const gig = { tier: "red" as const, matchedGroupIds: ["fractional"], matchedGroupTiers: { fractional: "green" as const } };
    expect(resolveDraftMatchedGroups(gig, [{ id: "fractional", label: "Fractional Work" }])).toEqual([]);
  });

  it("with zero groups configured (first-run, no config yet), returns [] rather than throwing", () => {
    const gig = { tier: "green" as const, matchedGroupIds: undefined, matchedGroupTiers: undefined };
    expect(resolveDraftMatchedGroups(gig, [])).toEqual([]);
  });

  it("a gig that matched exactly one (non-primary) group shows THAT group's own label and tier, not the flat/primary tier", () => {
    const gig = { tier: "red" as const, matchedGroupIds: ["drone"], matchedGroupTiers: { drone: "green" as const } };
    expect(resolveDraftMatchedGroups(gig, groups)).toEqual([{ id: "drone", label: "Drone Services", tier: "green" }]);
  });

  it("a gig that matched multiple groups shows each with its own tier, never a single ambiguous badge", () => {
    const gig = {
      tier: "green" as const,
      matchedGroupIds: ["fractional", "drone"],
      matchedGroupTiers: { fractional: "green" as const, drone: "yellow" as const },
    };
    expect(resolveDraftMatchedGroups(gig, groups)).toEqual([
      { id: "fractional", label: "Fractional Work", tier: "green" },
      { id: "drone", label: "Drone Services", tier: "yellow" },
    ]);
  });

  it("a matched group with no scoped tier entry falls back to 'yellow' via resolveDisplayTier's own no-match convention, never the flat tier", () => {
    const gig = { tier: "red" as const, matchedGroupIds: ["drone"], matchedGroupTiers: undefined };
    expect(resolveDraftMatchedGroups(gig, groups)).toEqual([{ id: "drone", label: "Drone Services", tier: "yellow" }]);
  });

  it("a matched id with no corresponding configured group (stale/renamed) falls back to the raw id as its own label instead of being dropped", () => {
    const gig = { tier: "green" as const, matchedGroupIds: ["deleted-group"], matchedGroupTiers: { "deleted-group": "green" as const } };
    expect(resolveDraftMatchedGroups(gig, groups)).toEqual([{ id: "deleted-group", label: "deleted-group", tier: "green" }]);
  });

  it("2+ groups configured but this gig has no matchedGroupIds at all (pre-multi-group data) returns [] -- the Drafts list falls back to the flat tier badge", () => {
    const gig = { tier: "yellow" as const, matchedGroupIds: undefined, matchedGroupTiers: undefined };
    expect(resolveDraftMatchedGroups(gig, groups)).toEqual([]);
  });
});
