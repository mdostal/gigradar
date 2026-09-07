// external-link-click-silent-failure story (real-usability-verification-
// and-fixes epic). Root cause of the live-verified silent failure: every
// openExternalUrl() call site fired its returned promise without an
// await or a .catch() (`onClick={(e) => { e.preventDefault();
// openExternalUrl(url); }}`) -- when the call rejects for any real
// reason, that becomes an invisible, silent unhandled promise rejection.
// See use-open-external-link.ts's own header comment for the full
// picture and the packaged-app root cause this story actually found.
//
// The success/error message shape lives in its own pure functions here
// (not inlined in the hook) so it's unit-testable without jsdom/React
// Testing Library, neither of which this repo has (see vitest.config.ts's
// own comment) -- same "keep the pure logic separately testable from the
// hook/component shell" split error-boundaries.test.ts's own header
// comment already establishes for this repo.
export interface ExternalLinkFeedback {
  kind: "success" | "error";
  message: string;
}

export function successFeedback(): ExternalLinkFeedback {
  return { kind: "success", message: "Opened in your default browser." };
}

export function errorFeedback(err: unknown): ExternalLinkFeedback {
  const reason = err instanceof Error ? err.message : String(err);
  return {
    kind: "error",
    message: `Couldn't open the original posting in your browser: ${reason}`,
  };
}
