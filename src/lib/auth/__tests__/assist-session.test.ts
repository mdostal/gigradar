// Tests for src/lib/auth/assist-session.ts. Highest-stakes coverage:
//   1. one session per sourceId at a time -- a second start for an already-
//      active source is rejected before ever launching a second browser.
//   2. getAssistSessionPage() refreshes the idle-timeout clock -- a session
//      under active use never times out mid-interaction.
//   3. the idle timeout genuinely closes the browser and evicts the map
//      entry -- proven with fake timers, never a real wait (mirrors
//      session-capture.test.ts's own idle-timeout coverage).
//   4. endAssistSession() is idempotent -- a second call for an already-
//      ended session is a silent no-op, never a throw.
//   5. missing SOURCE_ORIGINS/SOURCE_PROFILE_URLS entries throw BEFORE any
//      browser is launched.
// Chromium launch is fully mocked throughout -- no real browser, no live
// network.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnRealChromeMock = vi.fn();
const attachToRealChromeMock = vi.fn();
const closeRealChromeMock = vi.fn();
// embedded-browser-and-guided-session epic: startAssistSession() now
// positions the window (guided/full-auto) via a real, best-effort osascript
// call -- mocked to a resolved no-op so this suite never shells out.
const positionChromeWindowSideBySideMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("../real-chrome.js", () => ({
  spawnRealChrome: (...args: unknown[]) => spawnRealChromeMock(...args),
  attachToRealChrome: (...args: unknown[]) => attachToRealChromeMock(...args),
  closeRealChrome: (...args: unknown[]) => closeRealChromeMock(...args),
  positionChromeWindowSideBySide: (...args: unknown[]) => positionChromeWindowSideBySideMock(...args),
}));

// product-review-followups epic: startAssistSession() now fires a real
// desktop notification when the browser opens (for manual/guided modes) --
// mocked so this suite never shells out to osascript/notify-send.
vi.mock("../../notify/desktop.js", () => ({ sendDesktopNotification: vi.fn(async () => undefined) }));

const readSessionViaPortunusMock = vi.fn();
vi.mock("../session-backend.js", () => ({
  PORTUNUS_SESSION_ACCOUNT: "gigradar",
  readSessionViaPortunus: (...args: unknown[]) => readSessionViaPortunusMock(...args),
}));

const FAKE_REAL_CHROME_HANDLE = { process: { kill: vi.fn() }, cdpPort: 54732, userDataDir: "/fake/tmp/gigradar-real-chrome" };

import {
  endAssistSession,
  getAssistSessionInfo,
  getAssistSessionPage,
  IDLE_TIMEOUT_MS,
  startAssistSession,
} from "../assist-session.js";
import { encrypt } from "../../security/vault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "multi-origin-storage-state.json");
const FIXTURE_RAW = fs.readFileSync(FIXTURE_PATH, "utf8");

// A real registered browser-session-auth source (SOURCE_ORIGINS/
// SOURCE_PROFILE_URLS both have entries) -- see src/lib/sources/origins.ts.
const SOURCE_ID = "gofractional";

let tmpDataDir: string;
let tmpKeyDir: string;

function createFakePage() {
  return { goto: vi.fn().mockResolvedValue(undefined) };
}

function createFakeContext(page: unknown) {
  return { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
}

/** Same real-EventEmitter-shaped fake browser session-capture.test.ts uses, for the same reason: the "disconnected" listener tests exercise the actual listener assist-session.ts registers. */
function createFakeBrowser(context: unknown) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    removeAllListeners: vi.fn(),
    emit(event: string) {
      for (const handler of listeners.get(event) ?? []) handler();
    },
  };
}

function setUpFakeBrowserChain() {
  const page = createFakePage();
  const context = createFakeContext(page);
  const browser = createFakeBrowser(context);
  spawnRealChromeMock.mockResolvedValue(FAKE_REAL_CHROME_HANDLE);
  attachToRealChromeMock.mockResolvedValue(browser);
  return { page, context, browser };
}

function getOrCreateKeyForTest(): void {
  const keyPath = path.join(tmpKeyDir, "gigradar", "key");
  if (fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
}

/** Writes an already-encrypted copy of the multi-origin fixture (readStorageStateFile() accepts it as-is; the fixture's own domains don't match gofractional.com, which is fine -- these tests exercise session lifecycle plumbing, not origin-filtering itself, already covered by browser-session.test.ts). */
function writeStorageStateFixture(): string {
  getOrCreateKeyForTest();
  const dest = path.join(tmpDataDir, "storage-state.json");
  fs.writeFileSync(dest, encrypt(FIXTURE_RAW));
  return dest;
}

beforeEach(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-assist-session-test-"));
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-assist-session-test-key-"));
  process.env.XDG_DATA_HOME = tmpDataDir;
  process.env.XDG_CONFIG_HOME = tmpKeyDir;
  spawnRealChromeMock.mockReset();
  attachToRealChromeMock.mockReset();
  closeRealChromeMock.mockReset();
  readSessionViaPortunusMock.mockReset();
  positionChromeWindowSideBySideMock.mockClear();
  vi.mocked((await import("../../notify/desktop.js")).sendDesktopNotification).mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  // Drain any session left in the globalThis-pinned map between tests --
  // same cleanup discipline session-capture.test.ts uses (clear the
  // EXISTING Map in place, never reassign the globalThis property).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only read of the same deliberate globalThis cast the module itself uses.
  const map = (globalThis as any).__gigradarAssistSessions as Map<string, { timeoutHandle: ReturnType<typeof setTimeout> }> | undefined;
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

describe("startAssistSession / getAssistSessionPage / endAssistSession: happy path", () => {
  it("starts a session, returns a sessionId, and getAssistSessionPage() returns the live page", async () => {
    const { browser, page } = setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    const info = await startAssistSession(SOURCE_ID, "manual", storageStatePath);
    expect(typeof info.sessionId).toBe("string");
    expect(info.sessionId.length).toBeGreaterThan(0);
    expect(info.sourceId).toBe(SOURCE_ID);
    expect(info.mode).toBe("manual");

    expect(getAssistSessionPage(info.sessionId)).toBe(page);
    expect(getAssistSessionInfo(info.sessionId)).toEqual(info);

    await endAssistSession(info.sessionId);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.off).toHaveBeenCalledWith("disconnected", expect.any(Function));

    // The real, independently-spawned Chrome process + its temp
    // --user-data-dir are torn down alongside the Playwright CDP connection
    // -- see real-chrome.ts's closeRealChrome().
    expect(spawnRealChromeMock).toHaveBeenCalledWith();
    expect(attachToRealChromeMock).toHaveBeenCalledWith(FAKE_REAL_CHROME_HANDLE.cdpPort);
    expect(closeRealChromeMock).toHaveBeenCalledWith(FAKE_REAL_CHROME_HANDLE);
  });

  it("navigates to the source's registered SOURCE_PROFILE_URLS entry", async () => {
    const { page } = setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    await startAssistSession(SOURCE_ID, "manual", storageStatePath);

    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining("gofractional.com"));
  });

  it("fires a desktop notification for manual/guided modes (product-review-followups epic)", async () => {
    setUpFakeBrowserChain();
    const { sendDesktopNotification } = await import("../../notify/desktop.js");

    await startAssistSession(SOURCE_ID, "guided", writeStorageStateFixture());

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(SOURCE_ID) }));
  });

  it("does NOT fire a desktop notification for full-auto mode -- no human is expected to look at the window", async () => {
    setUpFakeBrowserChain();
    const { sendDesktopNotification } = await import("../../notify/desktop.js");

    await startAssistSession(SOURCE_ID, "full-auto", writeStorageStateFixture());

    expect(sendDesktopNotification).not.toHaveBeenCalled();
  });
});

describe("window positioning (embedded-browser-and-guided-session epic)", () => {
  it("positions the window side-by-side for guided/full-auto -- work happens through the embedded pane, not the native window", async () => {
    setUpFakeBrowserChain();

    await startAssistSession(SOURCE_ID, "guided", writeStorageStateFixture());

    expect(positionChromeWindowSideBySideMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT reposition the window for manual mode -- 'a real browser window is open on your desktop, use it directly' is the intended UX there", async () => {
    setUpFakeBrowserChain();

    await startAssistSession(SOURCE_ID, "manual", writeStorageStateFixture());

    expect(positionChromeWindowSideBySideMock).not.toHaveBeenCalled();
  });
});

describe("one session per sourceId", () => {
  it("rejects a second start for a sourceId that already has a live session, without launching a second browser", async () => {
    setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    await startAssistSession(SOURCE_ID, "manual", storageStatePath);
    spawnRealChromeMock.mockClear();

    await expect(startAssistSession(SOURCE_ID, "manual", storageStatePath)).rejects.toThrow(
      /already active for source/,
    );
    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });

  it("allows starting a new session for the same sourceId after the first one ends", async () => {
    setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    const first = await startAssistSession(SOURCE_ID, "manual", storageStatePath);
    await endAssistSession(first.sessionId);

    setUpFakeBrowserChain();
    const second = await startAssistSession(SOURCE_ID, "manual", storageStatePath);
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});

describe("unknown/expired session handling", () => {
  it("getAssistSessionPage() throws a specific error for an unknown sessionId", () => {
    expect(() => getAssistSessionPage("not-a-real-session-id")).toThrow(/not found or expired/);
  });

  it("getAssistSessionInfo() returns undefined for an unknown sessionId", () => {
    expect(getAssistSessionInfo("not-a-real-session-id")).toBeUndefined();
  });

  it("endAssistSession() is idempotent -- a second call for an already-ended session is a silent no-op", async () => {
    const { browser } = setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    const info = await startAssistSession(SOURCE_ID, "manual", storageStatePath);
    await endAssistSession(info.sessionId);
    expect(browser.close).toHaveBeenCalledTimes(1);

    await expect(endAssistSession(info.sessionId)).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1); // not called again
  });
});

describe("startAssistSession: sessionBackend \"portunus\" (oauth-session-capture-v2 epic)", () => {
  it("reads via readSessionViaPortunus(sourceId, PORTUNUS_SESSION_ACCOUNT) instead of the local file, and never requires a storageStatePathSetting", async () => {
    const { context } = setUpFakeBrowserChain();
    readSessionViaPortunusMock.mockResolvedValue({
      cookies: [{ name: "session", value: "v", domain: "gofractional.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const }],
      origins: [],
    });

    const info = await startAssistSession(SOURCE_ID, "manual", undefined, "portunus");

    expect(readSessionViaPortunusMock).toHaveBeenCalledWith(SOURCE_ID, "gigradar");
    expect(info.sourceId).toBe(SOURCE_ID);
    expect(context.newPage).toHaveBeenCalledTimes(1);
  });

  it("propagates a readSessionViaPortunus() failure without ever spawning real Chrome", async () => {
    readSessionViaPortunusMock.mockRejectedValue(new Error("gigradar session-backend: portunus session load failed"));

    await expect(startAssistSession(SOURCE_ID, "manual", undefined, "portunus")).rejects.toThrow(/portunus session load failed/);
    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });

  it('throws a specific error when the backend is (or defaults to) "local" but no storageStatePathSetting was supplied', async () => {
    await expect(startAssistSession(SOURCE_ID, "manual")).rejects.toThrow(
      /local session backend but no storageState path was supplied/,
    );
    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });
});

describe("registry gaps throw before launching a browser", () => {
  it("throws for a sourceId with no SOURCE_ORIGINS/SOURCE_PROFILE_URLS entry", async () => {
    const storageStatePath = writeStorageStateFixture();
    await expect(startAssistSession("not-a-real-source", "manual", storageStatePath)).rejects.toThrow(
      /no origin allowlist registered/,
    );
    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });
});

describe("config-driven fallback for custom sources (settings.allowedOrigins/settings.profileUrl)", () => {
  const CUSTOM_SOURCE_ID = "catalant";

  it("succeeds for a source with no registry entry when cfg.settings supplies allowedOrigins + profileUrl", async () => {
    setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();
    const cfg = {
      id: CUSTOM_SOURCE_ID,
      enabled: true,
      kind: "custom-llm" as const,
      settings: { allowedOrigins: ["gocatalant.com"], profileUrl: "https://app.gocatalant.com/profile" },
    };

    const info = await startAssistSession(CUSTOM_SOURCE_ID, "manual", storageStatePath, "local", cfg);

    expect(info.sourceId).toBe(CUSTOM_SOURCE_ID);
    expect(spawnRealChromeMock).toHaveBeenCalledTimes(1);
  });

  it("still throws the actionable error when cfg.settings has neither an allowlist nor a registry entry", async () => {
    const storageStatePath = writeStorageStateFixture();
    const cfg = { id: CUSTOM_SOURCE_ID, enabled: true, kind: "custom-llm" as const, settings: {} };

    await expect(startAssistSession(CUSTOM_SOURCE_ID, "manual", storageStatePath, "local", cfg)).rejects.toThrow(
      /no origin allowlist registered.*settings\.allowedOrigins/,
    );
    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });

  it("throws the actionable profileUrl error when only allowedOrigins is set", async () => {
    const storageStatePath = writeStorageStateFixture();
    const cfg = {
      id: CUSTOM_SOURCE_ID,
      enabled: true,
      kind: "custom-llm" as const,
      settings: { allowedOrigins: ["gocatalant.com"] },
    };

    await expect(startAssistSession(CUSTOM_SOURCE_ID, "manual", storageStatePath, "local", cfg)).rejects.toThrow(
      /no profile-edit URL registered.*settings\.profileUrl/,
    );
    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });
});

describe("idle timeout", () => {
  it("closes the browser and evicts the session after IDLE_TIMEOUT_MS of no activity", async () => {
    vi.useFakeTimers();
    const { browser } = setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    const info = await startAssistSession(SOURCE_ID, "manual", storageStatePath);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(getAssistSessionInfo(info.sessionId)).toBeUndefined();
  });

  it("getAssistSessionPage() refreshes the idle-timeout clock -- an actively-used session does not time out", async () => {
    vi.useFakeTimers();
    const { browser } = setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    const info = await startAssistSession(SOURCE_ID, "manual", storageStatePath);

    // Halfway through the idle window, touch the session -- this must reset
    // the clock, so advancing another (IDLE_TIMEOUT_MS - a bit) must NOT
    // time it out.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS / 2);
    getAssistSessionPage(info.sessionId);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 2000);

    expect(browser.close).not.toHaveBeenCalled();

    // Now let the (refreshed) timeout actually fire.
    await vi.advanceTimersByTimeAsync(3000);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("globalThis-pinning survives module re-evaluation", () => {
  it("a session started via one module instance is still reachable via a freshly re-imported instance", async () => {
    setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    const info = await startAssistSession(SOURCE_ID, "manual", storageStatePath);

    vi.resetModules();
    const reImported = await import("../assist-session.js");

    expect(reImported.getAssistSessionInfo(info.sessionId)).toEqual(info);
  });
});
