// external-link-click-silent-failure story (real-usability-verification-
// and-fixes epic). renderToStaticMarkup() + createElement() (no
// jsdom/React Testing Library in this repo -- see vitest.config.ts's own
// comment) is enough to prove the shared toast actually renders the
// visible feedback text and the right ARIA role for each state, same
// "prove it renders and surfaces the right text" bar
// error-boundaries.test.ts's own header comment sets for this repo.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExternalLinkFeedbackToast } from "../external-link-feedback-toast.js";

describe("ExternalLinkFeedbackToast", () => {
  it("renders nothing when there is no feedback", () => {
    const html = renderToStaticMarkup(createElement(ExternalLinkFeedbackToast, { feedback: null, onDismiss: () => {} }));
    expect(html).toBe("");
  });

  it("renders a real, visible error message with role=alert so it's never silent", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalLinkFeedbackToast, {
        feedback: { kind: "error", message: "Could not open the original posting in your browser: boom" },
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("Could not open the original posting in your browser: boom");
    expect(html).toContain('role="alert"');
  });

  it("renders a success confirmation with role=status", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalLinkFeedbackToast, {
        feedback: { kind: "success", message: "Opened in your default browser." },
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("Opened in your default browser.");
    expect(html).toContain('role="status"');
  });
});
