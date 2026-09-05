"use client";

// group-feature-hardening-and-coverage epic, app-error-boundaries story:
// shared body for every route-segment error.tsx (config/gigs/[group]) --
// unlike global-error.tsx (which replaces the root layout entirely and so
// can't use this app's theme tokens), these boundaries render INSIDE the
// normal root layout: NavHeader, data-theme, and every theme utility class
// are all still available and safe to use here.
export function RouteErrorFallback({ reset, routeLabel }: { reset: () => void; routeLabel: string }) {
  return (
    <main className="mx-auto flex max-w-2xl flex-col items-center gap-3 p-16 text-center">
      <h1 className="font-theme-heading text-lg font-semibold text-theme-text">Couldn't load {routeLabel}</h1>
      <p className="text-sm text-theme-text-dim">
        Something went wrong rendering this page. Your config and data on disk are untouched — this is just a display
        problem.
      </p>
      <button
        type="button"
        onClick={() => reset()}
        className="mt-2 rounded-md bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-ink transition-opacity hover:opacity-90"
      >
        Try again
      </button>
    </main>
  );
}
