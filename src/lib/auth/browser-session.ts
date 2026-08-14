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
// HEADED ONLY. `headless: false` is the only mode this module launches —
// live testing during this epic's planning confirmed both target sites
// (GoFractional, A.Team) fail authentication in headless mode, independent
// of session validity (likely bot detection). Do not add a `headless`
// option here; that's a separate, deliberate future decision, not a default
// fallback (see design_decisions in the story YAML).
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
import { writeStorageStateAtomically } from "./session-capture.js";

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
   */
  storageStatePathSetting: string;
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
 */
function readStorageStateFile(filePath: string): StorageState {
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

/** Structural check only (not a full schema) — enough to catch "wrong file entirely" without over-validating cookie/origin field shapes. */
function isStorageStateShape(value: unknown): value is StorageState {
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
 * Launches a headed browser for `logContext` (e.g. `source "gofractional"`),
 * preferring the real, locally-installed Google Chrome (`channel: "chrome"`)
 * over Playwright's bundled Chromium build ("Chrome for Testing"). Google's
 * OAuth sign-in flow actively fingerprints and rejects the bundled build
 * ("This browser or app may not be secure") independent of automation
 * flags -- confirmed live during this fix. Launching the actual Chrome
 * binary a user has installed passes the same flow.
 *
 * Falls back to bundled Chromium -- already confirmed present by the
 * caller's own checkChromiumAvailable() call -- when real Chrome isn't
 * installed on this machine, so this module keeps working everywhere; only
 * the OAuth-rejection caveat is unresolved in that fallback case. The
 * fallback warning is logged once per process (not once per launch) to
 * avoid repeat-launch log spam.
 */
export async function launchHeadedBrowser(logContext: string): Promise<Browser> {
  try {
    return await chromium.launch({ headless: false, channel: "chrome" });
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
      return await chromium.launch({ headless: false });
    } catch (e) {
      throw new Error(
        `${MODULE_PREFIX}: failed to launch a browser for ${logContext}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * Launches a headed, origin-scoped Chromium session for one source, hands
 * the caller a `Page` (already navigated to `options.url` and confirmed
 * authenticated by `options.isAuthenticated`) via `run`, and GUARANTEES
 * `context.close()`/`browser.close()` are called exactly once each on every
 * exit path — including when `run` throws, and when the auth-failure
 * predicate returns false — via a `finally` block. Cleanup is owned
 * centrally here, never left to the caller/adapter (see design_decisions in
 * the story YAML: a leaked Chromium process on every auth-failure run would
 * be a real operational bug otherwise).
 *
 * Throws (before ever launching a browser) if the storageState file is
 * missing/unreadable/malformed — see readStorageStateFile(). Throws (after
 * navigation, before invoking `run`) a specific, actionable
 * "session expired/invalid" error if `isAuthenticated` returns false — the
 * browser/context are still cleanly closed in that case, same as any other
 * throw. Never silently proceeds or returns as if nothing is wrong.
 */
export async function withBrowserSession<T>(options: BrowserSessionOptions, run: (page: Page) => Promise<T>): Promise<T> {
  const { sourceId, storageStatePathSetting, allowedOrigins, url, isAuthenticated } = options;

  if (allowedOrigins.length === 0) {
    throw new Error(
      `${MODULE_PREFIX}: source "${sourceId}" supplied an empty origin allowlist. ` +
        "A non-empty allowedOrigins list is required — see this module's origin-scoping contract.",
    );
  }

  const storageStatePath = resolveEnvString(
    storageStatePathSetting,
    `source "${sourceId}" settings storageState path`,
  );

  const rawStorageState = readStorageStateFile(storageStatePath);
  const scopedStorageState = filterStorageStateToAllowlist(rawStorageState, allowedOrigins);

  checkChromiumAvailable();

  const browser: Browser = await launchHeadedBrowser(`source "${sourceId}"`);

  try {
    const context = await browser.newContext({ storageState: scopedStorageState });
    try {
      const page = await context.newPage();
      await page.goto(url);

      const authenticated = await isAuthenticated(page);
      if (!authenticated) {
        throw new Error(
          `${MODULE_PREFIX}: session expired/invalid for source "${sourceId}" (checked against "${url}"). ` +
            "Re-authenticate by generating a fresh storageState file and updating this source's settings.",
        );
      }

      return await run(page);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
