// Tests for src/lib/auth/browser-session.ts. Per this story's acceptance
// criteria and risks (see
// .pHive/epics/browser-session-auth/stories/browser-session-mechanism.yaml),
// the highest-stakes coverage here is:
//   1. origin-scoping — proven by inspecting the ACTUAL object passed into
//      browser.newContext(), not just trusting filterStorageStateToAllowlist()
//      ran without error;
//   2. cleanup-on-throw — context.close()/browser.close() called exactly
//      once each on every exit path (auth-failure throw, callback throw,
//      happy path).
// Chromium launch is fully mocked throughout — no real browser, no live
// network — per the story's "mock Chromium launch where the test doesn't
// need a real browser" guidance. filterStorageStateToAllowlist() itself is
// exercised directly against a real (small) multi-origin fixture file.
//
// Every assertion in this file checks only fixed diagnostic strings, URLs,
// paths, and the fixture's known cookie/localStorage VALUES (never
// simulated "scraped page DOM" — this module never touches page content in
// an error path, and the dedicated test at the bottom proves it).
//
// Encrypted at rest, migrate-on-read (encrypted-local-storage epic,
// session-file-encryption story): readStorageStateFile() now
// decrypts-if-needed and migrate-writes legacy plaintext to an encrypted
// envelope. `writeFixtureCopy()` below writes a LEGACY PLAINTEXT copy of
// the fixture (today's on-disk format, per the story's own naming) so the
// migrate-on-read path is exercised by every existing test that calls it —
// `writeEncryptedFixtureCopy()` is the new already-encrypted counterpart,
// used by the dedicated encryption-at-rest tests below. XDG_CONFIG_HOME
// (where the vault key lives — see src/lib/security/key-path.ts) gets its
// own fresh-per-test isolation, separate from `tmpDir`, so this suite never
// touches a real user's actual ~/.config/gigradar/key.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launchMock = vi.fn();
const executablePathMock = vi.fn();

// real bug fix, 2026-09-03: launchScopedChromium() now uses
// launchServer()+connect() (not plain launch()) so it can get the real
// spawned process's pid back for minimizeChromeWindow()'s pid-targeted
// System Events addressing (see real-chrome.ts's own doc comment on the
// live-reproduced bug this replaced). `connect` is wired straight through
// to the SAME `launchMock` every existing test in this file already
// controls via mockResolvedValue(fakeBrowser)/mockRejectedValue(...) --
// that's still "does launching a usable browser succeed," it just happens
// via connect() now instead of launch() directly. `launchServerMock`
// defaults to a fake, always-succeeding BrowserServer (own beforeEach
// below) since no existing test cares about the server-launch step
// itself, only the end-to-end "browser available or not" outcome
// launchMock/connect already represents.
const launchServerMock = vi.fn();
const connectMock = vi.fn((...args: unknown[]) => launchMock(...args));

vi.mock("playwright", () => ({
  chromium: {
    launch: (...args: unknown[]) => launchMock(...args),
    launchServer: (...args: unknown[]) => launchServerMock(...args),
    connect: (...args: unknown[]) => connectMock(...args),
    executablePath: (...args: unknown[]) => executablePathMock(...args),
  },
}));

const readSessionViaPortunusMock = vi.fn();
vi.mock("../session-backend.js", () => ({
  PORTUNUS_SESSION_ACCOUNT: "gigradar",
  readSessionViaPortunus: (...args: unknown[]) => readSessionViaPortunusMock(...args),
}));

// self-healing-persistent-session-fix story: withBrowserSession() now
// retries a fast-path auth failure via real-chrome.ts's spawn/attach
// mechanism. Fully mocked here too (matching session-capture.test.ts's own
// convention) -- these tests care about the FAST path's own behavior;
// spawnRealChromeMock defaults to a rejection (see beforeEach below) so the
// fallback fails immediately and predictably rather than actually spawning
// a real Chrome process during `npm test`.
const spawnRealChromeMock = vi.fn();
const attachToRealChromeMock = vi.fn();
const closeRealChromeMock = vi.fn();
// embedded-browser-and-guided-session epic: minimizeChromeWindow() is a
// real, best-effort no-op-on-failure osascript call in production --
// mocked to a resolved no-op here so these tests never shell out, and left
// unasserted-on by default (individual tests below opt into asserting
// call counts where the minimize-on-headed-fallback behavior is itself
// under test).
const minimizeChromeWindowMock = vi.fn();
vi.mock("../real-chrome.js", () => ({
  spawnRealChrome: (...args: unknown[]) => spawnRealChromeMock(...args),
  attachToRealChrome: (...args: unknown[]) => attachToRealChromeMock(...args),
  closeRealChrome: (...args: unknown[]) => closeRealChromeMock(...args),
  minimizeChromeWindow: (...args: unknown[]) => minimizeChromeWindowMock(...args),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest, so
// this ordering is actually irrelevant, but keeping it below documents the
// dependency clearly).
import {
  checkChromiumAvailable,
  filterStorageStateToAllowlist,
  withBrowserSession,
  type StorageState,
} from "../browser-session.js";
import { VaultKeyLostError, VaultTamperError, decrypt, encrypt, isEncryptedEnvelope } from "../../security/vault.js";
import { VerificationChallengeError } from "../../sources/verification-challenge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "multi-origin-storage-state.json");
const FIXTURE: StorageState = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const FIXTURE_RAW = fs.readFileSync(FIXTURE_PATH, "utf8");

const TARGET_ALLOWLIST = ["targetsource.example"];

let tmpDir: string;
let tmpKeyDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.spyOn's return type on an fs overload is awkward to name exactly; only .mockReturnValue()/.mockImplementation() are used below.
let existsSyncSpy: any;
// Captured once, before any test installs a spy over fs.existsSync — the
// REAL implementation, reused by every test below that needs to fake out
// ONLY the Chromium executable path while leaving every other
// fs.existsSync() call (notably this story's vault key checks) hitting the
// real filesystem.
const realExistsSync = fs.existsSync.bind(fs);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-browser-session-test-"));
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-browser-session-test-key-"));
  process.env.XDG_CONFIG_HOME = tmpKeyDir;
  // Also isolate XDG_DATA_HOME: hasAnyEncryptedFile()'s combined check
  // (config.json OR .env OR the session-state directory) resolves the
  // session-state directory via getDefaultDataDir(), and this suite must
  // never let that scan see a real user's actual data directory.
  process.env.XDG_DATA_HOME = tmpDir;
  launchMock.mockReset();
  launchServerMock.mockReset();
  launchServerMock.mockResolvedValue({
    wsEndpoint: () => "ws://fake-server",
    process: () => ({ pid: 24681 }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  connectMock.mockReset();
  connectMock.mockImplementation((...args: unknown[]) => launchMock(...args));
  executablePathMock.mockReset();
  readSessionViaPortunusMock.mockReset();
  spawnRealChromeMock.mockReset();
  attachToRealChromeMock.mockReset();
  closeRealChromeMock.mockReset();
  minimizeChromeWindowMock.mockReset();
  minimizeChromeWindowMock.mockResolvedValue(undefined);
  // Default: the persistent-real-chrome fallback fails fast (no real Chrome
  // in a test environment) -- individual tests that need to exercise a
  // SUCCESSFUL fallback override this.
  spawnRealChromeMock.mockRejectedValue(new Error("real Chrome not available in test"));
  executablePathMock.mockReturnValue("/fake/chromium/executable");
  // Chromium "available" by default in every test except the dedicated
  // missing-binary tests below, which override this — but ONLY for the
  // fake executable path. Everything else must delegate to the REAL
  // fs.existsSync: readStorageStateFile()'s vault key checks (getOrCreateKey()
  // et al, added by this story) also call fs.existsSync(), and a blunt
  // `mockReturnValue(true)`/`mockReturnValue(false)` covering every path
  // would silently corrupt those checks too (e.g. reporting a real,
  // just-written key file as "missing").
  existsSyncSpy = vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
    if (p === "/fake/chromium/executable") return true;
    return realExistsSync(p);
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpKeyDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.GIGRADAR_TEST_STORAGE_STATE_PATH;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_DATA_HOME;
});

/** Writes a LEGACY PLAINTEXT copy of the multi-origin fixture (today's pre-migration on-disk format) and returns its path. */
function writeFixtureCopy(): string {
  const dest = path.join(tmpDir, "storage-state.json");
  fs.copyFileSync(FIXTURE_PATH, dest);
  return dest;
}

/** Writes an ALREADY-ENCRYPTED copy of the multi-origin fixture (encrypt() requires the vault key to already exist — see getOrCreateKeyForTest() below) and returns its path. */
function writeEncryptedFixtureCopy(): string {
  getOrCreateKeyForTest();
  const dest = path.join(tmpDir, "storage-state.json");
  fs.writeFileSync(dest, encrypt(FIXTURE_RAW));
  return dest;
}

/** Ensures the vault key exists under the current (test-isolated) XDG_CONFIG_HOME, for fixtures that need to encrypt() ahead of calling withBrowserSession()/readStorageStateFile(). Mirrors config/__tests__/load.test.ts's own getOrCreateKeyForTest() helper. */
function getOrCreateKeyForTest(): void {
  const keyPath = path.join(tmpKeyDir, "gigradar", "key");
  if (fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
}

/**
 * A fake Page whose every method is a spy; goto() is a no-op by default.
 * `title()`/`locator("body").innerText()` default to empty strings so
 * withBrowserSession()'s verification-challenge check (verification-
 * copilot epic) is a no-op for every test that doesn't explicitly
 * override them — isVerificationChallengeContent("") is always false.
 */
function createFakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue(""),
    locator: vi.fn().mockReturnValue({ innerText: vi.fn().mockResolvedValue("") }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A fake BrowserContext: newPage() resolves the given page, close() is a tracked spy. */
function createFakeContext(page: unknown) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** A fake Browser: newContext() resolves the given context (recording call args), close() is a tracked spy. */
function createFakeBrowser(context: unknown) {
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Wires a fake page/context/browser together and registers them with launchMock. Returns all three for assertions. */
function setUpFakeBrowserChain(pageOverrides: Record<string, unknown> = {}) {
  const page = createFakePage(pageOverrides);
  const context = createFakeContext(page);
  const browser = createFakeBrowser(context);
  launchMock.mockResolvedValue(browser);
  return { page, context, browser };
}

const FAKE_REAL_CHROME_HANDLE = { process: { kill: vi.fn() }, cdpPort: 9999, userDataDir: "/fake/real-chrome-profile", persistent: true };

/**
 * Wires a fake page/context/"real Chrome" browser together and registers
 * them with spawnRealChromeMock/attachToRealChromeMock — the
 * persistent-real-chrome fallback's own acquisition chain, distinct from
 * setUpFakeBrowserChain()'s fast-path (launchMock) chain. `context.contexts()`
 * on the returned fake browser exposes exactly this one context (mirroring
 * `browser.contexts()[0]` — the real, persistent-profile default context,
 * never `newContext()`), and `context.storageState()` resolves
 * `storageStateResult` (default: an empty, valid StorageState) so the
 * self-heal write-back path has something real to filter and persist.
 */
function setUpFakeRealChromeChain(pageOverrides: Record<string, unknown> = {}, storageStateResult: StorageState = { cookies: [], origins: [] }) {
  const page = createFakePage(pageOverrides);
  const context = {
    ...createFakeContext(page),
    storageState: vi.fn().mockResolvedValue(storageStateResult),
  };
  const browser = { contexts: vi.fn().mockReturnValue([context]), newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
  spawnRealChromeMock.mockResolvedValue(FAKE_REAL_CHROME_HANDLE);
  attachToRealChromeMock.mockResolvedValue(browser);
  return { page, context, browser };
}

describe("filterStorageStateToAllowlist: origin-scoping filter (the story's highest-stakes behavior)", () => {
  it("keeps only cookies whose domain is an exact match or subdomain of an allowlisted domain", () => {
    const result = filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST);

    const cookieNames = result.cookies.map((c) => c.name).sort();
    expect(cookieNames).toEqual(["auth_token", "session"]);
  });

  it("drops the unrelated SSO provider's cookies entirely (AC: unrelated origin's cookies NOT present)", () => {
    const result = filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST);

    for (const cookie of result.cookies) {
      expect(cookie.domain).not.toContain("google");
    }
    expect(result.cookies.some((c) => c.value === "google-sso-sid-value")).toBe(false);
    expect(result.cookies.some((c) => c.value === "google-sso-hsid-value")).toBe(false);
  });

  it("does not match on substring alone — a domain that merely CONTAINS the allowed domain as a prefix or suffix is excluded", () => {
    const result = filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST);

    const domains = result.cookies.map((c) => c.domain);
    expect(domains).not.toContain("evil-targetsource.example");
    expect(domains).not.toContain("targetsource.example.attacker.net");
    expect(result.cookies.some((c) => c.value.includes("decoy"))).toBe(false);
  });

  it("filters origins[] the same way — only the allowlisted origin's localStorage survives", () => {
    const result = filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST);

    expect(result.origins).toHaveLength(1);
    expect(result.origins[0]?.origin).toBe("https://app.targetsource.example");
    expect(result.origins[0]?.localStorage).toEqual([{ name: "token", value: "target-local-storage-token" }]);
  });

  it("excludes ALL unrelated origins (Google SSO, decoy, and an entirely unrelated third-party site) from origins[]", () => {
    const result = filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST);

    const origins = result.origins.map((o) => o.origin);
    expect(origins).not.toContain("https://accounts.google.com");
    expect(origins).not.toContain("https://evil-targetsource.example");
    expect(origins).not.toContain("https://catalant.com");
  });

  it("returns empty cookies/origins when nothing in the file matches the allowlist", () => {
    const result = filterStorageStateToAllowlist(FIXTURE, ["totally-unrelated.example"]);

    expect(result.cookies).toEqual([]);
    expect(result.origins).toEqual([]);
  });

  it("matches a leading-dot cookie domain (per the cookie spec) the same as a bare domain", () => {
    const result = filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST);
    const sessionCookie = result.cookies.find((c) => c.name === "session");
    expect(sessionCookie?.domain).toBe(".targetsource.example"); // survived the filter unmodified
  });

  it("excludes an origin with a malformed URL rather than throwing or including it", () => {
    const malformed: StorageState = {
      cookies: [],
      origins: [{ origin: "not-a-valid-url", localStorage: [] }],
    };

    const result = filterStorageStateToAllowlist(malformed, TARGET_ALLOWLIST);

    expect(result.origins).toEqual([]);
  });
});

describe("withBrowserSession: origin-scoping is applied BEFORE the browser context is constructed", () => {
  it("passes only the filtered storageState into browser.newContext() — proven by inspecting the actual constructed-context argument", async () => {
    const storageStatePath = writeFixtureCopy();
    const { context, browser } = setUpFakeBrowserChain();

    await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    expect(browser.newContext).toHaveBeenCalledTimes(1);
    const passedArg = browser.newContext.mock.calls[0]?.[0] as { storageState: StorageState };
    const passedStorageState = passedArg.storageState;

    // The actual object handed to newContext() — not a separate, untested
    // computation — must equal filterStorageStateToAllowlist()'s output.
    expect(passedStorageState).toEqual(filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST));

    // And explicitly: no Google SSO cookie/origin ever reached newContext().
    const serialized = JSON.stringify(passedStorageState);
    expect(serialized).not.toContain("google-sso-sid-value");
    expect(serialized).not.toContain("accounts.google.com");
    expect(serialized).not.toContain("catalant.com");
    expect(serialized).not.toContain("decoy");

    void context; // unused here, present for readability of the fake-chain shape
  });

  it("tries headless first, preferring real Google Chrome — headless: true, channel: chrome (embedded-browser-and-guided-session epic)", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain();

    await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    // Tier 1 (headless) succeeds — the headed fast path/fallback never run.
    // launchServerMock (not launchMock/connectMock) carries {headless,
    // channel} now -- see launchScopedChromium()'s own doc comment for why
    // launchServer()+connect() replaced plain launch().
    expect(launchServerMock).toHaveBeenCalledTimes(1);
    expect(launchServerMock).toHaveBeenCalledWith({ headless: true, channel: "chrome" });
    // No visible window ever existed -- nothing to minimize.
    expect(minimizeChromeWindowMock).not.toHaveBeenCalled();
  });

  it("minimizes the window once headed tier 2 succeeds after headless tier 1 fails auth", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain({});

    await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        // false (tier 1, headless -- fails, triggering the headed retry this test verifies), true (tier 2, headed).
        isAuthenticated: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
      },
      async () => "ok",
    );

    expect(launchServerMock).toHaveBeenCalledTimes(2);
    expect(launchServerMock).toHaveBeenNthCalledWith(1, { headless: true, channel: "chrome" });
    expect(launchServerMock).toHaveBeenNthCalledWith(2, { headless: false, channel: "chrome" });
    expect(minimizeChromeWindowMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to bundled Chromium when real Chrome isn't installed (still headless — tier 1)", async () => {
    const storageStatePath = writeFixtureCopy();
    const { browser } = setUpFakeBrowserChain();
    launchMock.mockReset();
    launchMock.mockRejectedValueOnce(new Error("chrome channel not found"));
    launchMock.mockResolvedValueOnce(browser);

    await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    expect(launchServerMock).toHaveBeenCalledTimes(2);
    expect(launchServerMock).toHaveBeenNthCalledWith(1, { headless: true, channel: "chrome" });
    expect(launchServerMock).toHaveBeenNthCalledWith(2, { headless: true });
  });

  it("throws a source-scoped error when both real Chrome and bundled Chromium fail to launch", async () => {
    const storageStatePath = writeFixtureCopy();
    launchMock.mockReset();
    launchMock.mockRejectedValueOnce(new Error("chrome channel not found"));
    launchMock.mockRejectedValueOnce(new Error("bundled chromium also failed"));

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "ok",
      ),
    ).rejects.toThrow(/failed to launch a browser for source "test-source"/);
  });
});

describe("readStorageStateFile: encryption at rest, migrate-on-read (AC)", () => {
  it("given a legacy plaintext session-state fixture, withBrowserSession() reads it correctly (no-op decrypt, parses fine) AND the file on disk is an encrypted envelope after the call", async () => {
    const storageStatePath = writeFixtureCopy();
    expect(isEncryptedEnvelope(fs.readFileSync(storageStatePath, "utf8"))).toBe(false);
    setUpFakeBrowserChain();

    const result = await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    expect(result).toBe("ok");
    const onDiskAfter = fs.readFileSync(storageStatePath, "utf8");
    expect(isEncryptedEnvelope(onDiskAfter)).toBe(true);
    // The migrated envelope decrypts back to the exact same fixture content
    // that was on disk before migration — byte-for-byte preserved, just
    // wrapped in encryption.
    expect(JSON.parse(decrypt(onDiskAfter))).toEqual(FIXTURE);
  });

  it("given an already-encrypted session-state file, withBrowserSession() decrypts, parses, and origin-filters correctly, with no further write", async () => {
    const storageStatePath = writeEncryptedFixtureCopy();
    const before = fs.readFileSync(storageStatePath, "utf8");
    const beforeStat = fs.statSync(storageStatePath);
    setUpFakeBrowserChain();

    const result = await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    expect(result).toBe("ok");
    const after = fs.readFileSync(storageStatePath, "utf8");
    const afterStat = fs.statSync(storageStatePath);
    expect(after).toBe(before); // byte-for-byte identical — no rewrite happened
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("origin-scoping still runs correctly against DECRYPTED content from an already-encrypted file — the same filtered result reaches browser.newContext()", async () => {
    const storageStatePath = writeEncryptedFixtureCopy();
    const { browser } = setUpFakeBrowserChain();

    await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    const passedArg = browser.newContext.mock.calls[0]?.[0] as { storageState: StorageState };
    expect(passedArg.storageState).toEqual(filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST));
    const serialized = JSON.stringify(passedArg.storageState);
    expect(serialized).not.toContain("google-sso-sid-value");
    expect(serialized).not.toContain("accounts.google.com");
  });

  it("throws vault.ts's specific tamper error, with an actionable session-file-specific message, when the encrypted file has a flipped ciphertext byte", async () => {
    const storageStatePath = writeEncryptedFixtureCopy();

    // Corrupt the envelope: flip one byte inside the base64 "data" field so
    // the GCM auth tag no longer verifies (decode-flip-reencode, not a raw
    // text mutation — otherwise this would just exercise base64 decoding
    // failing, not the GCM tamper path).
    const envelope = JSON.parse(fs.readFileSync(storageStatePath, "utf8"));
    const dataBuf = Buffer.from(envelope.data, "base64");
    const first = dataBuf[0];
    if (first === undefined) throw new Error("test fixture: unexpectedly empty ciphertext");
    dataBuf[0] = first ^ 0xff;
    envelope.data = dataBuf.toString("base64");
    fs.writeFileSync(storageStatePath, JSON.stringify(envelope));

    const runOnce = () =>
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      );

    await expect(runOnce()).rejects.toThrow(VaultTamperError);
    try {
      await runOnce();
      throw new Error("expected withBrowserSession to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultTamperError);
      expect((e as Error).message).toContain(storageStatePath);
    }
    expect(launchMock).not.toHaveBeenCalled();
  });
});

describe("readStorageStateFile: key-loss detection via getOrCreateKey()'s hasAnyEncryptedFileFn (AC)", () => {
  it("given the session-state directory already holds an encrypted `*-session.json` file but the vault key is missing, reading a storageState file throws VaultKeyLostError instead of silently minting an orphan key", async () => {
    // A prior capture already encrypted on disk under the session-state
    // directory (getDefaultDataDir(), same XDG_DATA_HOME this suite already
    // isolates), then the key file going missing independently of the data
    // directory.
    getOrCreateKeyForTest();
    const sessionDir = path.join(tmpDir, "gigradar");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "other-source-session.json"), encrypt(FIXTURE_RAW));

    const keyPath = path.join(tmpKeyDir, "gigradar", "key");
    fs.unlinkSync(keyPath);

    const storageStatePath = writeFixtureCopy();

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(VaultKeyLostError);

    expect(launchMock).not.toHaveBeenCalled();
    // The legacy plaintext fixture must NOT have been rewritten either —
    // the key-loss error fires before any migrate-write is attempted.
    expect(isEncryptedEnvelope(fs.readFileSync(storageStatePath, "utf8"))).toBe(false);
  });
});

describe("withBrowserSession: cleanup on every exit path", () => {
  it("happy path — context.close() and browser.close() are each called exactly once, and the callback's return value flows through", async () => {
    const storageStatePath = writeFixtureCopy();
    const { context, browser } = setUpFakeBrowserChain();

    const result = await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async (page) => {
        await page.goto("https://app.targetsource.example/jobs/123");
        return "callback-result";
      },
    );

    expect(result).toBe("callback-result");
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("auth-failure predicate returns false — throws a specific, actionable error, the callback is never invoked, and close() is called once per storageState-snapshot tier attempted (headless tier 1, then headed tier 2 — both fail, both clean up)", async () => {
    const storageStatePath = writeFixtureCopy();
    const { context, browser } = setUpFakeBrowserChain();
    const runCallback = vi.fn();

    await expect(
      withBrowserSession(
        {
          sourceId: "gofractional",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => false,
        },
        runCallback,
      ),
    ).rejects.toThrow(/session for source "gofractional".*is invalid, and the persistent-real-chrome retry ALSO failed/);

    expect(runCallback).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(2);
  });

  it("the callback throwing for any reason still results in context.close()/browser.close() being called exactly once each (no leak, no double-close)", async () => {
    const storageStatePath = writeFixtureCopy();
    const { context, browser } = setUpFakeBrowserChain();

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => {
          throw new Error("adapter blew up mid-scrape");
        },
      ),
    ).rejects.toThrow("adapter blew up mid-scrape");

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("a thrown non-Error value from the callback still results in cleanup (defensive: close() is not conditioned on Error shape)", async () => {
    const storageStatePath = writeFixtureCopy();
    const { context, browser } = setUpFakeBrowserChain();

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "raw string throw";
        },
      ),
    ).rejects.toBe("raw string throw");

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("withBrowserSession: storageState file validation (distinct from the auth-failure error)", () => {
  it("throws a specific error naming the path when the file is missing, and never launches Chromium", async () => {
    const missingPath = path.join(tmpDir, "does-not-exist.json");

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: missingPath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(missingPath);

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("the missing-file error is distinct from the auth-failure error message", async () => {
    const missingPath = path.join(tmpDir, "does-not-exist.json");

    try {
      await withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: missingPath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      );
      throw new Error("expected withBrowserSession to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toMatch(/session expired\/invalid/);
      expect(message.toLowerCase()).toContain("no storagestate file found");
    }
  });

  it("throws a specific error naming the path when the file is not valid JSON", async () => {
    const badPath = path.join(tmpDir, "not-json.json");
    fs.writeFileSync(badPath, "{ this is not valid json");

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: badPath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(new RegExp(`${badPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*not valid JSON`));

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("throws a specific error naming the path when the file is valid JSON but the wrong shape", async () => {
    const wrongShapePath = path.join(tmpDir, "wrong-shape.json");
    fs.writeFileSync(wrongShapePath, JSON.stringify({ hello: "world" }));

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: wrongShapePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(wrongShapePath);

    expect(launchMock).not.toHaveBeenCalled();
  });
});

describe("withBrowserSession: required origin allowlist", () => {
  it("throws before ever launching Chromium when allowedOrigins is empty", async () => {
    const storageStatePath = writeFixtureCopy();

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: [],
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/empty origin allowlist/);

    expect(launchMock).not.toHaveBeenCalled();
  });
});

describe("withBrowserSession: reuses load.ts's env: string resolution for the storageState path setting", () => {
  it("resolves an env:VAR_NAME settings value to the real path before reading the file", async () => {
    const storageStatePath = writeFixtureCopy();
    process.env.GIGRADAR_TEST_STORAGE_STATE_PATH = storageStatePath;
    setUpFakeBrowserChain();

    const result = await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: "env:GIGRADAR_TEST_STORAGE_STATE_PATH",
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "resolved-ok",
    );

    expect(result).toBe("resolved-ok");
  });

  it("throws an error naming the env var (not a path-not-found error) when the referenced var is unset", async () => {
    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: "env:GIGRADAR_TEST_STORAGE_STATE_PATH_UNSET",
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/GIGRADAR_TEST_STORAGE_STATE_PATH_UNSET/);

    expect(launchMock).not.toHaveBeenCalled();
  });

  it("treats a plain literal path (no env: prefix) as a no-op passthrough, same as before this reuse existed", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain();

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath, // literal path, not "env:"-prefixed
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
  });
});

describe("checkChromiumAvailable / withBrowserSession: Chromium binary availability", () => {
  it("checkChromiumAvailable() throws an actionable error mentioning the exact install command when the binary is missing", () => {
    executablePathMock.mockReturnValue("/fake/chromium/executable");
    existsSyncSpy.mockImplementation((p: fs.PathLike) => p !== "/fake/chromium/executable");

    expect(() => checkChromiumAvailable()).toThrow(/npx playwright install chromium/);
  });

  it("checkChromiumAvailable() does not throw when the binary exists", () => {
    executablePathMock.mockReturnValue("/fake/chromium/executable");
    existsSyncSpy.mockImplementation((p: fs.PathLike) => p === "/fake/chromium/executable");

    expect(() => checkChromiumAvailable()).not.toThrow();
  });

  it("withBrowserSession surfaces the actionable install-command error (not a raw launch stack trace) and never calls chromium.launch()", async () => {
    const storageStatePath = writeFixtureCopy();
    // Only the fake Chromium executable path is "missing" — every other
    // fs.existsSync() call (including this story's vault key checks) still
    // delegates to the real filesystem, same as the beforeEach default.
    existsSyncSpy.mockImplementation((p: fs.PathLike) => {
      if (p === "/fake/chromium/executable") return false;
      return realExistsSync(p);
    });

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/npx playwright install chromium/);

    expect(launchMock).not.toHaveBeenCalled();
  });
});

describe("withBrowserSession: sessionBackend \"portunus\" (oauth-session-capture-v2 epic)", () => {
  it('reads via readSessionViaPortunus(sourceId, PORTUNUS_SESSION_ACCOUNT) instead of a local file, and still applies the origin filter before newContext()', async () => {
    readSessionViaPortunusMock.mockResolvedValue(FIXTURE);
    const { browser } = setUpFakeBrowserChain();

    await withBrowserSession(
      {
        sourceId: "test-source",
        sessionBackend: "portunus",
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    expect(readSessionViaPortunusMock).toHaveBeenCalledWith("test-source", "gigradar");
    const passedArg = browser.newContext.mock.calls[0]?.[0] as { storageState: StorageState };
    expect(passedArg.storageState).toEqual(filterStorageStateToAllowlist(FIXTURE, TARGET_ALLOWLIST));
  });

  it("never touches the local storageState file / storageStatePathSetting when the backend is portunus", async () => {
    readSessionViaPortunusMock.mockResolvedValue(FIXTURE);
    setUpFakeBrowserChain();
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    await withBrowserSession(
      {
        sourceId: "test-source",
        // Deliberately omitted -- a portunus-backed source has no local path at all.
        sessionBackend: "portunus",
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it("propagates a readSessionViaPortunus() failure without ever launching a browser", async () => {
    readSessionViaPortunusMock.mockRejectedValue(new Error("gigradar session-backend: portunus session load failed"));

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          sessionBackend: "portunus",
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/portunus session load failed/);

    expect(launchMock).not.toHaveBeenCalled();
  });

  it('throws a specific error when the backend is (or defaults to) "local" but no storageStatePathSetting was supplied', async () => {
    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/local session backend but no storageState path was supplied/);
  });
});

describe("withBrowserSession: verification-challenge detection (verification-copilot epic)", () => {
  it("throws VerificationChallengeError (carrying sourceId + url) when the page's title matches a known challenge phrase, and never calls isAuthenticated", async () => {
    const storageStatePath = writeFixtureCopy();
    const isAuthenticated = vi.fn().mockResolvedValue(true);
    setUpFakeBrowserChain({ title: vi.fn().mockResolvedValue("Just a moment... | Cloudflare") });

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(VerificationChallengeError);

    expect(isAuthenticated).not.toHaveBeenCalled();
  });

  it("the thrown error's sourceId/url fields match the call's own source/url", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain({ title: vi.fn().mockResolvedValue("Checking your browser before accessing example.com.") });

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toMatchObject({ sourceId: "test-source", url: "https://app.targetsource.example/jobs" });
  });

  it("matches on visible body text too, not just the title", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain({
      title: vi.fn().mockResolvedValue("example.com"),
      locator: vi.fn().mockReturnValue({ innerText: vi.fn().mockResolvedValue("Please verify you are human to continue.") }),
    });

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(VerificationChallengeError);
  });

  it("an ordinary page (default fake page title/body) never throws VerificationChallengeError -- isAuthenticated runs normally", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain();

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
  });

  it("still cleanly closes the context/browser (finally blocks) when this new throw path fires, on every tier it fires in (headless tier 1, then headed tier 2)", async () => {
    const storageStatePath = writeFixtureCopy();
    const { context, browser } = setUpFakeBrowserChain({ title: vi.fn().mockResolvedValue("Performing Security Verification") });

    await expect(
      withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => true,
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(VerificationChallengeError);

    expect(context.close).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(2);
  });
});

describe("withBrowserSession: no scraped page content ever appears in errors/logs", () => {
  it("the auth-failure error message never contains simulated page/DOM content, even when the page object exposes some", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain({
      content: vi.fn().mockResolvedValue("<html>SECRET AUTHENTICATED DOM CONTENT should never leak</html>"),
      textContent: vi.fn().mockResolvedValue("SECRET AUTHENTICATED DOM CONTENT should never leak"),
    });

    try {
      await withBrowserSession(
        {
          sourceId: "test-source",
          storageStatePathSetting: storageStatePath,
          allowedOrigins: TARGET_ALLOWLIST,
          url: "https://app.targetsource.example/jobs",
          isAuthenticated: async () => false,
        },
        async () => "unreachable",
      );
      throw new Error("expected withBrowserSession to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).not.toContain("SECRET AUTHENTICATED DOM CONTENT");
      expect(message).not.toContain("<html>");
    }
  });

  it("a console.error/warn spy captures zero calls containing the simulated page content across a full run", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await withBrowserSession(
      {
        sourceId: "test-source",
        storageStatePathSetting: storageStatePath,
        allowedOrigins: TARGET_ALLOWLIST,
        url: "https://app.targetsource.example/jobs",
        isAuthenticated: async () => true,
      },
      async () => "ok",
    );

    const allLoggedText = [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().join(" ");
    expect(allLoggedText).not.toContain("SECRET");
  });
});

describe("withBrowserSession: self-healing persistent-real-chrome fallback (owner's own words, 2026-09-01: fix the LONG-TERM lived session, not another one-off Capture Login)", () => {
  it("never attempts the fallback when the fast path succeeds -- spawnRealChrome() is not called", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain();

    await withBrowserSession(
      { sourceId: "test-source", storageStatePathSetting: storageStatePath, allowedOrigins: TARGET_ALLOWLIST, url: "https://app.targetsource.example/jobs", isAuthenticated: async () => true },
      async () => "ok",
    );

    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });

  it("never retries via the fallback when run() itself throws -- only an auth-related failure triggers a retry", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain();

    await expect(
      withBrowserSession(
        { sourceId: "test-source", storageStatePathSetting: storageStatePath, allowedOrigins: TARGET_ALLOWLIST, url: "https://app.targetsource.example/jobs", isAuthenticated: async () => true },
        async () => {
          throw new Error("scrape logic blew up, unrelated to auth");
        },
      ),
    ).rejects.toThrow("scrape logic blew up, unrelated to auth");

    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });

  it("when both storageState-snapshot tiers are invalid (headless, then headed), retries via spawnRealChrome()/attachToRealChrome() and succeeds using browser.contexts()[0] -- never newContext()", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain({}); // tiers 1+2: isAuthenticated will fail both times
    const { context: realChromeContext, browser: realChromeBrowser } = setUpFakeRealChromeChain();

    // false (tier 1, headless), false (tier 2, headed), true (tier 3, persistent real chrome -- the fallback this test actually verifies).
    const result = await withBrowserSession(
      { sourceId: "gofractional", storageStatePathSetting: storageStatePath, allowedOrigins: TARGET_ALLOWLIST, url: "https://app.targetsource.example/jobs", isAuthenticated: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true) },
      async () => "recovered-via-real-chrome",
    );

    expect(result).toBe("recovered-via-real-chrome");
    expect(spawnRealChromeMock).toHaveBeenCalledWith({ persistent: true });
    expect(attachToRealChromeMock).toHaveBeenCalledWith(FAKE_REAL_CHROME_HANDLE.cdpPort);
    expect(realChromeBrowser.newContext).not.toHaveBeenCalled(); // must reuse contexts()[0], never a fresh isolated context
    expect(realChromeContext.newPage).toHaveBeenCalledTimes(1);
    expect(closeRealChromeMock).toHaveBeenCalledWith(FAKE_REAL_CHROME_HANDLE);
  });

  it("on a successful fallback, refreshes the on-disk storageState snapshot (origin-scoped) so the NEXT call's fast path is self-healed", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain({});
    const freshCookie = { name: "session", value: "brand-new-cookie-from-real-chrome", domain: "app.targetsource.example", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const };
    const unrelatedCookie = { name: "sid", value: "unrelated-origin-must-be-filtered-out", domain: "accounts.google.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const };
    setUpFakeRealChromeChain({}, { cookies: [freshCookie, unrelatedCookie], origins: [] });

    // false (tier 1, headless), false (tier 2, headed), true (tier 3, the persistent-real-chrome fallback this test verifies the write-back for).
    await withBrowserSession(
      { sourceId: "gofractional", storageStatePathSetting: storageStatePath, allowedOrigins: TARGET_ALLOWLIST, url: "https://app.targetsource.example/jobs", isAuthenticated: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true) },
      async () => "ok",
    );

    const refreshed: StorageState = JSON.parse(decrypt(fs.readFileSync(storageStatePath, "utf8")));
    expect(refreshed.cookies).toHaveLength(1); // origin-scoping filter still applied to the write-back
    expect(refreshed.cookies[0]?.value).toBe("brand-new-cookie-from-real-chrome");
  });

  it("when the fallback ALSO fails for an unrelated reason, throws ONE combined, actionable error naming both failures", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain({});
    spawnRealChromeMock.mockRejectedValue(new Error("Google Chrome not found at the expected path"));

    await expect(
      withBrowserSession(
        { sourceId: "gofractional", storageStatePathSetting: storageStatePath, allowedOrigins: TARGET_ALLOWLIST, url: "https://app.targetsource.example/jobs", isAuthenticated: async () => false },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/persistent-real-chrome retry ALSO failed: Google Chrome not found.*Run Capture Login/s);
  });

  it("when the FAST path itself hit a verification challenge, re-throws that ORIGINAL VerificationChallengeError even if the fallback fails for a different reason -- runner.ts's instanceof routing must still work", async () => {
    const storageStatePath = writeFixtureCopy();
    setUpFakeBrowserChain({ title: vi.fn().mockResolvedValue("Just a moment... | Cloudflare") });
    spawnRealChromeMock.mockRejectedValue(new Error("real Chrome not available in test"));

    const isAuthenticated = vi.fn();
    await expect(
      withBrowserSession(
        { sourceId: "gofractional", storageStatePathSetting: storageStatePath, allowedOrigins: TARGET_ALLOWLIST, url: "https://app.targetsource.example/jobs", isAuthenticated },
        async () => "unreachable",
      ),
    ).rejects.toThrow(VerificationChallengeError);

    expect(isAuthenticated).not.toHaveBeenCalled(); // the fast path never even reached the caller's own predicate
  });
});
