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
import { useEffect, useRef, useState } from "react";
import {
  clickEmbeddedElementByText,
  closeEmbeddedWebview,
  findEmbeddedElementByText,
  hideEmbeddedWebview,
  readEmbeddedWebviewSession,
  showEmbeddedWebview,
  typeIntoEmbeddedElementByText,
} from "@/lib/tauri/embedded-webview";
import { isTauri } from "@/lib/is-tauri";

export default function EmbeddedWebviewSpikePage() {
  const paneRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string>("idle");
  const [url, setUrl] = useState("https://example.com");
  const [autoRan, setAutoRan] = useState(false);

  async function handleShow(targetUrl?: string) {
    if (!paneRef.current) return;
    setStatus("showing…");
    try {
      const rect = paneRef.current.getBoundingClientRect();
      await showEmbeddedWebview(targetUrl ?? url, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
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

  // Grill-time verification aid: query-param auto-trigger, so a real
  // live-verification pass (screenshot proof for THIS story's own
  // acceptance criterion) can be driven headlessly against a real
  // running dev instance, without needing to click anything -- no
  // browser/Playwright automation touches this NATIVE window at any
  // point, only the URL it was opened with. `?autoshow=<url>` shows that
  // url in the pane on mount; `?autoread=1` additionally reads the
  // session ~1.5s later (enough time for a same-origin cookie-setting
  // page to have set its cookie before the read). Harmless no-op with no
  // query params -- same "temporary spike page" scope this file already
  // documents at its own top.
  useEffect(() => {
    if (autoRan) return;
    const params = new URLSearchParams(window.location.search);
    const autoUrl = params.get("autoshow");
    if (!autoUrl) return;
    setAutoRan(true);
    void (async () => {
      setUrl(autoUrl);
      await handleShow(autoUrl);
      if (params.get("autoread") === "1") {
        await new Promise((r) => setTimeout(r, 1500));
        await handleReadSession();
      }
      if (params.get("autotest") === "evalbridge") {
        await new Promise((r) => setTimeout(r, 1000));
        await handleEvalBridgeTest();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRan]);

  // embedded-automation-bridge story: a manual, one-shot smoke test of
  // find/click/type against whatever's CURRENTLY shown in the pane --
  // exercises the exact same evalInEmbeddedWebview() path
  // clickSessionAtAction()/typeIntoSessionAction()'s embedded-pane
  // backend will use, without needing to build the full profile-assist
  // wiring first.
  const [evalBridgeResult, setEvalBridgeResult] = useState<string>("");
  async function handleEvalBridgeTest() {
    setEvalBridgeResult("running…");
    try {
      const find1 = await findEmbeddedElementByText("Test Button");
      const typeResult = await typeIntoEmbeddedElementByText("Test Input", "hello from eval bridge");
      const clickResult = await clickEmbeddedElementByText("Test Button");
      const find2 = await findEmbeddedElementByText("nonexistent-element-xyz");
      setEvalBridgeResult(
        `find("Test Button")=${JSON.stringify(find1)} | type=${JSON.stringify(typeResult)} | click=${JSON.stringify(clickResult)} | find(missing)=${JSON.stringify(find2)}`,
      );
    } catch (e) {
      setEvalBridgeResult(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const [sessionResult, setSessionResult] = useState<string>("");
  async function handleReadSession() {
    setSessionResult("reading…");
    try {
      const session = await readEmbeddedWebviewSession();
      // Never log cookie VALUES to a visible page -- names/domains only,
      // per this app's own standing secret-handling discipline
      // (CLAUDE.md's Secret handling section).
      setSessionResult(
        `${session.cookies.length} cookie(s): ${session.cookies.map((c) => `${c.name}@${c.domain}${c.httpOnly ? " (HttpOnly)" : ""}`).join(", ")}`,
      );
    } catch (e) {
      setSessionResult(`error: ${e instanceof Error ? e.message : String(e)}`);
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
        <button type="button" onClick={() => handleShow()} className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised">
          Show
        </button>
        <button type="button" onClick={handleHide} className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised">
          Hide
        </button>
        <button type="button" onClick={handleClose} className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised">
          Close
        </button>
        <button type="button" onClick={handleReadSession} className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised">
          Read session (macOS only)
        </button>
        <button type="button" onClick={() => void handleEvalBridgeTest()} className="rounded-md border border-theme-surface-border bg-theme-surface px-3 py-1.5 text-sm font-medium text-theme-text hover:bg-theme-surface-raised">
          Run eval-bridge test
        </button>
      </div>
      {sessionResult && <p className="mt-2 font-theme-mono text-xs text-theme-text-dim">{sessionResult}</p>}
      {evalBridgeResult && <p id="eval-bridge-result" className="mt-2 font-theme-mono text-xs text-theme-text-dim">{evalBridgeResult}</p>}

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
