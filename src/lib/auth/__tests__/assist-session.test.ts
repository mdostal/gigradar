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

const launchMock = vi.fn();
const executablePathMock = vi.fn();

vi.mock("playwright", () => ({
  chromium: {
    launch: (...args: unknown[]) => launchMock(...args),
    executablePath: (...args: unknown[]) => executablePathMock(...args),
  },
}));

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
const realExistsSync = fs.existsSync.bind(fs);

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
  launchMock.mockResolvedValue(browser);
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

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-assist-session-test-"));
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-assist-session-test-key-"));
  process.env.XDG_DATA_HOME = tmpDataDir;
  process.env.XDG_CONFIG_HOME = tmpKeyDir;
  launchMock.mockReset();
  executablePathMock.mockReset();
  executablePathMock.mockReturnValue("/fake/chromium/executable");
  vi.spyOn(fs, "existsSync").mockImplementation((p) => {
    if (p === "/fake/chromium/executable") return true;
    return realExistsSync(p);
  });
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
  });

  it("navigates to the source's registered SOURCE_PROFILE_URLS entry", async () => {
    const { page } = setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    await startAssistSession(SOURCE_ID, "manual", storageStatePath);

    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining("gofractional.com"));
  });
});

describe("one session per sourceId", () => {
  it("rejects a second start for a sourceId that already has a live session, without launching a second browser", async () => {
    setUpFakeBrowserChain();
    const storageStatePath = writeStorageStateFixture();

    await startAssistSession(SOURCE_ID, "manual", storageStatePath);
    launchMock.mockClear();

    await expect(startAssistSession(SOURCE_ID, "manual", storageStatePath)).rejects.toThrow(
      /already active for source/,
    );
    expect(launchMock).not.toHaveBeenCalled();
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

describe("registry gaps throw before launching a browser", () => {
  it("throws for a sourceId with no SOURCE_ORIGINS/SOURCE_PROFILE_URLS entry", async () => {
    const storageStatePath = writeStorageStateFixture();
    await expect(startAssistSession("not-a-real-source", "manual", storageStatePath)).rejects.toThrow(
      /no origin allowlist registered/,
    );
    expect(launchMock).not.toHaveBeenCalled();
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
