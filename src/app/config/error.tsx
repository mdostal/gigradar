"use client";

import { RouteErrorFallback } from "../route-error-fallback";

// group-feature-hardening-and-coverage epic, app-error-boundaries story.
// See route-error-fallback.tsx's doc comment for why this exists.
export default function ConfigError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorFallback reset={reset} routeLabel="Config" />;
}
