"use client";

// true-embedded-browser epic, embedded-webview-child-mechanism story.
// TEMPORARY spike page for this story's own acceptance criterion: live
// visual proof that a real external page renders INSIDE the gigradar
// window (no separate OS window) against this repo's pinned Tauri
// version. Not linked from nav-header.tsx on purpose -- this is a
// verification tool for this story, not a real feature; Story 3/4 build
// the real UI on top of the same mechanism (src/lib/tauri/embedded-webview.ts)
// and this page can be deleted once they land, unless it turns out useful
// to keep as a standing debug tool (owner's own call, not assumed here).
import { useRef, useState } from "react";
import { closeEmbeddedWebview, hideEmbeddedWebview, showEmbeddedWebview } from "@/lib/tauri/embedded-webview";
import { isTauri } from "@/lib/is-tauri";

export default function EmbeddedWebviewSpikePage() {
  const paneRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>("idle");
  const [url, setUrl] = useState("https://example.com");

  async function handleShow() {
    if (!paneRef.current) return;
    setStatus("showing…");
    try {
      const rect = paneRef.current.getBoundingClientRect();
      await showEmbeddedWebview(url, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      setStatus("shown");
    } catch (e) {
      setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleHide() {
    try {
      await hideEmbeddedWebview();
      setStatus("hidden");
    } catch (e) {
      setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleClose() {
    try {
      await closeEmbeddedWebview();
      setStatus("closed");
    } catch (e) {
      setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="font-theme-heading text-2xl font-bold text-theme-text">Embedded webview spike</h1>
      <p className="mt-1 text-sm text-theme-text-dim">
        true-embedded-browser epic, embedded-webview-child-mechanism story. This page exists to visually prove a real
        external page renders inside the app window -- not a real feature yet.
      </p>
      <p className="mt-2 text-xs text-theme-text-dim">
        isTauri(): <span className="font-theme-mono">{String(isTauri())}</span> — status:{" "}
        <span className="font-theme-mono">{status}</span>
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-96 rounded-md border border-theme-surface-border bg-theme-surface px-2 py-1.5 text-sm text-theme-text"
        />
        <button type="button" onClick={handleShow} className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised">
          Show
        </button>
        <button type="button" onClick={handleHide} className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised">
          Hide
        </button>
        <button type="button" onClick={handleClose} className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised">
          Close
        </button>
      </div>

      <div
        ref={paneRef}
        className="mt-4 h-[500px] w-full rounded-md border-2 border-dashed border-theme-surface-border-strong bg-theme-surface-raised"
      >
        <p className="p-3 text-xs text-theme-text-dim">
          This dashed region is where the embedded webview should render -- if you see this text, no webview is showing here.
        </p>
      </div>
    </main>
  );
}
