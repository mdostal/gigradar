"use client";

// group-feature-hardening-and-coverage epic, app-error-boundaries story:
// this app had ZERO error boundaries anywhere before this file -- an
// uncaught render exception took down the entire page with no recovery
// path, which is exactly what a "crashed, don't see the groups" symptom
// would look like in the packaged Tauri webview. Next.js's documented
// contract: global-error.tsx is the ONLY boundary that catches an error
// thrown by the root layout itself, and it must render its OWN <html>/
// <body> (it fully replaces the root layout when active) -- so, unlike
// every other error.tsx in this app, it deliberately does NOT reach for
// this app's theme tokens (data-theme, NavHeader, next/font) since the
// component tree that would normally provide them is exactly what failed.
// Plain, dependency-free inline styles only.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a1310", color: "#e6efe9", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>gigradar hit a problem</h1>
          <p style={{ fontSize: 14, color: "#9fb3ab", marginBottom: 20 }}>
            Something went wrong loading the app. Your config and data on disk are untouched — this is just a display
            problem.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{ background: "#4fa8d8", color: "#04202f", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
