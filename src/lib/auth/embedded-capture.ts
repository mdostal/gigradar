// true-embedded-browser epic, embedded-capture-login-flow story. The
// SERVER-SIDE half of embedded-webview capture. The client-side half
// (showing/hiding the pane, reading the raw session back out of the
// native WKHTTPCookieStore) lives entirely in the browser via
// src/lib/tauri/embedded-webview.ts's Tauri IPC calls — there is no
// server-held Playwright browser for this path at all, unlike
// session-capture.ts's real-chrome flow. This module is what a Server
// Action calls ONCE the client has already read the raw session back:
// normalize its shape, then hand off to session-capture.ts's
// persistCapturedSession() — the SAME allowlist-filtering/zero-cookie-
// sanity-check/backend-dispatch/encrypted-persistence logic the
// real-chrome flow uses, never a second, divergent implementation.
//
// GRILL-TIME CORRECTION to this story's own acceptance criteria: the
// embedded webview's native cookie read (embedded_webview_read_session(),
// src-tauri/src/embedded_webview_cookies.rs) returns `sameSite` as a bare
// `string` (WKHTTPCookieStore's own sameSitePolicy has no equivalent
// TypeScript literal-union type at the Rust/IPC boundary) — NOT
// byte-compatible with browser-session.ts's `StorageStateCookie.sameSite:
// "Strict" | "Lax" | "None"` as originally claimed. A real, one-function
// normalization step (below) is required after all — "no adapter layer
// needed" was aspirational, not achieved; corrected here rather than
// silently type-casting past the mismatch.
import type { StorageState, StorageStateCookie } from "./browser-session.js";
import { persistCapturedSession, type FinishCaptureResult } from "./session-capture.js";
import type { SessionBackend } from "./session-backend.js";

const MODULE_PREFIX = "gigradar embedded-capture";

const VALID_SAME_SITE = new Set(["Strict", "Lax", "None"]);

/** The raw shape embedded_webview_read_session() resolves to, client-side — see EmbeddedStorageState/EmbeddedStorageStateCookie in src/lib/tauri/embedded-webview.ts. Duplicated here (not imported) since that module is client-only (imports @tauri-apps/api dynamically) and this one is server-only ("use server" action callers) — the two must never share a runtime import edge. */
export interface RawEmbeddedStorageState {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }[];
  origins: { origin: string; localStorage: Array<{ name: string; value: string }> }[];
}

/**
 * Validates and narrows `raw`'s `sameSite` strings into the real
 * `StorageStateCookie` literal union. Throws a specific, actionable error
 * naming the exact offending cookie/value on the FIRST unrecognized value
 * — never silently coerces an unexpected value (e.g. WebKit returning
 * "Unspecified" or similar) to a guessed default, since that would change
 * how filterStorageStateToAllowlist()'s own domain/origin logic treats a
 * real cookie without the caller ever knowing a guess was made.
 */
export function normalizeEmbeddedStorageState(raw: RawEmbeddedStorageState): StorageState {
  const cookies: StorageStateCookie[] = raw.cookies.map((c) => {
    if (!VALID_SAME_SITE.has(c.sameSite)) {
      throw new Error(
        `${MODULE_PREFIX}: cookie "${c.name}"@${c.domain} has an unrecognized sameSite value "${c.sameSite}" (expected Strict/Lax/None) — refusing to guess.`,
      );
    }
    return { ...c, sameSite: c.sameSite as StorageStateCookie["sameSite"] };
  });
  return { cookies, origins: raw.origins };
}

/**
 * The embedded-webview equivalent of session-capture.ts's finishCapture():
 * normalizes the raw client-read session, then persists it through the
 * exact same shared path real-chrome captures use. No captureId/lifecycle
 * map lookup here — the "browser" (the embedded webview) is entirely
 * client-owned; by the time this is called, the client has already read
 * everything it needs out of it.
 */
export async function finishEmbeddedCapture(
  sourceId: string,
  rawSession: RawEmbeddedStorageState,
  sessionBackend: SessionBackend,
  allowedOrigins?: string[],
): Promise<FinishCaptureResult> {
  const normalized = normalizeEmbeddedStorageState(rawSession);
  return persistCapturedSession(sourceId, normalized, sessionBackend, allowedOrigins);
}
