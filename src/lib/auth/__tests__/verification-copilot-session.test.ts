// Tests for src/lib/auth/verification-copilot-session.ts. Same coverage
// shape as assist-session.test.ts (the closest sibling: real-chrome.ts +
// browser-session.ts session lifecycle, globalThis-pinned map, idle
// timeout, one-session-per-sourceId) --
//   1. openCopilotSession() spawns a real Chrome, loads the source's
//      already-captured storageState scoped to its origin allowlist, and
//      navigates to the blocked URL.
//   2. one session per sourceId at a time.
//   3. getCopilotPage() refreshes the idle-timeout clock.
//   4. the idle timeout genuinely closes the browser and evicts the map
//      entry (fake timers, never a real wait).
//   5. closeCopilotSession() is idempotent.
//   6. registry gaps (no SOURCE_ORIGINS entry) throw before ever spawning
//      a browser.
// Chromium launch is fully mocked throughout -- no real browser, no live
// network.
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

// product-review-followups epic: openCopilotSession() now fires a real
// desktop notification when the browser opens -- mocked so this suite
// never shells out to osascript/notify-send.
vi.mock("../../notify/desktop.js", () => ({ sendDesktopNotification: vi.fn(async () => undefined) }));

const readStorageStateFileMock = vi.fn();
const filterStorageStateToAllowlistMock = vi.fn();
vi.mock("../browser-session.js", () => ({
  readStorageStateFile: (...args: unknown[]) => readStorageStateFileMock(...args),
  filterStorageStateToAllowlist: (...args: unknown[]) => filterStorageStateToAllowlistMock(...args),
}));

const FAKE_REAL_CHROME_HANDLE = { process: { kill: vi.fn() }, cdpPort: 54733, userDataDir: "/fake/tmp/gigradar-real-chrome" };
const FAKE_STORAGE_STATE = { cookies: [], origins: [] };

import { closeCopilotSession, getCopilotPage, IDLE_TIMEOUT_MS, openCopilotSession } from "../verification-copilot-session.js";

// A real registered source with a SOURCE_ORIGINS entry -- see src/lib/sources/origins.ts.
const SOURCE_ID = "gofractional";
const BLOCKED_URL = "https://gofractional.com/jobs?blocked=1";

let tmpDataDir: string;

function createFakePage() {
  return { goto: vi.fn().mockResolvedValue(undefined) };
}

function createFakeContext(page: unknown) {
  return { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
}

/** Same real-EventEmitter-shaped fake browser assist-session.test.ts/session-capture.test.ts use, for the same reason: the "disconnected" listener tests exercise the actual listener the module registers. */
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

beforeEach(async () => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-verification-copilot-session-test-"));
  process.env.XDG_DATA_HOME = tmpDataDir;
  spawnRealChromeMock.mockReset();
  attachToRealChromeMock.mockReset();
  closeRealChromeMock.mockReset();
  readStorageStateFileMock.mockReset().mockReturnValue(FAKE_STORAGE_STATE);
  filterStorageStateToAllowlistMock.mockReset().mockReturnValue(FAKE_STORAGE_STATE);
  vi.mocked((await import("../../notify/desktop.js")).sendDesktopNotification).mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  // Drain any session left in the globalThis-pinned map between tests --
  // same cleanup discipline assist-session.test.ts uses (clear the
  // EXISTING Map in place, never reassign the globalThis property).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only read of the same deliberate globalThis cast the module itself uses.
  const map = (globalThis as any).__gigradarVerificationCopilotSessions as Map<string, { timeoutHandle: ReturnType<typeof setTimeout> }> | undefined;
  if (map) {
    for (const entry of map.values()) clearTimeout(entry.timeoutHandle);
    map.clear();
  }
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.XDG_DATA_HOME;
});

describe("openCopilotSession / getCopilotPage / closeCopilotSession: happy path", () => {
  it("spawns real Chrome, loads the source's scoped storageState, navigates to the blocked URL, and returns a sessionId", async () => {
    const { browser, page, context } = setUpFakeBrowserChain();

    const info = await openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json");
    expect(typeof info.sessionId).toBe("string");
    expect(info.sessionId.length).toBeGreaterThan(0);
    expect(info.sourceId).toBe(SOURCE_ID);

    expect(readStorageStateFileMock).toHaveBeenCalled();
    expect(filterStorageStateToAllowlistMock).toHaveBeenCalledWith(FAKE_STORAGE_STATE, expect.arrayContaining([expect.stringContaining("gofractional.com")]));
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(BLOCKED_URL);

    expect(getCopilotPage(info.sessionId)).toBe(page);

    await closeCopilotSession(info.sessionId);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(closeRealChromeMock).toHaveBeenCalledWith(FAKE_REAL_CHROME_HANDLE);
  });

  it("fires a desktop notification once the browser window is genuinely open (product-review-followups epic)", async () => {
    setUpFakeBrowserChain();
    const { sendDesktopNotification } = await import("../../notify/desktop.js");

    await openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json");

    expect(sendDesktopNotification).toHaveBeenCalledTimes(1);
    expect(sendDesktopNotification).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(SOURCE_ID) }));
  });
});

describe("one session per sourceId", () => {
  it("rejects a second open for a sourceId that already has a live session, without spawning a second browser", async () => {
    setUpFakeBrowserChain();

    await openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json");
    spawnRealChromeMock.mockClear();

    await expect(openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json")).rejects.toThrow(/already active for source/);
    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });

  it("allows opening a new session for the same sourceId after the first one closes", async () => {
    setUpFakeBrowserChain();

    const first = await openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json");
    await closeCopilotSession(first.sessionId);

    setUpFakeBrowserChain();
    const second = await openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json");
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});

describe("unknown/expired session handling", () => {
  it("getCopilotPage() throws a specific error for an unknown sessionId", () => {
    expect(() => getCopilotPage("not-a-real-session-id")).toThrow(/not found or expired/);
  });

  it("closeCopilotSession() is idempotent -- a second call for an already-closed session is a silent no-op", async () => {
    const { browser } = setUpFakeBrowserChain();

    const info = await openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json");
    await closeCopilotSession(info.sessionId);
    expect(browser.close).toHaveBeenCalledTimes(1);

    await expect(closeCopilotSession(info.sessionId)).resolves.toBeUndefined();
    expect(browser.close).toHaveBeenCalledTimes(1); // not called again
  });
});

describe("registry gaps throw before spawning a browser", () => {
  it("throws for a sourceId with no SOURCE_ORIGINS entry", async () => {
    await expect(openCopilotSession("not-a-real-source", BLOCKED_URL, "storage-state.json")).rejects.toThrow(/no origin allowlist registered/);
    expect(spawnRealChromeMock).not.toHaveBeenCalled();
  });
});

describe("idle timeout", () => {
  it("closes the browser and evicts the session after IDLE_TIMEOUT_MS of no activity", async () => {
    vi.useFakeTimers();
    const { browser } = setUpFakeBrowserChain();

    const info = await openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json");

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(() => getCopilotPage(info.sessionId)).toThrow(/not found or expired/);
  });

  it("getCopilotPage() refreshes the idle-timeout clock -- an actively-used session does not time out", async () => {
    vi.useFakeTimers();
    const { browser } = setUpFakeBrowserChain();

    const info = await openCopilotSession(SOURCE_ID, BLOCKED_URL, "storage-state.json");

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS / 2);
    getCopilotPage(info.sessionId);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 2000);

    expect(browser.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
