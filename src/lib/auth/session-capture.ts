// The session-capture mechanism — a guided, in-app "log in once, we'll
// remember it" flow that produces exactly the kind of storageState file
// browser-session.ts's withBrowserSession() already knows how to consume
// (see .pHive/epics/session-capture-ui/stories/session-capture-mechanism.yaml).
// This module never modifies browser-session.ts; it only reuses its
// filterStorageStateToAllowlist() export and its StorageState type shapes.
// The browser itself is acquired via real-chrome.ts's
// spawnRealChrome()/attachToRealChrome() (never
// playwright.chromium.launch()/browser-session.ts's launchHeadedBrowser() --
// see real-chrome.ts's header comment for why).
//
// THE EPIC'S SINGLE HIGHEST-NOVELTY PIECE: holding a live Playwright
// Browser/BrowserContext handle in server memory across separate Next.js
// Server Action invocations, bridging an indeterminate human-paced login
// interval (start -> [human logs in at their own pace] -> finish/cancel).
//
// GLOBALTHIS-PINNED STATE — NON-NEGOTIABLE. `captures` below is stored on
// `globalThis`, not as a plain module-level `const captures = new Map()`.
// Next.js dev's Hot Module Reloading re-evaluates a module on ANY edit to
// it or its import chain — a far more common event during active
// development than a full server restart — which would silently reset a
// plain module-level Map and orphan any in-flight capture (the live
// Chromium process would keep running, invisibly, until its own 10-minute
// idle timeout — itself scheduled by the now-discarded module instance —
// eventually closes it). Pinning the Map to `globalThis` is the same
// documented workaround Next.js dev projects use for DB client singletons
// (e.g. the standard Prisma-client-in-Next-dev pattern): the module's own
// top-level bindings get thrown away and re-created by HMR, but
// `globalThis` itself survives across that re-evaluation within the same
// Node process, so `??=` finds and reuses the existing Map instead of
// replacing it.
//
// NO DEBUG CAPTURE, EVER. The launched context has tracing, HAR recording,
// video, and console/network event logging all explicitly OFF — a hard
// constraint on this code path (not a default to reconsider later), since
// any future debug aid here could persist credential-bearing form data
// (the user's actual login page) to disk. Concretely: browser.newContext()
// below is called with no options at all — no `recordHar`, no
// `recordVideo`, no `context.tracing.start()`, no
// `page.on("console"|"request"|"response", ...)` anywhere in this file.
// The browser itself comes from real-chrome.ts's spawnRealChrome() (a real,
// independently-launched Chrome, headed, attached over CDP) which carries
// the same no-debug-option discipline.
//
// SANITY-CHECK BEFORE WRITE, NEVER WRITE-THEN-HOPE.
// filterStorageStateToAllowlist() was only ever proven against
// already-known-good manually-captured files; a fresh OAuth/SSO login
// could store a needed token on an origin outside the allowlist. Silently
// writing a broken-but-non-empty file as "success" would be worse than an
// explicit, actionable failure — finishCapture() below throws instead of
// writing when the filtered result has zero cookies.
//
// ENCRYPTED AT REST (encrypted-local-storage epic, session-file-encryption
// story). writeStorageStateAtomically() below — EXPORTED so
// browser-session.ts's migrate-on-read path can reuse it rather than
// duplicate it — passes the serialized storageState JSON through
// src/lib/security/vault.ts's encrypt() before it ever touches disk. A
// captured session file's raw bytes on disk are always an encrypted vault
// envelope, never plaintext.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { hasAnyEncryptedFile } from "../config/load.js";
import { encrypt, getOrCreateKey } from "../security/vault.js";
import { SOURCE_ORIGINS } from "../sources/origins.js";
import { getDefaultDataDir } from "../store/path.js";
import { filterStorageStateToAllowlist, type StorageState } from "./browser-session.js";
import { attachToRealChrome, closeRealChrome, spawnRealChrome, type RealChromeHandle } from "./real-chrome.js";
import {
  PORTUNUS_SESSION_ACCOUNT,
  PORTUNUS_SESSION_TTL_SECONDS,
  writeSessionViaPortunus,
  type SessionBackend,
} from "./session-backend.js";

const MODULE_PREFIX = "gigradar session-capture";

/** How long an abandoned capture (neither finished nor cancelled) is allowed to hold a live Chromium process open. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

interface CaptureEntry {
  browser: Browser;
  context: BrowserContext;
  realChrome: RealChromeHandle;
  sourceId: string;
  /**
   * Resolved ONCE, at startCapture() time, and reused here rather than
   * re-derived from SOURCE_ORIGINS at finish time — see startCapture()'s
   * own `allowedOrigins` parameter doc comment (llm-custom-sources epic,
   * custom-source-auth story). `undefined` means "use SOURCE_ORIGINS[
   * sourceId]", exactly today's behavior.
   */
  allowedOrigins: string[] | undefined;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  /**
   * The exact listener function passed to `browser.on("disconnected", ...)`
   * in `startCapture()` — kept so every cleanup path below can remove
   * SPECIFICALLY this listener via `browser.off("disconnected",
   * entry.disconnectedListener)`. Deliberately NEVER
   * `browser.removeAllListeners("disconnected")`: verified live (real
   * Playwright, real headed Chromium — not the mocked suite, which can't
   * catch this) that `removeAllListeners("disconnected")` also strips
   * Playwright's OWN internal "disconnected" listener that `browser.close()`
   * depends on internally to ever resolve, which makes `close()` hang
   * forever. `off()` with the specific function reference removes only the
   * listener this module itself added, leaving Playwright's internal one
   * intact.
   */
  disconnectedListener: () => void;
}

// See this file's header comment: globalThis-pinned, deliberately NOT a
// plain `const captures = new Map()`. Every HMR re-evaluation of this
// module runs this line again, but `??=` means it only ever creates the Map
// once per Node process — subsequent re-evaluations find and reuse the same
// instance already hanging off `globalThis`, so an in-flight capture
// started by a "stale" module instance stays reachable from the new one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate untyped globalThis cast; see file header for why this exact idiom is required.
const captures: Map<string, CaptureEntry> = ((globalThis as any).__gigradarCaptures ??=
  new Map<string, CaptureEntry>());

/**
 * Closes both halves of a capture's browser resources — Playwright's CDP
 * connection (`browser`) AND the real, independently-spawned Chrome process
 * + its temp `--user-data-dir` (`realChrome`, via real-chrome.ts's
 * closeRealChrome()) — swallowing any error from the Playwright side (the
 * connection may already be closed/closing, e.g. the user closed the window
 * directly, racing our own cleanup). closeRealChrome() itself already
 * swallows its own errors (see that function's doc comment), so this is
 * never this call's own failure either way.
 */
async function safeCloseBrowser(browser: Browser, realChrome: RealChromeHandle): Promise<void> {
  try {
    await browser.close();
  } catch {
    // already closed/closing — nothing more to do.
  }
  closeRealChrome(realChrome);
}

/**
 * Starts a new session capture for `sourceId`: launches a FRESH headed
 * Chromium context (no `storageState` passed in — this CREATES a session
 * via a real login, it never consumes/replays an existing one) and
 * navigates it to `loginUrl` so a human can log in at their own pace.
 *
 * Registers a `browser.on("disconnected", ...)` listener that cleans up
 * promptly if the user closes the actual browser window directly (rather
 * than clicking a "Finish"/"Cancel" button in the app), and schedules a
 * `IDLE_TIMEOUT_MS` idle timeout that closes the browser and removes the
 * entry if neither `finishCapture()` nor `cancelCapture()` arrives first
 * (see this story's accepted v1 risk: no cross-capture process sweep beyond
 * this per-capture bound).
 *
 * Throws (before ever spawning a browser) if the real Chrome binary isn't
 * installed at the expected macOS path — see real-chrome.ts's
 * spawnRealChrome().
 *
 * `allowedOrigins` (llm-custom-sources epic, custom-source-auth story):
 * optional — when supplied (the caller already resolved it, e.g. via
 * origins.ts's resolveAllowedOrigins() for a custom source with no static
 * SOURCE_ORIGINS entry), it's stored on the capture entry and used by
 * finishCapture() INSTEAD of re-deriving from SOURCE_ORIGINS[sourceId] at
 * finish time — resolved once, reused, rather than a second lookup pass.
 * Omitted (every existing caller) falls through to finishCapture()'s
 * original SOURCE_ORIGINS[sourceId] behavior, unchanged.
 */
export async function startCapture(sourceId: string, loginUrl: string, allowedOrigins?: string[]): Promise<{ captureId: string }> {
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
  try {
    // No storageState passed in, no other options: a fresh context that
    // creates a session via a real login. Same "no debug capture"
    // constraint as spawnRealChrome() above.
    context = await browser.newContext();
  } catch (e) {
    await safeCloseBrowser(browser, realChrome);
    throw new Error(
      `${MODULE_PREFIX}: failed to open a browser context for source "${sourceId}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const page = await context.newPage();
    await page.goto(loginUrl);
  } catch (e) {
    await safeCloseBrowser(browser, realChrome);
    throw new Error(
      `${MODULE_PREFIX}: failed to open the login page for source "${sourceId}" at "${loginUrl}": ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const captureId = crypto.randomUUID();

  // Named (not inline) specifically so it can be removed by exact reference
  // later — see CaptureEntry.disconnectedListener's doc comment for why
  // `removeAllListeners("disconnected")` must never be used instead.
  const disconnectedListener = () => {
    const entry = captures.get(captureId);
    if (!entry) return; // already cleaned up via finishCapture()/cancelCapture()/the idle timeout
    clearTimeout(entry.timeoutHandle);
    captures.delete(captureId);
    // The real Chrome process may already be gone (this is often WHY we
    // disconnected — the user closed the window directly), but the temp
    // --user-data-dir still needs removing — see closeRealChrome()'s doc
    // comment on why it's always safe to call.
    closeRealChrome(entry.realChrome);
  };
  browser.on("disconnected", disconnectedListener);

  const timeoutHandle = setTimeout(() => {
    const entry = captures.get(captureId);
    if (!entry) return; // already finished/cancelled
    captures.delete(captureId);
    // Closing triggers Playwright's own "disconnected" event; remove ONLY
    // this module's own listener first (never removeAllListeners — see
    // CaptureEntry.disconnectedListener's doc comment) so that event finds
    // nothing left for this module to clean up rather than racing this same
    // deletion a second time, while leaving Playwright's own internal
    // "disconnected" listener (which close() itself depends on) intact.
    entry.browser.off("disconnected", entry.disconnectedListener);
    void entry.browser.close().catch(() => {});
    closeRealChrome(entry.realChrome);
  }, IDLE_TIMEOUT_MS);

  captures.set(captureId, {
    browser,
    context,
    realChrome,
    sourceId,
    allowedOrigins,
    startedAt: Date.now(),
    timeoutHandle,
    disconnectedListener,
  });

  return { captureId };
}

/**
 * Looks up the live `Page` for `captureId` — used by capture-guidance.ts's
 * `checkCaptureReadiness()` (oauth-session-capture-v2 epic,
 * llm-capture-readiness-check story) to read the in-flight capture
 * window's CURRENT page, whatever the human has navigated to since
 * `startCapture()`. Read-only: this function itself never touches the idle
 * timeout, the disconnect listener, or the map entry — a readiness check
 * is advisory, not a lifecycle event (see finishCapture()/cancelCapture()
 * for the actual lifecycle-ending operations).
 *
 * Throws a specific "capture not found or already expired" error if
 * `captureId` isn't a live entry, same wording finishCapture()/
 * cancelCapture() already use for this exact case.
 */
export function getCapturePage(captureId: string): Page {
  const entry = captures.get(captureId);
  if (!entry) {
    throw new Error(`${MODULE_PREFIX}: capture not found or already expired (id "${captureId}").`);
  }
  const page = entry.context.pages()[0];
  if (!page) {
    throw new Error(`${MODULE_PREFIX}: capture "${captureId}" has no open page.`);
  }
  return page;
}

/** finishCapture()'s result — discriminated on which backend the session was persisted to. Never both, never a silent fallback from one to the other (oauth-session-capture-v2 epic, portunus-session-backend story). */
export type FinishCaptureResult =
  | { backend: "local"; path: string }
  | { backend: "portunus"; site: string; account: string };

/**
 * Completes capture `captureId`: reads the live context's storage state,
 * scopes it to `SOURCE_ORIGINS[entry.sourceId]` via
 * `filterStorageStateToAllowlist()` (reused, unmodified, from
 * browser-session.ts), and — only if that scoped result actually contains
 * at least one cookie for the source's own origin(s) — persists it to
 * exactly ONE backend, chosen by `sessionBackend` (default `"local"`,
 * byte-identical to this function's pre-Portunus behavior):
 *   - `"local"`: writes it atomically and ENCRYPTED (temp file + rename,
 *     mode 0600, via writeStorageStateAtomically() below) to
 *     `<getDefaultDataDir()>/<sourceId>-session.json`, overwriting any
 *     prior capture for that source.
 *   - `"portunus"`: writes it via session-backend.ts's
 *     writeSessionViaPortunus() — stdin only, never a local file.
 *
 * Throws a specific "capture not found or already expired" error if
 * `captureId` isn't a live entry (already timed out, disconnected, finished,
 * cancelled, or simply invalid) — and does so before touching the
 * filesystem at all.
 *
 * Throws a specific "capture produced no usable session" error — writing
 * NOTHING — if the filtered result has zero cookies; see this file's header
 * comment ("SANITY-CHECK BEFORE WRITE").
 *
 * The browser is closed (idle timeout cleared, disconnect listener removed,
 * map entry removed) on every exit path from this function, success or
 * failure alike — once `finishCapture()` has been called for an id, that
 * capture is over either way.
 */
export async function finishCapture(captureId: string, sessionBackend: SessionBackend = "local"): Promise<FinishCaptureResult> {
  const entry = captures.get(captureId);
  if (!entry) {
    throw new Error(`${MODULE_PREFIX}: capture not found or already expired (id "${captureId}").`);
  }

  clearTimeout(entry.timeoutHandle);
  // See CaptureEntry.disconnectedListener's doc comment: removing ONLY this
  // module's own listener, never removeAllListeners("disconnected") — that
  // would also strip Playwright's own internal listener that close() below
  // depends on to ever resolve.
  entry.browser.off("disconnected", entry.disconnectedListener);
  captures.delete(captureId);

  try {
    const rawStorageState = (await entry.context.storageState()) as StorageState;

    // entry.allowedOrigins (resolved once, at startCapture() time — see
    // that function's own doc comment) takes priority when present; falls
    // back to the static registry otherwise, today's unchanged behavior.
    const allowedOrigins = entry.allowedOrigins ?? SOURCE_ORIGINS[entry.sourceId];
    if (!allowedOrigins || allowedOrigins.length === 0) {
      throw new Error(
        `${MODULE_PREFIX}: no origin allowlist registered for source "${entry.sourceId}" (see src/lib/sources/origins.ts).`,
      );
    }

    // SOURCE_ORIGINS' values are `readonly string[]` (see origins.ts) —
    // spread into a plain mutable array to match filterStorageStateToAllowlist()'s
    // signature; the values themselves are unchanged.
    const filtered = filterStorageStateToAllowlist(rawStorageState, [...allowedOrigins]);

    if (filtered.cookies.length === 0) {
      throw new Error(
        `${MODULE_PREFIX}: capture produced no usable session for "${entry.sourceId}" — login may not have completed.`,
      );
    }

    if (sessionBackend === "portunus") {
      await writeSessionViaPortunus(entry.sourceId, PORTUNUS_SESSION_ACCOUNT, filtered, PORTUNUS_SESSION_TTL_SECONDS);
      return { backend: "portunus", site: entry.sourceId, account: PORTUNUS_SESSION_ACCOUNT };
    }

    const destPath = path.join(getDefaultDataDir(), `${entry.sourceId}-session.json`);
    writeStorageStateAtomically(destPath, filtered);
    return { backend: "local", path: destPath };
  } finally {
    await safeCloseBrowser(entry.browser, entry.realChrome);
  }
}

/**
 * Abandons capture `captureId` without writing anything: closes the
 * browser, clears the idle timeout, removes the disconnect listener and the
 * map entry. Idempotent — calling it for an id that's already finished,
 * timed out, or disconnected is a silent no-op (never throws), since a
 * "Cancel" click in the UI can legitimately race any of those.
 */
export async function cancelCapture(captureId: string): Promise<void> {
  const entry = captures.get(captureId);
  if (!entry) return; // already finished/timed out/disconnected — nothing left to cancel

  clearTimeout(entry.timeoutHandle);
  // See CaptureEntry.disconnectedListener's doc comment: removing ONLY this
  // module's own listener, never removeAllListeners("disconnected").
  entry.browser.off("disconnected", entry.disconnectedListener);
  captures.delete(captureId);

  await safeCloseBrowser(entry.browser, entry.realChrome);
}

/**
 * Writes `storageState` to `destPath` ATOMICALLY: serialize to a temp file
 * in the same directory (so the rename below is same-filesystem and
 * therefore atomic), pin its mode to 0600 (writeFileSync's `mode` is
 * subject to the process umask, so chmodSync afterward pins the exact bits
 * — same belt-and-suspenders approach src/lib/config/save.ts uses), then
 * `fs.renameSync` it onto `destPath`. Never a direct write to `destPath`.
 *
 * On ANY failure (writeFileSync, chmodSync, or renameSync throwing), the
 * temp file is removed before re-throwing — no stray `.tmp-*` file, and no
 * partial/empty file at `destPath`, is ever left behind.
 *
 * Encrypted at rest (encrypted-local-storage epic, session-file-encryption
 * story): the serialized JSON is passed through vault.ts's encrypt() before
 * ever touching disk — this function never writes plaintext storageState
 * JSON. EXPORTED specifically so browser-session.ts's readStorageStateFile()
 * migrate-on-read path can reuse this exact temp-file+rename+0600+encrypt
 * discipline instead of a second, duplicated implementation — see that
 * function's doc comment. Ensures the vault key exists first via
 * getOrCreateKey(hasAnyEncryptedFile) (minting one on a true first run, or
 * throwing VaultKeyLostError if encrypted data already exists elsewhere but
 * the key is gone — see vault.ts's own doc comment); idempotent with any
 * other entry point's own getOrCreateKey() call, so safe to call
 * unconditionally here regardless of whether this write is reached via
 * finishCapture() or browser-session.ts's migrate-on-read.
 */
export function writeStorageStateAtomically(destPath: string, storageState: StorageState): void {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });

  getOrCreateKey(hasAnyEncryptedFile);

  const tmpPath = path.join(dir, `.${path.basename(destPath)}.tmp-${crypto.randomUUID()}`);
  const serialized = `${JSON.stringify(storageState, null, 2)}\n`;

  try {
    fs.writeFileSync(tmpPath, encrypt(serialized), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, destPath);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // tmp file was never created, or is already gone — nothing to clean up.
    }
    throw e;
  }
}
