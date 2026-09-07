"use client";

// external-link-click-silent-failure story (real-usability-verification-
// and-fixes epic). Shared presentation for useOpenExternalLink()'s
// feedback state -- one visual treatment reused by every openExternalUrl()
// call site instead of each page inventing its own, mirroring
// sonar-sweep-header.tsx's own fixed-bottom-right toast/error convention.
// role="alert" on the error case so assistive tech announces it
// immediately, matching this app's other real-time error surfaces.
import type { ExternalLinkFeedback } from "./open-external-feedback";

export function ExternalLinkFeedbackToast({
  feedback,
  onDismiss,
}: {
  feedback: ExternalLinkFeedback | null;
  onDismiss: () => void;
}) {
  if (!feedback) return null;
  const isError = feedback.kind === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      className={`fixed bottom-4 right-4 z-50 max-w-sm rounded-md border px-3.5 py-2.5 text-sm shadow-lg ${
        isError
          ? "border-red-300 bg-red-50 text-red-700"
          : "border-theme-accent-dim bg-theme-surface-raised text-theme-text"
      }`}
    >
      {feedback.message}
      <button type="button" onClick={onDismiss} className="ml-2 font-medium underline">
        Dismiss
      </button>
    </div>
  );
}
