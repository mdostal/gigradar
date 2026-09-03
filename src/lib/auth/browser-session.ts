// The generic `Source.auth: "browser-session"` mechanism (src/lib/types.ts
// has been typed for this since the project's scaffold; this module is the
// first implementation — see
// .pHive/epics/browser-session-auth/stories/browser-session-mechanism.yaml).
//
// PREREQUISITE, separate from `npm install`: this module needs the actual
// Chromium binary, which Playwright downloads via its OWN install step, not
// automatically as part of adding the `playwright` npm dependency. Run:
//
//   npx playwright install chromium
//
// `npm install`'s postinstall hook usually downloads it too, but that's not
// guaranteed — `--ignore-scripts`, CI lockfile installs (`npm ci` in some
// configs), and some corporate npm configs skip postinstall entirely, which
// would leave `playwright` importable but the browser binary absent at
// runtime. checkChromiumAvailable() (below) detects exactly that case and
// throws an actionable error naming the fix, rather than a confusing raw
// Playwright launch stack trace.
//
// SAFETY-CRITICAL: origin-scoping. A real Playwright `storageState` file is
// not scoped to one site — it's whatever cookies/localStorage existed in the
// browser profile it was exported from, which can span many unrelated sites
// (verified during this epic's planning: one real file spans 23 origins,
// including Google/Clerk SSO, alongside the actual target source). This
// module NEVER passes a raw, unfiltered storageState file into
// `browser.newContext()` — see filterStorageStateToAllowlist() below, which
// runs before every context is constructed, unconditionally.
//
// HEADLESS FIRST, HEADED FALLBACK (embedded-browser-and-guided-session
// epic, headless-first-with-headed-fallback story). Originally headed-only
// — live testing during browser-session-auth's own planning found
// GoFractional/A.Team fail authentication in headless mode, independent of
// session validity (likely bot detection). That finding was never
// re-tested since, and headed-only meant a real, visible window popped on
// EVERY scan of every browser-session source, forever, whether or not the
// finding still held. acquireViaStorageStateSnapshot() below now tries
// `headless: true` FIRST; only a SessionAuthError/VerificationChallengeError
// falls through to a headed retry (see withBrowserSession()'s three-tier
// chain) — this makes the system self-discovering, permanently re-testing
// the real constraint on every scan rather than assuming it's forever
// fixed by a one-off manual check. No caching of "headless works for
// source X" across calls, deliberately — correctness over a marginal speed
// win; a failed headless attempt costs a few seconds, not a window.
//
// When a headed window IS required (headless failed), it's minimized
// immediately after auth is confirmed (minimizeChromeWindow(),
// real-chrome.ts) so an unattended scheduled scan never leaves a window
// flashing/focus-stealing on the owner's desktop for the scan's duration —
// the window still exists (CDP automation operates on the render tree, not
// physical on-screen pixels) but is never visible. This module never adds
// a caller-facing `headless` OPTION — the tiered fallback above is the
// only control surface; see design_decisions in the story YAML.
//
// NO SCRAPED CONTENT IN ERRORS/LOGS. Every error thrown or logged by this
// module includes only URLs, file paths, and fixed diagnostic strings —
// never DOM/page text, which could carry sensitive authenticated content
// into a log line or crash report.
//
// ENCRYPTED AT REST (encrypted-local-storage epic, session-file-encryption
// story). readStorageStateFile() below decrypts an already-encrypted
// storageState file transparently, or migrate-writes (via
// session-capture.ts's exported writeStorageStateAtomically(), reused not
// duplicated) a legacy plaintext one to an encrypted envelope. This is a
// storage-layer concern layered UNDERNEATH the origin-scoping filter below
// — filterStorageStateToAllowlist() still runs after decryption, in the
// same position, with the same safety-critical semantics, unchanged.
import fs from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { hasAnyEncryptedFile, resolveEnvString } from "../config/load.js";
import { decrypt, getOrCreateKey, isEncryptedEnvelope, VaultTamperError } from "../security/vault.js";
import { PORTUNUS_SESSION_ACCOUNT, readSessionViaPortunus, type SessionBackend } from "./session-backend.js";
import { writeStorageStateAtomically } from "./session-capture.js";
import { isVerificationChallengeContent, VerificationChallengeError } from "../sources/verification-challenge.js";
import { attachToRealChrome, closeRealChrome, minimizeChromeWindow, spawnRealChrome } from "./real-chrome.js";

const MODULE_PREFIX = "gigradar browser-session";

/** The subset of Playwright's `storageState` shape this module reads/filters. */
export interface StorageStateCookie {
  name: string;
  value: string;
  /** May carry a leading dot (".example.com") per the storageState/cookie spec — see domainMatchesAllowlist(). */
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StorageStateOrigin {
  /** A full origin URL, e.g. "https://app.example.com". */
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface StorageState {
  cookies: StorageStateCookie[];
  origins: StorageStateOrigin[];
}

/** Everything withBrowserSession() needs to launch a scoped, authenticated browser session for one source. */
export interface BrowserSessionOptions {
  /** The registered Source.id this session is for — used only in diagnostics, never in data. */
  sourceId: string;
  /**
   * Raw `SourceConfig.settings` value naming the storageState file — a
   * literal filesystem path, OR an "env:VAR_NAME" reference resolved via
   * the same convention src/lib/config/load.ts's env: resolution uses (see
   * resolveEnvString(), reused here rather than re-implemented). Callers
   * may pass a value loadConfig() already resolved (a plain path, in which
   * case this is a no-op) or a raw unresolved settings value directly.
   *
   * REQUIRED when `sessionBackend` is `"local"` (the default) — ignored
   * when it's `"portunus"`, since a Portunus-backed session has no local
   * file path at all (see session-backend.ts).
   */
  storageStatePathSetting?: string;
  /**
   * Which vault the source's captured session lives in — `"local"` (the
   * default, today's on-disk encrypted-vault behavior, unchanged) or
   * `"portunus"` (oauth-session-capture-v2 epic, portunus-session-backend
   * story — see session-backend.ts). Omitting this field is byte-identical
   * to explicitly passing `"local"`.
   */
  sessionBackend?: SessionBackend;
  /**
   * REQUIRED per-source origin allowlist (bare domains, e.g.
   * ["app.example.com", "www.example.com"]) — see filterStorageStateToAllowlist().
   * There is deliberately no default/optional form: every caller must
   * declare exactly which domains its browser context is allowed to hold
   * credentials for.
   */
  allowedOrigins: string[];
  /** URL to navigate to before the auth-failure predicate is checked. */
  url: string;
  /**
   * Caller-supplied "is this page actually authenticated?" check, run after
   * navigation to `url`. This module does NOT hardcode any generic
   * "contains Sign In"-style heuristic — auth-failure detection is entirely
   * source-specific and is the caller's (adapter's) responsibility. Must
   * never inspect or return page content; it returns only a boolean.
   */
  isAuthenticated: (page: Page) => Promise<boolean>;
}

/**
 * Reads a storageState JSON file from disk, validating it has the expected
 * `{cookies[], origins[]}` shape. Throws a specific error NAMING THE PATH on
 * any failure (missing file, unreadable, invalid JSON, wrong shape) —
 * distinct from (and always checked before) the auth-failure error below.
 *
 * Encrypted at rest, migrate-on-read (encrypted-local-storage epic,
 * session-file-encryption story): detects the on-disk format with
 * vault.ts's isEncryptedEnvelope(). If it's already an encrypted envelope,
 * decrypts before parsing — no further write. If it's legacy plaintext,
 * parses the content as-is AND immediately re-writes it encrypted, via
 * session-capture.ts's EXPORTED writeStorageStateAtomically() (reused, not
 * duplicated — same atomic temp-file+rename+0600 discipline that module's
 * own write already proves out). Always migrate-writes on legacy content
 * here: unlike save.ts's config.json path, this is a standalone,
 * externally-facing read with no save-then-validate complication requiring
 * an internal/external distinction.
 *
 * Ensures the vault key exists first via getOrCreateKey(hasAnyEncryptedFile)
 * — this read path may be the very first vault operation in the process
 * (e.g. a cron run that only ever calls withBrowserSession(), never
 * loadConfig()) — throwing vault.ts's specific VaultKeyLostError if the key
 * is gone but encrypted data exists elsewhere. Throws vault.ts's
 * VaultTamperError — re-thrown with an actionable, session-file-specific
 * message — if the encrypted file's content has been corrupted/tampered
 * with (GCM auth-tag mismatch).
 *
 * EXPORTED (profile-assist epic) so assist-session.ts can reuse this exact
 * read/decrypt/migrate path for a persistent session's initial storageState
 * load, instead of a second, duplicated implementation — origin-scoping is
 * safety-critical and must never fork into two copies.
 */
export function readStorageStateFile(filePath: string): StorageState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `${MODULE_PREFIX}: no storageState file found at "${filePath}". ` +
          "Generate one by logging in once with a headed Playwright browser and saving its storage state " +
          "(see docs/ARCHITECTURE.md's auth section for the exact steps), then reference that path from this source's settings.",
      );
    }
    throw new Error(
      `${MODULE_PREFIX}: could not read storageState file at "${filePath}": ${code ?? (e instanceof Error ? e.message : String(e))}`,
    );
  }

  // Ensure the vault key exists (or fail loudly if it's been lost while
  // encrypted data sits on disk) BEFORE attempting any decrypt() below —
  // see vault.ts's getOrCreateKey() doc comment. Idempotent with any other
  // entry point's own getOrCreateKey() call (same key file, same bytes back
  // out every time — see vault.ts's header comment), so calling it again
  // here keeps this function correct on its own, independent of caller
  // order.
  getOrCreateKey(hasAnyEncryptedFile);

  const wasEncrypted = isEncryptedEnvelope(raw);

  let jsonText: string;
  if (wasEncrypted) {
    try {
      jsonText = decrypt(raw);
    } catch (e) {
      if (e instanceof VaultTamperError) {
        // Re-thrown as the SAME error type (never conflated with a generic
        // Error) with an actionable, session-file-specific message spliced
        // in ahead of vault.ts's own explanation — mirrors load.ts's
        // config.json/.env handling.
        e.message = `${MODULE_PREFIX}: storageState file at "${filePath}" ${e.message}`;
        throw e;
      }
      throw e;
    }
  } else {
    jsonText = raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`${MODULE_PREFIX}: storageState file at "${filePath}" is not valid JSON.`);
  }

  if (!isStorageStateShape(parsed)) {
    throw new Error(
      `${MODULE_PREFIX}: storageState file at "${filePath}" does not match the expected ` +
        '{ cookies: [...], origins: [...] } storageState shape.',
    );
  }

  if (!wasEncrypted) {
    // Legacy plaintext: transparently upgrade to an encrypted envelope, one
    // time, automatic — see this function's doc comment. Reuses
    // session-capture.ts's exported atomic-write helper rather than
    // duplicating its temp-file+rename+0600 discipline a second time.
    writeStorageStateAtomically(filePath, parsed);
  }

  return parsed;
}

/**
 * Structural check only (not a full schema) — enough to catch "wrong file
 * entirely" without over-validating cookie/origin field shapes. EXPORTED
 * (oauth-session-capture-v2 epic, portunus-session-backend story) so
 * session-backend.ts's readSessionViaPortunus() can validate the payload it
 * gets back from Portunus's tempfile the same way, instead of a second,
 * duplicated shape check.
 */
export function isStorageStateShape(value: unknown): value is StorageState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.cookies) && Array.isArray(v.origins);
}

/**
 * True if `domain` (a cookie's `domain` field, or a hostname parsed from an
 * origin URL) is within `allowedDomain` — i.e. an exact match, or a
 * subdomain of it. Cookie domains may carry a leading dot per the
 * storageState/cookie spec (".example.com"), stripped before comparing.
 *
 * Deliberately NOT a substring/`.includes()` check — that would let
 * "evil-example.com" or "example.com.attacker.net" incorrectly match an
 * allowlist entry of "example.com". Only an exact hostname match or a
 * proper subdomain (ending in "." + allowedDomain) counts.
 */
function domainMatchesAllowlist(domain: string, allowedOrigins: string[]): boolean {
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return allowedOrigins.some((allowed) => {
    const allowedNormalized = allowed.replace(/^\./, "").toLowerCase();
    return normalized === allowedNormalized || normalized.endsWith(`.${allowedNormalized}`);
  });
}

/**
 * THE safety-critical operation in this module (see file-level comment and
 * this story's design_decisions/risks). Filters a loaded storageState's
 * `cookies[]`/`origins[]` down to ONLY entries whose domain/hostname matches
 * `allowedOrigins`, via domainMatchesAllowlist() above. Exported directly so
 * tests can assert on its output in isolation, independent of any browser
 * launch.
 *
 * MUST be called — and its result used — before every
 * `browser.newContext({ storageState })` call in this module. Never pass an
 * unfiltered StorageState into newContext().
 */
export function filterStorageStateToAllowlist(storageState: StorageState, allowedOrigins: string[]): StorageState {
  return {
    cookies: storageState.cookies.filter((cookie) => domainMatchesAllowlist(cookie.domain, allowedOrigins)),
    origins: storageState.origins.filter((entry) => {
      let hostname: string;
      try {
        hostname = new URL(entry.origin).hostname;
      } catch {
        return false; // malformed origin string — exclude conservatively, never include on a parse failure
      }
      return domainMatchesAllowlist(hostname, allowedOrigins);
    }),
  };
}

/**
 * Resolves the Chromium executable Playwright expects to launch and checks
 * it actually exists on disk — WITHOUT launching a browser. Lets this
 * module distinguish "binary not installed" (this function) from any other
 * launch failure, so the former gets a specific, actionable error instead
 * of a raw, confusing Playwright stack trace (see this story's risks: `npm
 * install`'s postinstall download isn't guaranteed to have run).
 */
export function checkChromiumAvailable(): void {
  const executablePath = chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    throw new Error(
      `${MODULE_PREFIX}: Chromium binary not found (expected at "${executablePath}"). ` +
        "Run `npx playwright install chromium` to download it, then retry.",
    );
  }
}

let warnedNoRealChrome = false;

/**
 * Launches a browser for `logContext` (e.g. `source "gofractional"`),
 * preferring the real, locally-installed Google Chrome (`channel: "chrome"`)
 * over Playwright's bundled Chromium build ("Chrome for Testing"). Google's
 * OAuth sign-in flow actively fingerprints and rejects the bundled build
 * ("This browser or app may not be secure") independent of automation
 * flags -- confirmed live during this fix. Launching the actual Chrome
 * binary a user has installed passes the same flow. `headless` is passed
 * straight through to `chromium.launch()` -- see this module's header
 * comment for the headless-first-with-headed-fallback rationale.
 *
 * Falls back to bundled Chromium -- already confirmed present by the
 * caller's own checkChromiumAvailable() call -- when real Chrome isn't
 * installed on this machine, so this module keeps working everywhere; only
 * the OAuth-rejection caveat is unresolved in that fallback case. The
 * fallback warning is logged once per process (not once per launch) to
 * avoid repeat-launch log spam.
 *
 * Uses `launchServer()` + `connect()` rather than plain `chromium.launch()`
 * -- the ONLY way to get the real spawned process's pid back (a plain
 * `Browser` from `.launch()` exposes no such accessor). The pid is what
 * lets minimizeChromeWindow()/positionChromeWindowSideBySide() (real-
 * chrome.ts) target THIS SPECIFIC window via System Events instead of
 * Chrome's own ambiguous, shared `window 1` -- see minimizeChromeWindow()'s
 * own doc comment for the real, live-reproduced bug that fixed. The
 * returned `close()` tears down BOTH the connected `Browser` and the
 * underlying `BrowserServer` -- closing only one would leave the other's
 * process/connection dangling.
 */
export async function launchScopedChromium(
  headless: boolean,
  logContext: string,
): Promise<{ browser: Browser; pid: number | undefined; close: () => Promise<void> }> {
  async function launchAndConnect(channel: "chrome" | undefined): Promise<{ browser: Browser; pid: number | undefined; close: () => Promise<void> }> {
    const server = await chromium.launchServer(channel ? { headless, channel } : { headless });
    try {
      const browser = await chromium.connect(server.wsEndpoint());
      return {
        browser,
        pid: server.process().pid,
        close: async () => {
          await browser.close().catch(() => {});
          await server.close().catch(() => {});
        },
      };
    } catch (e) {
      await server.close().catch(() => {});
      throw e;
    }
  }

  try {
    return await launchAndConnect("chrome");
  } catch {
    if (!warnedNoRealChrome) {
      warnedNoRealChrome = true;
      console.warn(
        `${MODULE_PREFIX}: real Google Chrome not found on this machine -- falling back to Playwright's ` +
          "bundled Chromium. Google OAuth sign-in flows are likely to be rejected in this fallback mode " +
          "(\"This browser or app may not be secure\"). Install Google Chrome for full compatibility.",
      );
    }
    try {
      return await launchAndConnect(undefined);
    } catch (e) {
      throw new Error(
        `${MODULE_PREFIX}: failed to launch a browser for ${logContext}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * Thrown by navigateAndCheckAuth() when `options.isAuthenticated` returns
 * false — distinct from any error `run()` itself might throw, so
 * withBrowserSession() can tell "the session itself was bad" (worth a
 * persistent-real-chrome retry, see below) apart from "the scrape logic
 * failed for an unrelated reason" (never retried here).
 */
class SessionAuthError extends Error {}

/**
 * Navigates `page` to `url`, runs the shared verification-challenge check
 * then the caller's own `isAuthenticated` predicate, and throws
 * (VerificationChallengeError or SessionAuthError) on either failure —
 * shared between withBrowserSession()'s two acquisition paths (the fast
 * default path and the persistent-real-chrome fallback below) so the
 * auth-failure detection logic exists exactly once.
 */
async function navigateAndCheckAuth(
  page: Page,
  url: string,
  sourceId: string,
  isAuthenticated: (page: Page) => Promise<boolean>,
): Promise<void> {
  await page.goto(url);

  // verification-copilot epic: a cheap page-content signal (title +
  // visible body text), checked BEFORE the caller's own isAuthenticated
  // predicate — a verification challenge is a distinct failure mode
  // from "session expired," and the caller's own auth check may not
  // recognize it as anything other than a generic auth failure. See
  // verification-challenge.ts's own header comment for why this is
  // wired here (the one shared call site) rather than per-adapter.
  const title = await page.title();
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (isVerificationChallengeContent(`${title}\n${bodyText.slice(0, 2000)}`)) {
    throw new VerificationChallengeError(sourceId, url);
  }

  const authenticated = await isAuthenticated(page);
  if (!authenticated) {
    throw new SessionAuthError(
      `${MODULE_PREFIX}: session expired/invalid for source "${sourceId}" (checked against "${url}").`,
    );
  }
}

/**
 * THE FAST, DEFAULT acquisition path — a fresh, origin-scoped Playwright
 * Chromium context seeded from the source's own captured storageState
 * snapshot. Cheap and, when the snapshot is still valid, indistinguishable
 * from the old (pre-self-healing) behavior. Throws SessionAuthError or
 * VerificationChallengeError (never silently) when the snapshot no longer
 * authenticates — withBrowserSession() below catches exactly those two to
 * decide whether the next tier is warranted.
 *
 * `headless` lets the caller (withBrowserSession()'s three-tier chain) try
 * this exact same acquisition twice — headless first, headed second — with
 * no duplicated logic between the two attempts. `minimizeAfterAuth: true`
 * (only ever passed on the HEADED attempt, and only from an unattended-scan
 * caller — never from a caller with a human actively present) minimizes the
 * window immediately once auth is confirmed, before `run()` executes, so it
 * never sits visible/focus-stealing for the scan's duration.
 */
async function acquireViaStorageStateSnapshot<T>(
  options: BrowserSessionOptions,
  scopedStorageState: StorageState,
  run: (page: Page) => Promise<T>,
  headless: boolean,
  minimizeAfterAuth: boolean,
): Promise<T> {
  const { sourceId, url, isAuthenticated } = options;
  checkChromiumAvailable();
  const { browser, pid, close } = await launchScopedChromium(headless, `source "${sourceId}"`);
  try {
    const context = await browser.newContext({ storageState: scopedStorageState });
    try {
      const page = await context.newPage();
      await navigateAndCheckAuth(page, url, sourceId, isAuthenticated);
      // pid -- the real Chrome process THIS launch spawned -- see
      // minimizeChromeWindow()'s own doc comment for why the specific pid
      // matters, not just "some Chrome window".
      if (minimizeAfterAuth && pid) await minimizeChromeWindow(pid);
      return await run(page);
    } finally {
      await context.close();
    }
  } finally {
    await close();
  }
}

/**
 * THE SELF-HEALING FALLBACK (status-reconciliation-outcomes epic's
 * companion story, persistent-session-fix — owner's own words, 2026-09-01,
 * correcting a proposed one-off re-Capture-Login: "you HAVE to fix your
 * long term lived session rather than doing a single session capture that
 * then recreates the entire thing with no session data").
 *
 * ROOT CAUSE this fixes: the fast path above launches a FRESH, Playwright-
 * fingerprinted Chromium (`chromium.launch()` — carries automation flags
 * regardless of `channel`, per real-chrome.ts's own header comment) fed a
 * STATIC storageState snapshot captured once and never renewed. When the
 * target site invalidates that snapshot server-side, this module had no
 * recovery path — every future call kept replaying the same dead cookies
 * into the same fingerprint-detectable browser, live-verified (2026-09-01)
 * to trip Cloudflare's "Just a moment…" challenge on GoFractional.
 *
 * THE FIX: retry via real-chrome.ts's spawn-then-attach mechanism against
 * the SAME shared, persistent `--user-data-dir` Capture Login itself uses
 * (`spawnRealChrome({persistent:true})`) — a REAL, non-fingerprinted Chrome
 * process, reusing its own on-disk cookie jar (`browser.contexts()[0]`,
 * NEVER `newContext()` — see session-capture.ts's own doc comment: a fresh
 * context is always isolated from the persistent profile's real cookies,
 * regardless of `--user-data-dir`). If that authenticates, this function
 * ALSO writes a fresh storageState snapshot back to disk (local backend
 * only) before returning — so the fast path above is self-healed for every
 * later call, rather than staying permanently broken until a human re-runs
 * Capture Login. Mirrors session-capture.ts's own spawn/attach/cleanup
 * pattern exactly (including always killing the spawned process when done —
 * "persistent" describes the ON-DISK PROFILE surviving between spawns, not
 * a long-lived background process; see project memory
 * gigradar-real-chrome-persistent-profile.md).
 *
 * Storage-state write-back is best-effort: a failure to persist the
 * refreshed snapshot is logged, never thrown — the caller already got a
 * real, successful result from `run(page)` at that point, and losing the
 * self-heal for THIS call only degrades the next call back to "fast path
 * fails, falls back here again," not a hard failure.
 */
async function acquireViaPersistentRealChrome<T>(
  options: BrowserSessionOptions,
  scopedAllowedOrigins: string[],
  storageStatePathToRefresh: string | undefined,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const { sourceId, url, isAuthenticated } = options;
  const handle = await spawnRealChrome({ persistent: true });
  const browser = await attachToRealChrome(handle.cdpPort);
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();
    try {
      await navigateAndCheckAuth(page, url, sourceId, isAuthenticated);
      // embedded-browser-and-guided-session epic: this tier only ever runs
      // from an unattended-scan caller (withBrowserSession()'s own chain) —
      // never with a human actively present, so minimizing immediately once
      // auth is confirmed is always correct here, unconditionally.
      // handle.process.pid -- the SPECIFIC spawned Chrome process, never
      // Chrome's own ambiguous shared window list (see
      // minimizeChromeWindow()'s own doc comment).
      if (handle.process.pid) await minimizeChromeWindow(handle.process.pid);
      const result = await run(page);

      if (storageStatePathToRefresh) {
        try {
          const freshState = (await context.storageState()) as StorageState;
          const scopedFreshState = filterStorageStateToAllowlist(freshState, scopedAllowedOrigins);
          writeStorageStateAtomically(storageStatePathToRefresh, scopedFreshState);
        } catch (e) {
          console.warn(
            `${MODULE_PREFIX}: real-chrome fallback succeeded for source "${sourceId}" but refreshing its storageState snapshot failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      return result;
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    // Mirrors session-capture.ts's own safeCloseBrowser(): swallow the
    // Playwright-side close error (the CDP connection may already be
    // closing) since closeRealChrome()'s pkill-based kill guarantees the
    // real process dies either way -- see that function's own doc comment.
    try {
      await browser.close();
    } catch {
      // already closed/closing
    }
    closeRealChrome(handle);
  }
}

/**
 * Acquires an origin-scoped browser session for one source, hands the
 * caller a `Page` (already navigated to `options.url` and confirmed
 * authenticated by `options.isAuthenticated`) via `run`, and GUARANTEES the
 * browser is closed on every exit path. Cleanup is owned centrally here,
 * never left to the caller/adapter.
 *
 * THREE ACQUISITION TIERS, self-healing (see acquireViaPersistentRealChrome()'s
 * own doc comment for the persistent-real-chrome rationale, and this
 * module's header comment for the headless-first rationale):
 *   1. storageState snapshot, HEADLESS — no window ever appears if this
 *      works.
 *   2. storageState snapshot, HEADED (this module's original fast path) —
 *      only reached if tier 1 threw VerificationChallengeError or
 *      SessionAuthError. Minimized immediately once auth is confirmed.
 *   3. persistent-real-chrome retry, HEADED — only reached if tier 2 ALSO
 *      threw one of those same two error types. Refreshes the storageState
 *      snapshot on success so tier 1/2 are self-healed for later calls.
 * Any OTHER error (including one `run()` itself throws) is never retried —
 * it propagates immediately from whichever tier it came from. If tier 3
 * ALSO fails, throws a combined, actionable error naming both the
 * triggering failure and tier 3's own — Capture Login is genuinely the
 * last resort now, not the only path.
 *
 * Throws (before ever launching a browser) if the storageState file is
 * missing/unreadable/malformed — see readStorageStateFile().
 */
export async function withBrowserSession<T>(options: BrowserSessionOptions, run: (page: Page) => Promise<T>): Promise<T> {
  const { sourceId, storageStatePathSetting, sessionBackend, allowedOrigins, url } = options;

  if (allowedOrigins.length === 0) {
    throw new Error(
      `${MODULE_PREFIX}: source "${sourceId}" supplied an empty origin allowlist. ` +
        "A non-empty allowedOrigins list is required — see this module's origin-scoping contract.",
    );
  }

  const backend = sessionBackend ?? "local";

  let resolvedStorageStatePath: string | undefined;
  let rawStorageState: StorageState;
  if (backend === "portunus") {
    rawStorageState = await readSessionViaPortunus(sourceId, PORTUNUS_SESSION_ACCOUNT);
  } else {
    if (!storageStatePathSetting) {
      throw new Error(
        `${MODULE_PREFIX}: source "${sourceId}" is using the local session backend but no storageState path was supplied.`,
      );
    }
    resolvedStorageStatePath = resolveEnvString(storageStatePathSetting, `source "${sourceId}" settings storageState path`);
    rawStorageState = readStorageStateFile(resolvedStorageStatePath);
  }

  const scopedStorageState = filterStorageStateToAllowlist(rawStorageState, allowedOrigins);

  const isSessionOrChallengeError = (e: unknown): boolean =>
    e instanceof VerificationChallengeError || e instanceof SessionAuthError;

  try {
    return await acquireViaStorageStateSnapshot(options, scopedStorageState, run, /* headless */ true, /* minimizeAfterAuth */ false);
  } catch (e) {
    if (!isSessionOrChallengeError(e)) throw e; // an unrelated failure (e.g. from run() itself) -- never retried
    // Headless failing isn't itself surfaced further -- tier 2 (headed) is
    // always at least as diagnostic, and is what a human capturing a fresh
    // session actually saw, so its own error is what propagates below.
  }

  let fastPathError: unknown;
  try {
    return await acquireViaStorageStateSnapshot(options, scopedStorageState, run, /* headless */ false, /* minimizeAfterAuth */ true);
  } catch (e) {
    if (!isSessionOrChallengeError(e)) throw e; // an unrelated failure (e.g. from run() itself) -- never retried
    fastPathError = e;
  }

  try {
    return await acquireViaPersistentRealChrome(options, allowedOrigins, resolvedStorageStatePath, run);
  } catch (fallbackError) {
    // If tier 2's own failure was a verification challenge, that diagnosis
    // is already actionable (runner.ts's per-source error handling routes
    // VerificationChallengeError, via instanceof, to a DISTINCT "needs
    // human verification" issue rather than a generic "source fetch
    // failed" one -- see verification-challenge.ts's own doc comment)
    // regardless of why tier 3 ALSO failed. Preserve and re-throw that
    // ORIGINAL error rather than tier 3's own (possibly unrelated, e.g.
    // "real Chrome not installed") failure.
    if (fastPathError instanceof VerificationChallengeError) throw fastPathError;
    throw new Error(
      `${MODULE_PREFIX}: session for source "${sourceId}" (checked against "${url}") is invalid, and the ` +
        `persistent-real-chrome retry ALSO failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}. ` +
        "Run Capture Login for this source to establish a fresh, real, logged-in session.",
    );
  }
}
