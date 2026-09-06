// true-embedded-browser epic, embedded-webview-child-mechanism story. Thin
// frontend bridge to src-tauri/src/embedded_webview.rs's 4 commands --
// the SAME dynamic-import invoke() pattern update-notifier.tsx already
// established (not a new convention), and the SAME isTauri() mode-guard
// that file and config/tauri-version-readout.tsx already share.
//
// EVERY export here throws a specific, actionable error when called
// outside the packaged Tauri app -- never a silent no-op, never a
// confusing raw IPC failure (see this story's own acceptance criteria).
// Electron/browser runtime modes have no equivalent capability; a caller
// (e.g. embedded-capture-login-flow's own UI) is responsible for
// checking isTauri() itself BEFORE offering the embedded option at all,
// so this throw is a defensive backstop, not the primary UX gate.
import { isTauri } from "@/lib/is-tauri";

const NOT_TAURI_ERROR =
  "gigradar embedded-webview: only available in the packaged Tauri app -- this runtime is electron/browser mode, which has no in-app embedded webview capability.";

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(NOT_TAURI_ERROR);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/**
 * Shows (creating on first call, reusing thereafter) the embedded child
 * webview at `url`, positioned/sized to exactly cover `bounds` -- pass a
 * real `DOMRect` (e.g. a ref'd `<div>`'s `getBoundingClientRect()`), never
 * a hardcoded guess; Tauri's own logical-pixel coordinate space matches
 * a browser's `getBoundingClientRect()` directly, no DPI conversion
 * needed.
 */
export async function showEmbeddedWebview(url: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
  await invokeTauri("embedded_webview_show", { url, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}

/** Hides the embedded webview without destroying it -- its session/navigation state survives; a later showEmbeddedWebview() call reuses the same instance. */
export async function hideEmbeddedWebview(): Promise<void> {
  await invokeTauri("embedded_webview_hide");
}

/** Navigates the ALREADY-SHOWING embedded webview to a new url, without touching position/size. Throws if the webview hasn't been created yet -- call showEmbeddedWebview() first. */
export async function navigateEmbeddedWebview(url: string): Promise<void> {
  await invokeTauri("embedded_webview_navigate", { url });
}

/** Destroys the embedded webview entirely (not just hides it) -- for a real "done with this session" moment, e.g. cancelling a Capture Login. */
export async function closeEmbeddedWebview(): Promise<void> {
  await invokeTauri("embedded_webview_close");
}

/**
 * embedded-webview-cookie-extraction-macos story. Reads the real session
 * cookies (including HttpOnly ones) currently held by the embedded
 * webview -- e.g. after a human completes a real login in it. Byte-
 * compatible with `browser-session.ts`'s own `StorageState` type; feeds
 * directly into `filterStorageStateToAllowlist()` with no adapter layer.
 * macOS-only at the native level (see `src-tauri/src/embedded_webview_cookies.rs`) --
 * throws a specific "only implemented on macOS" error on other platforms,
 * same never-silent-failure discipline as every other export here.
 */
export interface EmbeddedStorageStateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface EmbeddedStorageState {
  cookies: EmbeddedStorageStateCookie[];
  origins: { origin: string; localStorage: Array<{ name: string; value: string }> }[];
}

export async function readEmbeddedWebviewSession(): Promise<EmbeddedStorageState> {
  return invokeTauri<EmbeddedStorageState>("embedded_webview_read_session");
}

/**
 * embedded-guided-apply-assist story. Seeds the embedded webview with an
 * already-authenticated session's cookies -- e.g. profile-assist's
 * manual mode, which already has a valid storageState loaded from disk/
 * Portunus BEFORE it ever shows the pane, and only needs to SHOW that
 * session, never extract a new one afterward (the mirror image of
 * `readEmbeddedWebviewSession()` above).
 *
 * GRILL-TIME CORRECTION: this originally called Tauri's own
 * `Webview::set_cookie()` (a real, documented, cross-platform API) --
 * live-verified this session, against a real embedded pane and a real
 * self-controlled test server, that it does NOT actually work on this
 * app's macOS/WKWebView setup: it returns `Ok(())` with no error, but
 * the cookie never gets sent with the webview's subsequent requests.
 * The SAME live test confirmed the fallback this story's own risk
 * register already anticipated DOES work: injecting `document.cookie`
 * via the already-proven `embedded_webview_eval()` bridge. Switched to
 * that unconditionally rather than keeping a native code path that
 * silently doesn't work.
 *
 * REAL, ACCEPTED LIMITATION (not new -- session-capture.ts documents
 * the same one elsewhere): `document.cookie` cannot set HttpOnly
 * cookies at all (a browser security restriction, not a gigradar gap).
 * HttpOnly cookies in `cookies` are silently skipped here -- for a
 * source whose real auth session is HttpOnly-only, manual mode's
 * embedded pane may still show that source's own real login page,
 * exactly as if no session had been seeded (a `console.warn` names each
 * skipped cookie so this isn't silent to anyone debugging with the
 * embedded webview's own dev tools open).
 *
 * Call this AFTER `showEmbeddedWebview()` has navigated to the target
 * origin at least once -- `document.cookie` sets a cookie for the
 * CURRENTLY LOADED page's own origin, not an arbitrary domain.
 */
export async function setEmbeddedWebviewCookies(cookies: EmbeddedStorageStateCookie[]): Promise<void> {
  const settable = cookies.filter((c) => !c.httpOnly);
  const skipped = cookies.length - settable.length;
  if (skipped > 0) {
    // eslint-disable-next-line no-console -- deliberate, named warning for a real, accepted limitation -- see this function's own doc comment.
    console.warn(`gigradar embedded-webview: skipped ${skipped} HttpOnly cookie(s) -- document.cookie injection cannot set them.`);
  }
  if (settable.length === 0) return;

  const statements = settable
    .map((c) => {
      const parts = [`${c.name}=${c.value}`, `path=${c.path || "/"}`];
      if (c.secure) parts.push("secure");
      if (c.sameSite) parts.push(`samesite=${c.sameSite.toLowerCase()}`);
      if (c.expires >= 0) parts.push(`expires=${new Date(c.expires * 1000).toUTCString()}`);
      return JSON.stringify(parts.join("; "));
    })
    .join(", ");

  const js = `(function() {
    try {
      var cookieStrings = [${statements}];
      for (var i = 0; i < cookieStrings.length; i++) { document.cookie = cookieStrings[i]; }
      return {ok: true, result: {set: cookieStrings.length}};
    } catch (e) {
      return {ok: false, error: String((e && e.message) || e)};
    }
  })()`;
  await evalInEmbeddedWebview<{ set: number }>(js);
}

// ---------------------------------------------------------------------------
// true-embedded-browser epic, embedded-automation-bridge story. The DEFAULT
// automation backend for guided/full-auto profile-assist against the
// embedded pane -- dispatches synthetic DOM events entirely inside the
// page's own JS/event model via embedded_webview_eval(), NEVER touching
// the real OS cursor/HID input stream at all (unlike
// embedded-vision-automation-mode's OS-level CGEvent approach, live-
// verified this session to visibly hijack the owner's real mouse cursor).
// Real prior art this mirrors: danielraffel/tauri-webdriver injects a JS
// bridge into a Tauri/WKWebView app for exactly this class of operation,
// with no CDP dependency at all.
//
// Every injected script below is a single IIFE expression (never a
// multi-statement script relying on eval()'s own implicit-last-value
// semantics) that ALWAYS catches its own exceptions and resolves to a
// plain `{ok, result}` / `{ok: false, error}` object itself -- per
// eval_with_callback()'s own doc comment ("exception is ignored... on
// Windows"), this bridge never relies on Tauri's own exception
// passthrough, cross-platform.
// ---------------------------------------------------------------------------

async function evalInEmbeddedWebview<T>(js: string): Promise<T> {
  const raw = await invokeTauri<string>("embedded_webview_eval", { js });
  let parsed: { ok: boolean; result?: T; error?: string };
  try {
    parsed = JSON.parse(raw) as { ok: boolean; result?: T; error?: string };
  } catch {
    throw new Error(`gigradar embedded-webview eval: non-JSON result from the embedded pane: ${raw}`);
  }
  if (!parsed.ok) throw new Error(`gigradar embedded-webview eval: ${parsed.error ?? "unknown error"}`);
  return parsed.result as T;
}

/**
 * Finds the SMALLEST (most specific, by on-screen area) visible element
 * whose aria-label/placeholder/title/visible-text/value contains `text`
 * (case-insensitive substring) -- "smallest wins" avoids matching a huge
 * container `<div>` that merely happens to contain the target text
 * somewhere among many descendants. Returns `{found: false}` (never
 * throws) when nothing matches -- a real, common, non-error outcome
 * (the page hasn't loaded that content yet, or the label doesn't match).
 */
export interface EmbeddedElementMatch {
  found: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  tag?: string;
}

function findElementScript(text: string): string {
  const needle = JSON.stringify(text);
  return `(function() {
    try {
      var wanted = (${needle} || "").trim().toLowerCase();
      var nodes = document.querySelectorAll("body *");
      var best = null, bestArea = Infinity, bestRect = null;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        var label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.value || "").trim().toLowerCase();
        if (label.indexOf(wanted) === -1) continue;
        var area = rect.width * rect.height;
        if (area < bestArea) { bestArea = area; best = el; bestRect = rect; }
      }
      if (!best) return {ok: true, result: {found: false}};
      return {ok: true, result: {found: true, tag: best.tagName, rect: {x: bestRect.x, y: bestRect.y, width: bestRect.width, height: bestRect.height}}};
    } catch (e) {
      return {ok: false, error: String((e && e.message) || e)};
    }
  })()`;
}

export async function findEmbeddedElementByText(text: string): Promise<EmbeddedElementMatch> {
  return evalInEmbeddedWebview<EmbeddedElementMatch>(findElementScript(text));
}

/**
 * Clicks the same element findEmbeddedElementByText() would find, via a
 * plain `el.click()` -- native semantics for `<a>`/`<button>`/form
 * controls, and broadly compatible with React/other frameworks' own
 * synthetic-event delegation (which listens at the document root for
 * REAL DOM events, `.click()` included) without needing to hand-construct
 * a MouseEvent sequence.
 */
export async function clickEmbeddedElementByText(text: string): Promise<{ clicked: boolean }> {
  const needle = JSON.stringify(text);
  const js = `(function() {
    try {
      var wanted = (${needle} || "").trim().toLowerCase();
      var nodes = document.querySelectorAll("body *");
      var best = null, bestArea = Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        var label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.value || "").trim().toLowerCase();
        if (label.indexOf(wanted) === -1) continue;
        var area = rect.width * rect.height;
        if (area < bestArea) { bestArea = area; best = el; }
      }
      if (!best) return {ok: true, result: {clicked: false}};
      best.click();
      return {ok: true, result: {clicked: true}};
    } catch (e) {
      return {ok: false, error: String((e && e.message) || e)};
    }
  })()`;
  return evalInEmbeddedWebview<{ clicked: boolean }>(js);
}

/**
 * Types `value` into the same element findEmbeddedElementByText() would
 * find. REAL GOTCHA handled here: a third-party page built with React (or
 * similar) overrides `HTMLInputElement.prototype.value`'s own setter to
 * track controlled-input state -- setting `el.value = x` directly is
 * therefore invisible to React's own onChange handler (the framework
 * never sees a real "input" event fire through its own tracked setter).
 * Fixed by calling the NATIVE prototype's value setter explicitly (via
 * `Object.getOwnPropertyDescriptor` on the prototype, bypassing whatever
 * the page's own framework has overridden on the instance) before
 * dispatching real `input`/`change` events -- the same technique
 * real-world browser-automation tooling uses for this exact problem.
 */
export async function typeIntoEmbeddedElementByText(text: string, value: string): Promise<{ typed: boolean }> {
  const needle = JSON.stringify(text);
  const val = JSON.stringify(value);
  const js = `(function() {
    try {
      var wanted = (${needle} || "").trim().toLowerCase();
      var nodes = document.querySelectorAll("input, textarea");
      var best = null, bestArea = Infinity;
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        var label = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || el.name || "").trim().toLowerCase();
        if (label.indexOf(wanted) === -1) continue;
        var area = rect.width * rect.height;
        if (area < bestArea) { bestArea = area; best = el; }
      }
      if (!best) return {ok: true, result: {typed: false}};
      var proto = best.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(best, ${val});
      best.dispatchEvent(new Event("input", {bubbles: true}));
      best.dispatchEvent(new Event("change", {bubbles: true}));
      return {ok: true, result: {typed: true}};
    } catch (e) {
      return {ok: false, error: String((e && e.message) || e)};
    }
  })()`;
  return evalInEmbeddedWebview<{ typed: boolean }>(js);
}
