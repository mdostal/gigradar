"use client";

// external-link-click-silent-failure story (real-usability-verification-
// and-fixes epic). Every openExternalUrl() call site (dashboard-client.tsx,
// gig-detail-panel.tsx, today-client.tsx, drafts-client.tsx,
// interview-workspace-client.tsx) used to be a fire-and-forget onClick
// (`onClick={(e) => { e.preventDefault(); openExternalUrl(row.original.url);
// }}`) -- a live simman vision-AI click-through of the real packaged app
// confirmed this produces ZERO visible result on failure: no browser
// opens, no error, nothing. This hook is the one place every call site
// now routes its click through instead, so a future failure can never be
// silent again, regardless of its cause.
//
// Real root cause found for THIS failure (see open-external.ts's own
// updated header comment for the full evidence): unrelated to this
// fire-and-forget shape itself, but fixing this shape is still required
// per this story's own design decision -- a link that can fail silently
// is a real, recurring risk even after one specific root cause is fixed.
import { useCallback, useEffect, useState } from "react";
import { openExternalUrl } from "./open-external";
import { errorFeedback, successFeedback, type ExternalLinkFeedback } from "./open-external-feedback";

const SUCCESS_DISMISS_MS = 4000;

export function useOpenExternalLink() {
  const [feedback, setFeedback] = useState<ExternalLinkFeedback | null>(null);

  // Success feedback is transient (matches sonar-sweep-header.tsx's own
  // toast convention); an error stays visible until the user dismisses it
  // or clicks again.
  useEffect(() => {
    if (!feedback || feedback.kind !== "success") return undefined;
    const id = setTimeout(() => setFeedback(null), SUCCESS_DISMISS_MS);
    return () => clearTimeout(id);
  }, [feedback]);

  const openExternalLink = useCallback((url: string) => {
    setFeedback(null);
    openExternalUrl(url).then(
      () => setFeedback(successFeedback()),
      (err: unknown) => setFeedback(errorFeedback(err)),
    );
  }, []);

  const dismissFeedback = useCallback(() => setFeedback(null), []);

  return { openExternalLink, feedback, dismissFeedback };
}
