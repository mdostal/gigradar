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
