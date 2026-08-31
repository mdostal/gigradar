// Tests for src/lib/auth/session-capture.ts. Per this story's acceptance
// criteria (see
// .pHive/epics/session-capture-ui/stories/session-capture-mechanism.yaml),
// the highest-stakes coverage here is:
//   1. globalThis-pinning genuinely SURVIVES a simulated module
//      re-evaluation (the way Next.js dev's HMR re-evaluates a module on
//      any edit to it or its import chain) — not just "the Map lives on
//      globalThis", but that a capture started via one module instance is
//      still completable via a freshly re-imported instance.
//   2. the 10-minute idle timeout actually closes the browser and evicts
//      the map entry — proven with fake timers, never a real wait.
//   3. the disconnected-listener cleans up promptly, independent of the
//      timeout.
//   4. the zero-cookie sanity check writes NOTHING.
//   5. the atomic temp-file+rename write leaves no stray temp file and no
//      partial/empty destination file on any mid-write failure.
//   6. the written file's mode is 0600.
//   7. no tracing/HAR/video/console-logging option ever reaches
//      chromium.launch()/browser.newContext().
//
// Chromium launch is fully mocked throughout — no real browser, no live
// network.
//
// Encrypted at rest (encrypted-local-storage epic, session-file-encryption
// story): every fixture/assertion below that touches the written session
// file's on-disk bytes now goes through vault.ts's encrypt()/decrypt() —
// the file is never plaintext JSON on disk. XDG_CONFIG_HOME (where the
// vault key lives — see src/lib/security/key-path.ts) gets the SAME
// per-test isolation treatment as XDG_DATA_HOME, via a separate fresh temp
// dir, so this suite never touches a real user's actual ~/.config/gigradar/key.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnRealChromeMock = vi.fn();
const attachToRealChromeMock = vi.fn();
const closeRealChromeMock = vi.fn();

vi.mock("../real-chrome.js", () => ({
  spawnRealChrome: (...args: unknown[]) => spawnRealChromeMock(...args),
  attachToRealChrome: (...args: unknown[]) => attachToRealChromeMock(...args),
  closeRealChrome: (...args: unknown[]) => closeRealChromeMock(...args),
}));

// product-review-followups epic: startCapture() now fires a real desktop
// notification when the browser opens -- mocked so this suite never shells
// out to osascript/notify-send (same reasoning every other test touching a
// notification-firing code path in this repo already documents).
vi.mock("../../notify/desktop.js", () => ({ sendDesktopNotification: vi.fn(async () => undefined) }));

const FAKE_REAL_CHROME_HANDLE = { process: { kill: vi.fn() }, cdpPort: 54732, userDataDir: "/fake/tmp/gigradar-real-chrome" };

import { SOURCE_ORIGINS } from "../../sources/origins.js";
import { VaultKeyLostError, decrypt, encrypt, isEncryptedEnvelope } from "../../security/vault.js";
import { cancelCapture, finishCapture, getCapturePage, IDLE_TIMEOUT_MS, startCapture, writeStorageStateAtomically } from "../session-capture.js";

/** finishCapture() defaults to the "local" backend -- this test suite exercises only that path (Portunus is covered separately in session-backend.test.ts). Narrows the discriminated result down to its local-path shape, or fails loudly if a test somehow ended up with the "portunus" branch. */
async function finishCaptureLocal(captureId: string): Promise<{ path: string }> {
  const result = await finishCapture(captureId);
  if (result.backend !== "local") throw new Error(`expected the local backend, got "${result.backend}"`);
  return result;
}

const SOURCE_ID = "gofractional";
const LOGIN_URL = "https://www.gofractional.com/login";

let tmpDataDir: string;
let tmpKeyDir: string;

/** A fake Page: goto() resolves by default. */
function createFakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** A fake BrowserContext: newPage()/storageState() resolve, close() is a tracked spy, pages() returns the same page newPage() resolved (mirrors real Playwright: the page created by newPage() shows up in pages() too) -- used by getCapturePage()'s tests. */
function createFakeContext(page: unknown, storageStateResult: unknown) {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    pages: vi.fn().mockReturnValue([page]),
    storageState: vi.fn().mockResolvedValue(storageStateResult),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * A fake Browser: a minimal real EventEmitter-shaped fake (on/off/
 * removeAllListeners actually track and fire handlers, so the "disconnected"
 * tests exercise the SAME listener session-capture.ts registers, not a
 * separate assertion-only mock) plus newContext()/close() spies.
 *
 * `off` is a SEPARATE tracked spy from `removeAllListeners`, deliberately —
 * session-capture.ts must call `off(event, specificListener)`, never
 * `removeAllListeners(event)` (see CaptureEntry.disconnectedListener's doc
 * comment in session-capture.ts: against REAL Playwright,
 * `removeAllListeners("disconnected")` also strips Playwright's own internal
 * "disconnected" listener that `browser.close()` depends on to ever resolve,
 * hanging it forever — a real bug this mock's earlier, looser
 * `removeAllListeners`-only shape could never have caught, since a mock has
 * no such internal listener to accidentally strip). Tests below assert
 * `off` was called and `removeAllListeners` was NOT, as a regression guard
 * against that exact bug recurring.
 */
function createFakeBrowser(context: unknown, existingContexts: unknown[] = []) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    newContext: vi.fn().mockResolvedValue(context),
    // startCapture() reuses this (persistent-profile path) instead of
    // newContext() -- see that function's own doc comment.
    contexts: vi.fn(() => existingContexts),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    removeAllListeners: vi.fn((event?: string) => {
      if (event) listeners.delete(event);
      else listeners.clear();
    }),
    emit(event: string) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
  };
}

/** Wires a fake page/context/browser together and registers them with spawnRealChromeMock/attachToRealChromeMock. */
function setUpFakeBrowserChain(storageStateResult: unknown, pageOverrides: Record<string, unknown> = {}) {
  const page = createFakePage(pageOverrides);
  const context = createFakeContext(page, storageStateResult);
  const browser = createFakeBrowser(context);
  spawnRealChromeMock.mockResolvedValue(FAKE_REAL_CHROME_HANDLE);
  attachToRealChromeMock.mockResolvedValue(browser);
  return { page, context, browser };
}

const GOOD_STORAGE_STATE = {
  cookies: [
    {
      name: "session",
      value: "abc123",
      domain: "gofractional.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
  ],
  origins: [{ origin: "https://www.gofractional.com", localStorage: [{ name: "token", value: "xyz" }] }],
};

const EMPTY_STORAGE_STATE = { cookies: [], origins: [] };

beforeEach(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-session-capture-test-"));
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-session-capture-test-key-"));
  process.env.XDG_DATA_HOME = tmpDataDir;
  process.env.XDG_CONFIG_HOME = tmpKeyDir;
  spawnRealChromeMock.mockReset();
  attachToRealChromeMock.mockReset();
  closeRealChromeMock.mockReset();
  vi.mocked((await import("../../notify/desktop.js")).sendDesktopNotification).mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  // Drain any capture left in the globalThis-pinned map between tests so
  // state doesn't leak across test cases in this same process — clearing
  // the EXISTING Map in place (never reassigning the globalThis property to
  // a new Map or to undefined). This module's top-level `captures` binding
  // is read from `globalThis` exactly once, at module-evaluation time; a
  // module already imported (e.g. this test file's own top-level static
  // import of startCapture/finishCapture/cancelCapture) keeps that original
  // Map reference for its whole lifetime. Reassigning the globalThis
  // property here — rather than clearing the Map it already points at —
  // would silently desync that reference from later dynamic re-imports,
  // which is exactly the class of bug the globalThis-pinning tests below
  // exist to catch; doing it in cleanup would produce false failures there,
  // not a real one.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only read of the same deliberate globalThis cast the module itself uses.
  const map = (globalThis as any).__gigradarCaptures as Map<string, { timeoutHandle: ReturnType<typeof setTimeout> }> | undefined;
  if (map) {
    for (const entry of map.values()) clearTimeout(entry.timeoutHandle);
    map.clear();
  }
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(tmpKeyDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
});

function sessionFilePath(sourceId: string): string {
  return path.join(tmpDataDir, "gigradar", `${sourceId}-session.json`);
}

/** Reads and decrypts an on-disk session file written by writeStorageStateAtomically()/finishCapture(). Throws if the raw bytes aren't a valid encrypted envelope — callers that need to assert on that should check isEncryptedEnvelope() directly first. */
function readAndDecryptSessionFile(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(decrypt(raw));
}

/** Ensures the vault key exists under the current (test-isolated) XDG_CONFIG_HOME, for fixtures that need to encrypt() ahead of exercising key-loss detection. Mirrors config/__tests__/load.test.ts's own getOrCreateKeyForTest() helper. */
function getOrCreateKeyForTest(): void {
  const keyPath = path.join(tmpKeyDir, "gigradar", "key");
  if (fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
}

describe("startCapture / finishCapture: happy path", () => {
  it("captures a fresh session and writes the allowlist-filtered result atomically to <sourceId>-session.json", async () => {
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);
    expect(typeof captureId).toBe("string");
    expect(captureId.length).toBeGreaterThan(0);

    const { path: written } = await finishCaptureLocal(captureId);

    expect(written).toBe(sessionFilePath(SOURCE_ID));
    expect(fs.existsSync(written)).toBe(true);

    // Encrypted at rest (AC): the raw bytes on disk are an encrypted vault
    // envelope, never plaintext storageState JSON.
    const rawOnDisk = fs.readFileSync(written, "utf8");
    expect(isEncryptedEnvelope(rawOnDisk)).toBe(true);
    expect(rawOnDisk).not.toContain("gofractional.com");
    expect(rawOnDisk).not.toContain("abc123");

    const onDisk = readAndDecryptSessionFile(written) as { cookies: Array<{ name: string }> };
    expect(onDisk.cookies).toHaveLength(1);
    expect(onDisk.cookies[0]?.name).toBe("session");

    // The written file's mode is still 0600 even though its content is now
    // an encrypted envelope rather than plaintext.
    expect(fs.statSync(written).mode & 0o777).toBe(0o600);

    // Regression guard for a real bug found against ACTUAL Playwright (not
    // catchable by this mock alone): finishCapture() must remove ONLY its
    // own "disconnected" listener via off(), never removeAllListeners() —
    // see CaptureEntry.disconnectedListener's doc comment in
    // session-capture.ts for why removeAllListeners() there hangs
    // browser.close() forever against a real Browser.
    expect(browser.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(browser.removeAllListeners).not.toHaveBeenCalled();

    // The real, independently-spawned Chrome process + its temp
    // --user-data-dir are torn down alongside the Playwright CDP connection
    // — see real-chrome.ts's closeRealChrome().
    expect(closeRealChromeMock).toHaveBeenCalledWith(FAKE_REAL_CHROME_HANDLE);
  });

  it("launches a FRESH context — no storageState passed into newContext() — when the profile is NOT persistent", async () => {
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    await startCapture(SOURCE_ID, LOGIN_URL);

    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(browser.newContext).toHaveBeenCalledWith();
  });

  it("reuses the persistent profile's own EXISTING default context instead of a fresh isolated one — this is the actual fix for Google/SSO sign-in being discarded on every capture (live-verified 2026-08-31)", async () => {
    const page = createFakePage({});
    const existingContext = createFakeContext(page, GOOD_STORAGE_STATE);
    const browser = createFakeBrowser(/* newContext() result, should never be used */ "unused", [existingContext]);
    spawnRealChromeMock.mockResolvedValue({ ...FAKE_REAL_CHROME_HANDLE, persistent: true });
    attachToRealChromeMock.mockResolvedValue(browser);

    await startCapture(SOURCE_ID, LOGIN_URL);

    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browser.contexts).toHaveBeenCalled();
    // The page/navigation happened on the REUSED context, not a fresh one.
    expect(page.goto).toHaveBeenCalledWith(LOGIN_URL);
  });

  it("falls back to newContext() when persistent but Chrome unexpectedly has no existing context yet", async () => {
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    spawnRealChromeMock.mockResolvedValue({ ...FAKE_REAL_CHROME_HANDLE, persistent: true });
    // createFakeBrowser() defaults existingContexts to [] -- contexts()[0] is undefined.

    await startCapture(SOURCE_ID, LOGIN_URL);

    expect(browser.newContext).toHaveBeenCalledTimes(1);
  });

  it("navigates the page to loginUrl", async () => {
    const { page } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    await startCapture(SOURCE_ID, LOGIN_URL);

    expect(page.goto).toHaveBeenCalledWith(LOGIN_URL);
  });

  it("fires a desktop notification once the browser window is genuinely open (product-review-followups epic)", async () => {
    setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { sendDesktopNotification } = await import("../../notify/desktop.js");

    await startCapture(SOURCE_ID, LOGIN_URL);

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(SOURCE_ID) }));
  });

  it("propagates a spawnRealChrome() failure (e.g. real Chrome not installed) and never attempts to attach", async () => {
    spawnRealChromeMock.mockRejectedValue(new Error("gigradar real-chrome: Google Chrome not found"));

    await expect(startCapture(SOURCE_ID, LOGIN_URL)).rejects.toThrow(/Google Chrome not found/);
    expect(attachToRealChromeMock).not.toHaveBeenCalled();
  });

  it("closes the spawned real Chrome if attaching over CDP fails", async () => {
    spawnRealChromeMock.mockResolvedValue(FAKE_REAL_CHROME_HANDLE);
    attachToRealChromeMock.mockRejectedValue(new Error("simulated connectOverCDP failure"));

    await expect(startCapture(SOURCE_ID, LOGIN_URL)).rejects.toThrow(/failed to attach to the spawned Chrome/);
    expect(closeRealChromeMock).toHaveBeenCalledWith(FAKE_REAL_CHROME_HANDLE);
  });
});

describe("getCapturePage: used by capture-guidance.ts's checkCaptureReadiness() (oauth-session-capture-v2 epic)", () => {
  it("returns the capture's current live page", async () => {
    const { page } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    expect(getCapturePage(captureId)).toBe(page);
  });

  it("throws a specific 'not found or already expired' error for an unknown captureId, same wording finishCapture()/cancelCapture() use", () => {
    expect(() => getCapturePage("not-a-real-capture-id")).toThrow(/not found or already expired/);
  });

  it("never touches the idle timeout, disconnect listener, or map entry -- purely a read", async () => {
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    getCapturePage(captureId);
    getCapturePage(captureId);

    expect(browser.off).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    // The capture is still live afterward -- finishCapture() still finds it.
    await expect(finishCaptureLocal(captureId)).resolves.toBeDefined();
  });
});

describe("globalThis-pinning: survives a simulated module re-evaluation (the HMR scenario)", () => {
  it("a capture started via the 'old' module reference is still findable/completable via a freshly re-imported 'new' reference", async () => {
    setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    // "Old" module instance starts the capture.
    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    // Simulate Next.js dev's HMR re-evaluating this module (and everything
    // it imports) by clearing vitest's module registry and re-importing
    // fresh. A plain `const captures = new Map()` at module scope would be
    // thrown away and recreated empty by this — proving the globalThis
    // pin is what's actually keeping the entry alive, not an artifact of
    // reusing the same JS module instance.
    vi.resetModules();
    const freshModule = await import("../session-capture.js");
    expect(freshModule.finishCapture).not.toBe(finishCapture); // genuinely a distinct module instance

    // "New" module instance completes the SAME capture id.
    const freshResult = await freshModule.finishCapture(captureId);
    if (freshResult.backend !== "local") throw new Error(`expected the local backend, got "${freshResult.backend}"`);
    const written = freshResult.path;

    expect(fs.existsSync(written)).toBe(true);
  });
});

describe("idle timeout: closes the browser and evicts the entry after IDLE_TIMEOUT_MS, proven with fake timers", () => {
  it("browser.close() is actually called, and a subsequent finishCapture() throws 'not found' — not just that a timer was scheduled", async () => {
    vi.useFakeTimers();
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);
    expect(browser.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    expect(browser.close).toHaveBeenCalledTimes(1);
    await expect(finishCapture(captureId)).rejects.toThrow(/not found or already expired/);

    // Same regression guard as finishCapture/cancelCapture above: the idle
    // timeout's own cleanup must also use off(), never removeAllListeners().
    expect(browser.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(browser.removeAllListeners).not.toHaveBeenCalled();
  });

  it("does NOT fire early — a capture finished just before the timeout is unaffected by it firing afterward", async () => {
    vi.useFakeTimers();
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);
    await finishCapture(captureId);
    expect(browser.close).toHaveBeenCalledTimes(1); // closed by finishCapture(), not yet by any timeout

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    // Still exactly once — the timeout found no entry left to act on.
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("disconnected listener: cleans up promptly, independent of the idle timeout", () => {
  it("emitting 'disconnected' on the mocked browser removes the capture entry immediately", async () => {
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    browser.emit("disconnected");

    await expect(finishCapture(captureId)).rejects.toThrow(/not found or already expired/);
  });
});

describe("finishCapture: zero-cookie sanity check", () => {
  it("throws a specific error and writes NOTHING when the filtered result has zero cookies for the source's own origin", async () => {
    setUpFakeBrowserChain(EMPTY_STORAGE_STATE);

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    await expect(finishCapture(captureId)).rejects.toThrow(
      /capture produced no usable session for "gofractional".*login may not have completed/,
    );

    expect(fs.existsSync(sessionFilePath(SOURCE_ID))).toBe(false);
    // No stray file of any kind landed in the destination directory either.
    const destDir = path.dirname(sessionFilePath(SOURCE_ID));
    expect(fs.existsSync(destDir) ? fs.readdirSync(destDir) : []).toEqual([]);
  });

  it("also throws (writing nothing) when the storage state has cookies, but none survive the source's origin allowlist", async () => {
    setUpFakeBrowserChain({
      cookies: [
        {
          name: "unrelated",
          value: "v",
          domain: "totally-unrelated.example",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    });

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    await expect(finishCapture(captureId)).rejects.toThrow(/capture produced no usable session/);
    expect(fs.existsSync(sessionFilePath(SOURCE_ID))).toBe(false);
  });
});

describe("finishCapture: atomic write on error leaves no partial/empty file and no stray temp file", () => {
  it("storageState() throwing mid-finish leaves nothing at the destination path", async () => {
    const { context } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    context.storageState.mockRejectedValue(new Error("simulated storageState() failure"));

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    await expect(finishCapture(captureId)).rejects.toThrow(/simulated storageState\(\) failure/);

    expect(fs.existsSync(sessionFilePath(SOURCE_ID))).toBe(false);
  });

  it("a failure during the rename step leaves no stray temp file behind (temp-file+rename pattern verified directly)", async () => {
    setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated rename failure");
    });

    await expect(finishCapture(captureId)).rejects.toThrow(/simulated rename failure/);
    renameSpy.mockRestore();

    const destDir = path.dirname(sessionFilePath(SOURCE_ID));
    expect(fs.existsSync(sessionFilePath(SOURCE_ID))).toBe(false);
    // No leftover `.tmp-*` file (or anything else) sitting in the directory.
    expect(fs.existsSync(destDir) ? fs.readdirSync(destDir) : []).toEqual([]);
  });

  it("the browser is still closed even when finishCapture() throws (cleanup doesn't depend on success)", async () => {
    const { browser, context } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    context.storageState.mockRejectedValue(new Error("boom"));

    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);
    await expect(finishCapture(captureId)).rejects.toThrow("boom");

    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("finishCapture: file permissions", () => {
  it("the written file's mode is 0600", async () => {
    setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    const { path: written } = await finishCaptureLocal(captureId);

    const mode = fs.statSync(written).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("finishCapture: not-found handling", () => {
  it("throws a specific error for an id that was never issued", async () => {
    await expect(finishCapture("not-a-real-capture-id")).rejects.toThrow(/not found or already expired/);
  });
});

describe("cancelCapture", () => {
  it("closes the browser and writes nothing", async () => {
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    await cancelCapture(captureId);

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sessionFilePath(SOURCE_ID))).toBe(false);
    await expect(finishCapture(captureId)).rejects.toThrow(/not found or already expired/);

    // Same regression guard as the finishCapture happy path above — see
    // that test's comment.
    expect(browser.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(browser.removeAllListeners).not.toHaveBeenCalled();
  });

  it("is idempotent — cancelling an id that's already gone (e.g. raced with disconnect) does not throw", async () => {
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    browser.emit("disconnected");

    await expect(cancelCapture(captureId)).resolves.toBeUndefined();
  });

  it("clears the idle timeout — a cancelled capture's timeout never later calls close() a second time", async () => {
    vi.useFakeTimers();
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    await cancelCapture(captureId);
    expect(browser.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    expect(browser.close).toHaveBeenCalledTimes(1); // still just the one call from cancelCapture()
  });
});

describe("no debug capture, ever: launch()/newContext() calls carry no tracing/HAR/video/console-logging options", () => {
  it("acquires the browser via spawnRealChrome()/attachToRealChrome() — never playwright.chromium.launch() directly", async () => {
    setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    await startCapture(SOURCE_ID, LOGIN_URL);

    expect(spawnRealChromeMock).toHaveBeenCalledTimes(1);
    expect(spawnRealChromeMock).toHaveBeenCalledWith();
    expect(attachToRealChromeMock).toHaveBeenCalledTimes(1);
    expect(attachToRealChromeMock).toHaveBeenCalledWith(FAKE_REAL_CHROME_HANDLE.cdpPort);
  });

  it("browser.newContext() is called with no options at all — no recordHar/recordVideo/tracing-related keys", async () => {
    const { browser } = setUpFakeBrowserChain(GOOD_STORAGE_STATE);

    await startCapture(SOURCE_ID, LOGIN_URL);

    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(browser.newContext.mock.calls[0]).toEqual([]);
  });

  it("source-inspection: the implementation file's ACTUAL CODE (comments stripped) contains no tracing/HAR/video/console-network-logging call", async () => {
    const source = fs.readFileSync(new URL("../session-capture.ts", import.meta.url), "utf8");
    // Strip comments before scanning — this file's own header/JSDoc
    // deliberately NAMES these forbidden options/calls in prose (documenting
    // the constraint), which would otherwise false-positive a substring
    // check. Stripping comments first means this test asserts what the
    // acceptance criterion actually cares about: the CODE, not the prose
    // describing the code.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments, including /** JSDoc */
      .replace(/^\s*\/\/.*$/gm, ""); // line comments

    for (const forbidden of [
      "recordHar",
      "recordVideo",
      "tracing.start",
      "tracing.startChunk",
      "page.on(",
      "context.on(",
      "console.log",
    ]) {
      expect(codeOnly).not.toContain(forbidden);
    }
  });
});

describe("writeStorageStateAtomically: exported and reused (not duplicated) by browser-session.ts", () => {
  it("is exported from this module as a function", () => {
    expect(typeof writeStorageStateAtomically).toBe("function");
  });

  it("actually encrypts what it writes: given plaintext-shaped input, the on-disk bytes are an encrypted envelope, not that input's plaintext JSON", () => {
    const destPath = path.join(tmpDataDir, "gigradar", "standalone-helper-session.json");

    writeStorageStateAtomically(destPath, {
      cookies: [
        {
          name: "direct-call",
          value: "direct-value",
          domain: "example.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });

    const raw = fs.readFileSync(destPath, "utf8");
    expect(isEncryptedEnvelope(raw)).toBe(true);
    expect(raw).not.toContain("direct-value");
    const decrypted = JSON.parse(decrypt(raw)) as { cookies: Array<{ value: string }> };
    expect(decrypted.cookies[0]?.value).toBe("direct-value");
  });

  it("browser-session.ts imports it from this module rather than reimplementing atomic-write logic (source-inspection, guards against silent re-duplication)", () => {
    const browserSessionSource = fs.readFileSync(new URL("../browser-session.ts", import.meta.url), "utf8");
    expect(browserSessionSource).toMatch(
      /import\s*\{[^}]*writeStorageStateAtomically[^}]*\}\s*from\s*["']\.\/session-capture\.js["']/,
    );
    // And browser-session.ts must not define its own second copy of the
    // helper under the same or a suspiciously similar name.
    expect(browserSessionSource).not.toMatch(/function\s+writeStorageStateAtomically/);
  });
});

describe("key-loss detection: session-directory scan feeds getOrCreateKey()'s hasAnyEncryptedFileFn (AC)", () => {
  it("given the session directory already holds an encrypted session file but the vault key is missing, a NEW finishCapture() throws VaultKeyLostError rather than silently minting an orphan key", async () => {
    // Simulate a PRIOR capture (a different source) already encrypted on
    // disk, then the key file going missing independently of the data
    // directory (e.g. XDG_CONFIG_HOME wiped/rotated separately).
    getOrCreateKeyForTest();
    const sessionDir = path.join(tmpDataDir, "gigradar");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "other-source-session.json"), encrypt(JSON.stringify(EMPTY_STORAGE_STATE)));

    const keyPath = path.join(tmpKeyDir, "gigradar", "key");
    fs.unlinkSync(keyPath);

    setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { captureId } = await startCapture(SOURCE_ID, LOGIN_URL);

    await expect(finishCapture(captureId)).rejects.toThrow(VaultKeyLostError);

    // Nothing was written for the NEW capture either — the key-loss error
    // fires before any write, never leaving a partial/orphan-keyed file.
    expect(fs.existsSync(sessionFilePath(SOURCE_ID))).toBe(false);
  });
});

describe("finishCapture: unregistered source", () => {
  it("throws a specific error (writing nothing) if SOURCE_ORIGINS has no entry for the capture's sourceId", async () => {
    setUpFakeBrowserChain(GOOD_STORAGE_STATE);
    const { captureId } = await startCapture("not-a-registered-source", LOGIN_URL);

    expect(SOURCE_ORIGINS["not-a-registered-source"]).toBeUndefined();

    await expect(finishCapture(captureId)).rejects.toThrow(/no origin allowlist registered/);
  });
});
