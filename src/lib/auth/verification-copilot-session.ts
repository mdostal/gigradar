// verification-copilot epic, verification-copilot-browser-action story. A
// human-drivable browser session opened from an issue's "Open browser to
// help clear it" button — NOT a new mechanism, a thin reuse of two
// already-built primitives: real-chrome.ts (spawn-then-attach a real,
// independently-launched Chrome — the same reason session-capture.ts uses
// it for Capture Login: launch-time automation fingerprints are exactly
// what a bot-detection challenge is looking for) and browser-session.ts's
// readStorageStateFile()/filterStorageStateToAllowlist() (the source's
// already-captured session, origin-scoped — safety-critical, never
// skipped, never a second copy of this logic).
//
// GLOBALTHIS-PINNED STATE, SAME IDIOM AS session-capture.ts/
// assist-session.ts, for the identical reason (Next.js dev HMR
// re-evaluates this module on any edit to it or its import chain, which
// would silently orphan a live Chromium process if the map were a plain
// module-level `const`).
//
// ONE SESSION PER sourceId AT A TIME — same reasoning assist-session.ts's
// own header comment already gives (two real browser windows against the
// same blocked page would just confuse the human).
import crypto from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import { filterStorageStateToAllowlist, readStorageStateFile } from "./browser-session.js";
import { attachToRealChrome, closeRealChrome, spawnRealChrome, type RealChromeHandle } from "./real-chrome.js";
import { resolveEnvString } from "../config/load.js";
import { SOURCE_ORIGINS } from "../sources/origins.js";

const MODULE_PREFIX = "gigradar verification-copilot-session";

/** Same value, same reasoning, as session-capture.ts's/assist-session.ts's own IDLE_TIMEOUT_MS. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface CopilotSessionEntry {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  realChrome: RealChromeHandle;
  sourceId: string;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** See session-capture.ts's CaptureEntry.disconnectedListener doc comment — kept so cleanup paths can remove SPECIFICALLY this listener via browser.off(), never removeAllListeners("disconnected"). */
  disconnectedListener: () => void;
}

// globalThis-pinned — see this file's header comment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate untyped globalThis cast; see file header for why this exact idiom is required.
const sessions: Map<string, CopilotSessionEntry> = ((globalThis as any).__gigradarVerificationCopilotSessions ??=
  new Map<string, CopilotSessionEntry>());

/** Closes both halves of a session's browser resources — same pattern session-capture.ts/assist-session.ts already use. */
async function safeCloseBrowser(browser: Browser, realChrome: RealChromeHandle): Promise<void> {
  try {
    await browser.close();
  } catch {
    // already closed/closing — nothing more to do.
  }
  closeRealChrome(realChrome);
}

function scheduleIdleTimeout(sessionId: string): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const entry = sessions.get(sessionId);
    if (!entry) return; // already ended
    sessions.delete(sessionId);
    entry.browser.off("disconnected", entry.disconnectedListener);
    void entry.browser.close().catch(() => {});
    closeRealChrome(entry.realChrome);
  }, IDLE_TIMEOUT_MS);
}

export interface CopilotSessionInfo {
  sessionId: string;
  sourceId: string;
}

/**
 * Opens a real, human-drivable Chrome (real-chrome.ts's spawn-then-attach,
 * never `playwright.chromium.launch()`) on `url` — the URL a
 * `VerificationChallengeError` reported as blocked — with `sourceId`'s
 * already-captured, origin-scoped session loaded, so the human sees
 * exactly the state that failed.
 *
 * Throws (before ever spawning a browser) if: a co-pilot session is
 * already active for `sourceId`; the source has no registered origin
 * allowlist; or the storageState file is missing/unreadable/malformed
 * (via `readStorageStateFile()`) — the same "capture a login first"
 * guidance every other consumer of that function already surfaces.
 */
export async function openCopilotSession(
  sourceId: string,
  url: string,
  storageStatePathSetting: string,
): Promise<CopilotSessionInfo> {
  for (const entry of sessions.values()) {
    if (entry.sourceId === sourceId) {
      throw new Error(
        `${MODULE_PREFIX}: a verification co-pilot session is already active for source "${sourceId}". Finish it before starting another.`,
      );
    }
  }

  const allowedOrigins = SOURCE_ORIGINS[sourceId];
  if (!allowedOrigins || allowedOrigins.length === 0) {
    throw new Error(`${MODULE_PREFIX}: no origin allowlist registered for source "${sourceId}" (see src/lib/sources/origins.ts).`);
  }

  const resolvedPath = resolveEnvString(storageStatePathSetting, `source "${sourceId}" settings storageState path`);
  const rawStorageState = readStorageStateFile(resolvedPath);
  const scopedStorageState = filterStorageStateToAllowlist(rawStorageState, [...allowedOrigins]);

  const realChrome = await spawnRealChrome();

  let browser: Browser;
  try {
    browser = await attachToRealChrome(realChrome.cdpPort);
  } catch (e) {
    closeRealChrome(realChrome);
    throw new Error(
      `${MODULE_PREFIX}: failed to attach to the spawned Chrome for source "${sourceId}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  let context: BrowserContext;
  let page: Page;
  try {
    context = await browser.newContext({ storageState: scopedStorageState });
    page = await context.newPage();
    await page.goto(url);
  } catch (e) {
    await safeCloseBrowser(browser, realChrome);
    throw new Error(
      `${MODULE_PREFIX}: failed to open the blocked page for source "${sourceId}" at "${url}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const sessionId = crypto.randomUUID();

  const disconnectedListener = () => {
    const entry = sessions.get(sessionId);
    if (!entry) return; // already cleaned up via closeCopilotSession()/the idle timeout
    clearTimeout(entry.timeoutHandle);
    sessions.delete(sessionId);
    closeRealChrome(entry.realChrome);
  };
  browser.on("disconnected", disconnectedListener);

  sessions.set(sessionId, {
    browser,
    context,
    page,
    realChrome,
    sourceId,
    startedAt: Date.now(),
    timeoutHandle: scheduleIdleTimeout(sessionId),
    disconnectedListener,
  });

  return { sessionId, sourceId };
}

/**
 * Looks up the live `Page` for `sessionId`, refreshing its idle-timeout
 * clock — any real use of a session counts as activity. Throws a specific
 * "session not found or expired" error if the id isn't a live entry.
 */
export function getCopilotPage(sessionId: string): Page {
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`${MODULE_PREFIX}: session not found or expired (id "${sessionId}").`);
  }
  clearTimeout(entry.timeoutHandle);
  entry.timeoutHandle = scheduleIdleTimeout(sessionId);
  return entry.page;
}

/**
 * Ends session `sessionId`: closes context + browser + the real Chrome
 * process, clears the idle timeout, removes the disconnect listener and
 * the map entry. Idempotent — calling it for an id that's already
 * ended/expired/disconnected is a silent no-op (never throws), since
 * "I'm done" in the UI can legitimately race the idle timeout or the user
 * closing the window directly.
 */
export async function closeCopilotSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return; // already ended/expired/disconnected

  clearTimeout(entry.timeoutHandle);
  entry.browser.off("disconnected", entry.disconnectedListener);
  sessions.delete(sessionId);

  await safeCloseBrowser(entry.browser, entry.realChrome);
}
