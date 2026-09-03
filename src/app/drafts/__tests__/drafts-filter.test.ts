import { describe, expect, it } from "vitest";
import { DRAFT_STATUS_TABS, filterDrafts, formatCopyReadyDraft, type DraftListItem } from "../drafts-filter";

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
