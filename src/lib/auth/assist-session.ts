// profile-assist epic, profile-assist-persistent-session-manual-mode story.
// THE EPIC'S CORE NEW PRIMITIVE (design-discussion.md §3): a browser
// session that stays open across many separate Server Action calls, unlike
// browser-session.ts's withBrowserSession() (fresh browser+context per
// call, torn down the instant its callback returns) or session-capture.ts's
// capture flow (a single start -> human-logs-in -> finish/cancel arc, never
// reused for anything after finishCapture() writes the file). An assist
// session stays open for an entire human-paced profile-editing interaction
// -- potentially many read/click/fill/ask_human turns over real minutes --
// until the human clicks Done or the idle timeout fires.
//
// GLOBALTHIS-PINNED STATE -- NON-NEGOTIABLE, same reason as
// session-capture.ts's own `captures` map (see that file's header comment
// in full): Next.js dev's Hot Module Reloading re-evaluates this module on
// any edit to it or its import chain, which would silently reset a plain
// module-level Map and orphan a live Chromium process. `sessions` below is
// pinned to `globalThis` so HMR re-evaluation finds and reuses the existing
// Map instead of replacing it.
//
// ONE SESSION PER sourceId AT A TIME (design-discussion.md §3's own design
// decision) -- two real browser windows open against the same profile page
// simultaneously would just confuse the human, not provide real value.
// startAssistSession() rejects a second start for a sourceId that already
// has a live session.
//
// REUSES, NEVER DUPLICATES, browser-session.ts's origin-scoping: the exact
// same readStorageStateFile() + filterStorageStateToAllowlist() path every
// browser-session-auth adapter's withBrowserSession() call already goes
// through. This module imports those functions directly rather than
// reimplementing storageState loading/filtering a second time -- see
// browser-session.ts's own header comment on why that filter is
// safety-critical and must never fork.
import crypto from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import { filterStorageStateToAllowlist, readStorageStateFile, type StorageState } from "./browser-session.js";
import { attachToRealChrome, closeRealChrome, positionChromeWindowSideBySide, spawnRealChrome, type RealChromeHandle } from "./real-chrome.js";
import { PORTUNUS_SESSION_ACCOUNT, readSessionViaPortunus, type SessionBackend } from "./session-backend.js";
import { resolveEnvString } from "../config/load.js";
import { sendDesktopNotification } from "../notify/desktop.js";
import { resolveAllowedOrigins, resolveProfileUrl } from "../sources/origins.js";
import type { SourceConfig } from "../types.js";

const MODULE_PREFIX = "gigradar assist-session";

/** How long an assist session may sit with no activity before it's automatically closed -- same value as session-capture.ts's IDLE_TIMEOUT_MS, same reasoning (an abandoned session must not leak a Chromium process forever). */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export type AssistMode = "manual" | "guided" | "full-auto";

interface AssistSessionEntry {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  realChrome: RealChromeHandle;
  sourceId: string;
  mode: AssistMode;
  startedAt: number;
  lastActivityAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** See session-capture.ts's CaptureEntry.disconnectedListener doc comment -- kept so cleanup paths can remove SPECIFICALLY this listener via browser.off(), never removeAllListeners("disconnected") (which would also strip Playwright's own internal listener that close() depends on to ever resolve). */
  disconnectedListener: () => void;
}

// globalThis-pinned -- see this file's header comment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate untyped globalThis cast; see file header for why this exact idiom is required.
const sessions: Map<string, AssistSessionEntry> = ((globalThis as any).__gigradarAssistSessions ??=
  new Map<string, AssistSessionEntry>());

/** Closes both halves of a session's browser resources -- Playwright's CDP connection (`browser`) AND the real, independently-spawned Chrome process + its temp --user-data-dir (`realChrome`, via real-chrome.ts's closeRealChrome()) -- same helper session-capture.ts uses, for the same reason (a cleanup path may race the user closing the window directly). */
async function safeCloseBrowser(browser: Browser, realChrome: RealChromeHandle): Promise<void> {
  try {
    await browser.close();
  } catch {
    // already closed/closing -- nothing more to do.
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

/**
 * Public metadata about a live session -- deliberately excludes `browser`/
 * `context`/`page` (never handed to a Server Action's return value; those
 * live handles stay inside this module, looked up fresh by sessionId on
 * every subsequent call).
 */
export interface AssistSessionInfo {
  sessionId: string;
  sourceId: string;
  mode: AssistMode;
}

/**
 * Starts a new persistent assist session for `sourceId`: resolves and
 * origin-scopes the source's storageState via browser-session.ts's own
 * readStorageStateFile()/filterStorageStateToAllowlist() (reused,
 * unmodified), spawns and attaches to a real, independent Chrome via
 * real-chrome.ts's spawnRealChrome()/attachToRealChrome() (never
 * playwright.chromium.launch() -- see real-chrome.ts's header comment for
 * why), and navigates to the source's registered
 * SOURCE_PROFILE_URLS entry -- see origins.ts's own comment: these URLs are
 * NOT all live-confirmed yet, a known, flagged gap, not silently assumed
 * correct.
 *
 * Throws (before ever launching a browser) if: a session is already active
 * for `sourceId` (one session per source at a time -- see this file's
 * header comment); the source has no registered origin allowlist or
 * profile URL; or the session storage state is missing/unreadable/malformed
 * -- via readStorageStateFile() for the (default) `"local"` backend, or via
 * session-backend.ts's readSessionViaPortunus() for `"portunus"`.
 *
 * Registers the same `browser.on("disconnected", ...)` cleanup listener and
 * `IDLE_TIMEOUT_MS` idle-timeout sweep session-capture.ts's startCapture()
 * uses, for the same reason (the user may close the real OS window
 * directly instead of clicking Done).
 *
 * `cfg` is optional and defaults to `{ id: sourceId, enabled: true }` (no
 * `settings`) -- for the 3 hand-written browser-session adapters this is
 * byte-identical to the old hardcoded-registry-only behavior, since
 * resolveAllowedOrigins()/resolveProfileUrl() check the static registry
 * first. Callers with a CUSTOM source (e.g. a custom-llm-source preset with
 * no registry entry) pass the real SourceConfig so its settings.allowedOrigins/
 * settings.profileUrl config-driven fallback is used instead.
 */
export async function startAssistSession(
  sourceId: string,
  mode: AssistMode,
  storageStatePathSetting?: string,
  sessionBackend: SessionBackend = "local",
  cfg: SourceConfig = { id: sourceId, enabled: true },
): Promise<AssistSessionInfo> {
  for (const entry of sessions.values()) {
    if (entry.sourceId === sourceId) {
      throw new Error(
        `${MODULE_PREFIX}: an assist session is already active for source "${sourceId}". Finish or end it before starting another.`,
      );
    }
  }

  const allowedOrigins = resolveAllowedOrigins(sourceId, cfg);
  if (!allowedOrigins || allowedOrigins.length === 0) {
    throw new Error(
      `${MODULE_PREFIX}: no origin allowlist registered for source "${sourceId}" (see src/lib/sources/origins.ts, or set settings.allowedOrigins).`,
    );
  }
  const profileUrl = resolveProfileUrl(sourceId, cfg);
  if (!profileUrl) {
    throw new Error(
      `${MODULE_PREFIX}: no profile-edit URL registered for source "${sourceId}" (see SOURCE_PROFILE_URLS in src/lib/sources/origins.ts, or set settings.profileUrl).`,
    );
  }

  let rawStorageState: StorageState;
  if (sessionBackend === "portunus") {
    rawStorageState = await readSessionViaPortunus(sourceId, PORTUNUS_SESSION_ACCOUNT);
  } else {
    if (!storageStatePathSetting) {
      throw new Error(
        `${MODULE_PREFIX}: source "${sourceId}" is using the local session backend but no storageState path was supplied.`,
      );
    }
    const resolvedPath = resolveEnvString(storageStatePathSetting, `source "${sourceId}" settings storageState path`);
    rawStorageState = readStorageStateFile(resolvedPath);
  }
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
    await page.goto(profileUrl);
  } catch (e) {
    await safeCloseBrowser(browser, realChrome);
    throw new Error(
      `${MODULE_PREFIX}: failed to open the profile page for source "${sourceId}" at "${profileUrl}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // product-review-followups epic, notifications-and-filter-persistence
  // story: same reasoning as session-capture.ts/verification-copilot-
  // session.ts -- a real, visible Chrome window just opened. Only for
  // "manual"/"guided" -- "full-auto" means no human is expected to look at
  // this window at all, by design, so notifying there would just be noise.
  if (mode !== "full-auto") {
    void sendDesktopNotification({
      title: "gigradar: browser opened to help with your profile",
      body: `A browser window opened for ${sourceId} in ${mode} mode -- follow along and help where needed.`,
    });
  }

  // embedded-browser-and-guided-session epic: "guided"/"full-auto" work is
  // meant to happen through the embedded live-view pane
  // (embedded-view-interactive story, /profile-assist's own UI), not by
  // looking at/using this separate native window directly -- so position it
  // to a fixed side of the screen (real and glanceable, never hidden) the
  // moment it opens, rather than letting it pop centered and steal focus
  // for the whole session. "manual" mode is unaffected -- it's explicitly
  // "a real browser window is open on your desktop, use it directly"
  // (profile-assist-client.tsx's own manual-mode copy), so repositioning it
  // there would fight the actual feature.
  if (mode !== "manual") {
    void positionChromeWindowSideBySide();
  }

  const sessionId = crypto.randomUUID();

  const disconnectedListener = () => {
    const entry = sessions.get(sessionId);
    if (!entry) return; // already cleaned up via endAssistSession()/the idle timeout
    clearTimeout(entry.timeoutHandle);
    sessions.delete(sessionId);
    // The real Chrome process may already be gone (this is often WHY we
    // disconnected -- the user closed the window directly), but the temp
    // --user-data-dir still needs removing -- see closeRealChrome()'s doc
    // comment on why it's always safe to call.
    closeRealChrome(entry.realChrome);
  };
  browser.on("disconnected", disconnectedListener);

  const now = Date.now();
  sessions.set(sessionId, {
    browser,
    context,
    page,
    realChrome,
    sourceId,
    mode,
    startedAt: now,
    lastActivityAt: now,
    timeoutHandle: scheduleIdleTimeout(sessionId),
    disconnectedListener,
  });

  return { sessionId, sourceId, mode };
}

/**
 * Looks up the live `Page` for `sessionId`, refreshing its idle-timeout
 * clock (see this file's header comment -- any real use of a session counts
 * as activity, not just an explicit Done click). Throws a specific
 * "session not found or expired" error if the id isn't a live entry --
 * never a silent no-op.
 */
export function getAssistSessionPage(sessionId: string): Page {
  const entry = sessions.get(sessionId);
  if (!entry) {
    throw new Error(`${MODULE_PREFIX}: session not found or expired (id "${sessionId}").`);
  }
  clearTimeout(entry.timeoutHandle);
  entry.timeoutHandle = scheduleIdleTimeout(sessionId);
  entry.lastActivityAt = Date.now();
  return entry.page;
}

/** Metadata for a live session, or undefined if it's already ended/expired -- used by the UI to confirm a session is still alive without touching its Page. */
export function getAssistSessionInfo(sessionId: string): AssistSessionInfo | undefined {
  const entry = sessions.get(sessionId);
  if (!entry) return undefined;
  return { sessionId, sourceId: entry.sourceId, mode: entry.mode };
}

/**
 * Ends session `sessionId`: closes context + browser, clears the idle
 * timeout, removes the disconnect listener and the map entry. Idempotent --
 * calling it for an id that's already ended/expired/disconnected is a
 * silent no-op (never throws), since a "Done" click in the UI can
 * legitimately race the idle timeout or the user closing the window
 * directly.
 */
export async function endAssistSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return; // already ended/expired/disconnected

  clearTimeout(entry.timeoutHandle);
  entry.browser.off("disconnected", entry.disconnectedListener);
  sessions.delete(sessionId);

  await safeCloseBrowser(entry.browser, entry.realChrome);
}
