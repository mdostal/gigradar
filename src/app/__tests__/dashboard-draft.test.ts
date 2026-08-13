import { describe, expect, it } from "vitest";
import { canGenerateDraft, draftButtonLabel } from "../dashboard-draft";

// (AC5, AC6) canGenerateDraft() is dashboard-client.tsx's ONLY gate for
// whether the "Generate draft" button renders at all for a row — see
// dashboard-draft.ts's header comment. Deliberately mirrors
// stageApplication()'s own backend guardrail (`tier === "red"` throws,
// src/lib/apply/runner.ts) exactly, rather than an allowlist of specific
// tiers.
describe("canGenerateDraft (AC5, AC6)", () => {
  it("returns false for tier='red' — no button at all for a red-tier gig", () => {
    expect(canGenerateDraft("red")).toBe(false);
  });

  it("returns true for tier='green'", () => {
    expect(canGenerateDraft("green")).toBe(true);
  });

  it("returns true for tier='yellow'", () => {
    expect(canGenerateDraft("yellow")).toBe(true);
  });

  it("returns true for an untiered gig (tier undefined) — matches stageApplication(), which only blocks tier==='red'", () => {
    expect(canGenerateDraft(undefined)).toBe(true);
  });
});

describe("draftButtonLabel", () => {
  it("labels 'Generate draft' when no draft exists yet for the gig", () => {
    expect(draftButtonLabel(false)).toBe("Generate draft");
  });

  it("labels 'Regenerate draft' once a draft already exists for the gig", () => {
    expect(draftButtonLabel(true)).toBe("Regenerate draft");
  });
});
