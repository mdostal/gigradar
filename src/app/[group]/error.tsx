"use client";

import { RouteErrorFallback } from "../route-error-fallback";

// group-feature-hardening-and-coverage epic, app-error-boundaries story.
// See route-error-fallback.tsx's doc comment for why this exists. Covers
// both /[group] and /[group]/gigs -- a route-segment error.tsx catches
// throws in every page under its segment, not just the segment's own
// page.tsx.
export default function GroupError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorFallback reset={reset} routeLabel="this group's view" />;
}
