// external-link-click-silent-failure story (real-usability-verification-
// and-fixes epic). Covers the pure feedback-shape logic every
// openExternalUrl() call site now routes through via
// useOpenExternalLink() -- kept separate from the hook itself so it's
// unit-testable without jsdom/React Testing Library (neither of which
// this repo has, see vitest.config.ts's own comment).
import { describe, expect, it } from "vitest";
import { errorFeedback, successFeedback } from "../open-external-feedback.js";

describe("successFeedback", () => {
  it("returns a success-kind feedback with a real, human-readable message", () => {
    const feedback = successFeedback();
    expect(feedback.kind).toBe("success");
    expect(feedback.message.length).toBeGreaterThan(0);
  });
});

describe("errorFeedback", () => {
  it("surfaces a real Error's own message, never silence", () => {
    const feedback = errorFeedback(new Error("plugin-shell open() rejected: no such application"));
    expect(feedback.kind).toBe("error");
    expect(feedback.message).toContain("plugin-shell open() rejected: no such application");
  });

  it("still produces a visible message for a non-Error rejection (a thrown string, an IPC error object, etc.)", () => {
    const feedback = errorFeedback("some non-Error rejection");
    expect(feedback.kind).toBe("error");
    expect(feedback.message).toContain("some non-Error rejection");
  });

  it("never returns an empty message", () => {
    const feedback = errorFeedback(undefined);
    expect(feedback.kind).toBe("error");
    expect(feedback.message.length).toBeGreaterThan(0);
  });
});
