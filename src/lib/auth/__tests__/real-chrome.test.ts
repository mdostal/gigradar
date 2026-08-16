// Tests for src/lib/auth/real-chrome.ts (oauth-session-capture-v2 epic,
// real-chrome-spawn-attach story). Highest-stakes coverage:
//   1. spawnRealChrome() NEVER calls playwright.chromium.launch() -- it
//      shells out via child_process.spawn() directly, with exactly
//      --remote-debugging-port + --user-data-dir + --no-first-run +
//      --no-default-browser-check.
//   2. a missing real-Chrome binary throws a specific, actionable error --
//      never a silent fallback.
//   3. a readiness timeout kills the spawned process AND removes the temp
//      --user-data-dir before rejecting -- never leaks either.
//   4. closeRealChrome() is idempotent -- safe to call even after the
//      process already exited and/or the temp dir is already gone.
//   5. attachToRealChrome() is a thin, faithful wrapper around
//      chromium.connectOverCDP() -- never chromium.launch().
// child_process.spawn() and playwright's chromium.connectOverCDP() are
// fully mocked -- no real Chrome process, no live network. findFreePort()
// is exercised against the REAL node:net module (a genuine local TCP
// listen/close), since that's fast, deterministic, and proves an actual
// 127.0.0.1-bound free port is chosen, not a mock's assertion about intent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const connectOverCDPMock = vi.fn();
vi.mock("playwright", () => ({
  chromium: { connectOverCDP: (...args: unknown[]) => connectOverCDPMock(...args) },
}));

const REAL_MACOS_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function createFakeChildProcess() {
  return { kill: vi.fn() };
}

let realExistsSync: typeof fs.existsSync;
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  realExistsSync = fs.existsSync.bind(fs);
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  spawnMock.mockReset();
  connectOverCDPMock.mockReset();
  vi.spyOn(fs, "existsSync").mockImplementation((p) => {
    if (p === REAL_MACOS_CHROME_PATH) return true;
    return realExistsSync(p);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("spawnRealChrome: platform + binary-presence checks, before ever spawning", () => {
  it("throws a specific, actionable error on a non-macOS platform, without spawning", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { spawnRealChrome } = await import("../real-chrome.js");

    await expect(spawnRealChrome()).rejects.toThrow(/macOS-only/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("throws a specific error naming the exact path checked when real Chrome isn't installed -- never a silent fallback", async () => {
    vi.spyOn(fs, "existsSync").mockImplementation((p) => (p === REAL_MACOS_CHROME_PATH ? false : realExistsSync(p)));
    const { spawnRealChrome } = await import("../real-chrome.js");

    await expect(spawnRealChrome()).rejects.toThrow(new RegExp(REAL_MACOS_CHROME_PATH.replace(/[/.]/g, "\\$&")));
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("spawnRealChrome: happy path", () => {
  it("spawns the real Chrome binary directly via child_process.spawn() -- never playwright.chromium.launch() -- with exactly the expected flags", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { spawnRealChrome, closeRealChrome } = await import("../real-chrome.js");
    const handle = await spawnRealChrome();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [chromePath, args, options] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(chromePath).toBe(REAL_MACOS_CHROME_PATH);
    expect(args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^--remote-debugging-port=\d+$/),
        expect.stringMatching(/^--user-data-dir=.+$/),
        "--no-first-run",
        "--no-default-browser-check",
      ]),
    );
    expect(args).toHaveLength(4);
    expect(options).toMatchObject({ stdio: "ignore" });

    expect(handle.process).toBe(child);
    expect(typeof handle.cdpPort).toBe("number");
    expect(handle.cdpPort).toBeGreaterThan(0);
    expect(fs.existsSync(handle.userDataDir)).toBe(true);

    closeRealChrome(handle); // clean up the real temp dir this test created
  });

  it("creates a FRESH, isolated temp --user-data-dir per call -- never the caller's real profile", async () => {
    spawnMock.mockReturnValue(createFakeChildProcess());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { spawnRealChrome, closeRealChrome } = await import("../real-chrome.js");
    const a = await spawnRealChrome();
    const b = await spawnRealChrome();

    expect(a.userDataDir).not.toBe(b.userDataDir);
    expect(a.userDataDir.startsWith(os.tmpdir())).toBe(true);
    expect(a.cdpPort).not.toBe(b.cdpPort);

    closeRealChrome(a);
    closeRealChrome(b);
  });
});

describe("spawnRealChrome: readiness timeout", () => {
  it("kills the process and removes the temp dir before rejecting, when the CDP endpoint never becomes ready", async () => {
    vi.useFakeTimers();
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const { spawnRealChrome } = await import("../real-chrome.js");

    let userDataDirAtCallTime = "";
    const originalMkdtempSync = fs.mkdtempSync.bind(fs);
    vi.spyOn(fs, "mkdtempSync").mockImplementation((...args) => {
      const dir = originalMkdtempSync(...(args as Parameters<typeof fs.mkdtempSync>));
      userDataDirAtCallTime = dir as string;
      return dir;
    });

    const pending = expect(spawnRealChrome()).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(userDataDirAtCallTime)).toBe(false);
  });
});

describe("attachToRealChrome", () => {
  it("calls chromium.connectOverCDP() with the local CDP URL for the given port -- never chromium.launch()", async () => {
    const fakeBrowser = { contexts: vi.fn() };
    connectOverCDPMock.mockResolvedValue(fakeBrowser);

    const { attachToRealChrome } = await import("../real-chrome.js");
    const browser = await attachToRealChrome(54732);

    expect(connectOverCDPMock).toHaveBeenCalledWith("http://127.0.0.1:54732");
    expect(browser).toBe(fakeBrowser);
  });
});

describe("closeRealChrome", () => {
  it("kills the process and removes the temp user-data-dir", async () => {
    const { closeRealChrome } = await import("../real-chrome.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-test-"));
    const child = createFakeChildProcess();

    closeRealChrome({ process: child as never, cdpPort: 1, userDataDir: dir });

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("is safe to call even when the process is already gone and the temp dir is already removed", async () => {
    const { closeRealChrome } = await import("../real-chrome.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-test-"));
    fs.rmSync(dir, { recursive: true, force: true });
    const child = { kill: vi.fn(() => { throw new Error("already exited"); }) };

    expect(() => closeRealChrome({ process: child as never, cdpPort: 1, userDataDir: dir })).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
