import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DraftListItem } from "../drafts-filter";

// drafts-page-open-posting-link-for-all-statuses story (real-usability-
// verification-and-fixes epic). This repo has no React Testing Library/
// jsdom -- renderToStaticMarkup() + createElement() is the same,
// already-established way other components in this app prove real .tsx
// rendering without a full DOM/router harness (see
// src/app/today/__tests__/today-client.test.ts and
// src/app/__tests__/error-boundaries.test.ts's own header comments for the
// same convention). DraftsClient itself has no useRouter()/next-font
// dependency, so the whole exported component renders directly here.
const { DraftsClient } = await import("../drafts-client");

function makeItem(overrides: Partial<DraftListItem> & { gigKey: string }): DraftListItem {
  return {
    content: { coverText: "Hello", answers: {} },
    status: "draft",
    generatedAt: "2026-01-01T00:00:00.000Z",
    approvedAt: null,
    submittedAt: null,
    gigTitle: "Fractional CTO",
    gigCompany: "Acme",
    gigUrl: "https://example.test/jobs/real-posting-123",
    gigSourceId: "gofractional",
    matchedGroups: [],
    ...overrides,
  };
}

describe("DraftsClient — 'Open the real job listing' link visibility", () => {
  it("renders the link for a draft still in status 'draft' -- the owner's real, current data shape (17 real drafts, all status='draft')", () => {
    const item = makeItem({ gigKey: "draft-1", status: "draft" });
    const html = renderToStaticMarkup(createElement(DraftsClient, { items: [item] }));
    expect(html).toContain("Open the real job listing");
    expect(html).toContain(item.gigUrl);
  });

  it("still renders the link for an 'approved' draft (pre-existing behavior, unchanged)", () => {
    const item = makeItem({ gigKey: "draft-2", status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" });
    const html = renderToStaticMarkup(createElement(DraftsClient, { items: [item] }));
    expect(html).toContain("Open the real job listing");
    expect(html).toContain(item.gigUrl);
  });

  it("still renders the link for a 'submitted' draft (pre-existing behavior, unchanged)", () => {
    const item = makeItem({
      gigKey: "draft-3",
      status: "submitted",
      approvedAt: "2026-01-02T00:00:00.000Z",
      submittedAt: "2026-01-03T00:00:00.000Z",
    });
    const html = renderToStaticMarkup(createElement(DraftsClient, { items: [item] }));
    expect(html).toContain("Open the real job listing");
    expect(html).toContain(item.gigUrl);
  });

  it("renders the link for a 'rejected' draft too (any status, per this story's fix)", () => {
    const item = makeItem({ gigKey: "draft-4", status: "rejected" });
    const html = renderToStaticMarkup(createElement(DraftsClient, { items: [item] }));
    expect(html).toContain("Open the real job listing");
    expect(html).toContain(item.gigUrl);
  });

  it("does NOT show the copy-ready draft / Mark submitted controls for a plain 'draft'-status item -- this story only touches the open-posting link, not the approval workflow", () => {
    const item = makeItem({ gigKey: "draft-5", status: "draft" });
    const html = renderToStaticMarkup(createElement(DraftsClient, { items: [item] }));
    expect(html).not.toContain("Copy-ready draft");
    expect(html).not.toContain("Mark submitted");
  });
});
