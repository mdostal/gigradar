// Tests for src/lib/auth/real-chrome.ts (oauth-session-capture-v2 epic,
// real-chrome-spawn-attach story; ateam-session-lifetime-blocker story,
// product-review-followups epic, added the persistent-profile-by-default
// behavior below). Highest-stakes coverage:
//   1. spawnRealChrome() NEVER calls playwright.chromium.launch() -- it
//      shells out via child_process.spawn() directly, with exactly
//      --remote-debugging-port + --user-data-dir + --no-first-run +
//      --no-default-browser-check.
//   2. a missing real-Chrome binary throws a specific, actionable error --
//      never a silent fallback.
//   3. by DEFAULT, spawnRealChrome() reuses ONE shared persistent profile
//      directory across calls (Google/SSO sign-in continuity) -- and
//      closeRealChrome() never deletes it.
//   4. `{ persistent: false }` (or the persistent profile being locked by
//      an already-running Chrome) falls back to today's original
//      fresh-temp-dir-per-call behavior, which closeRealChrome() DOES
//      delete.
//   5. a readiness timeout kills the spawned process AND removes a
//      one-shot temp --user-data-dir (never the persistent one) before
//      rejecting -- never leaks either.
//   6. closeRealChrome() is idempotent -- safe to call even after the
//      process already exited and/or the temp dir is already gone.
//   7. attachToRealChrome() is a thin, faithful wrapper around
//      chromium.connectOverCDP() -- never chromium.launch().
//   8. isProfileLocked() checks the SingletonLock symlink's ENCODED PID for
//      actual liveness (never just the file's existence) and self-heals a
//      stale lock left by an unclean exit -- live-verified (2026-08-30)
//      that a real Chrome process can outlive handle.process.kill().
//   9. closeRealChrome() ALSO kills by matching `--user-data-dir=...` on
//      the command line (`pkill -f`, via child_process.spawnSync) as a
//      belt-and-suspenders measure, for the same reason.
// child_process.spawn()/spawnSync() and playwright's chromium.connectOverCDP()
// are fully mocked -- no real Chrome process, no live network. findFreePort()
// is exercised against the REAL node:net module (a genuine local TCP
// listen/close), since that's fast, deterministic, and proves an actual
// 127.0.0.1-bound free port is chosen, not a mock's assertion about intent.
// XDG_DATA_HOME is pointed at an isolated temp dir for every test (the
// persistent-profile path resolves through getDefaultDataDir()) -- never
// this machine's real ~/.local/share/gigradar.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
// embedded-browser-and-guided-session epic: execFile() is what
// minimizeChromeWindow()/positionChromeWindowSideBySide() shell out to
// osascript with -- mocked here too, defaulting to a successful no-op
// callback so every OTHER test in this file (which never touches those two
// functions) is unaffected.
const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  execFile: (...args: unknown[]) => execFileMock(...(args as [string, string[], unknown, (err: Error | null) => void])),
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
let xdgDataHomeDir: string;

beforeEach(() => {
  realExistsSync = fs.existsSync.bind(fs);
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  xdgDataHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-test-xdg-"));
  process.env.XDG_DATA_HOME = xdgDataHomeDir;
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  connectOverCDPMock.mockReset();
  execFileMock.mockReset();
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null));
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
  delete process.env.XDG_DATA_HOME;
  fs.rmSync(xdgDataHomeDir, { recursive: true, force: true });
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

describe("spawnRealChrome: happy path, persistent profile (the default)", () => {
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
    expect(handle.persistent).toBe(true);
    expect(handle.userDataDir).toBe(path.join(xdgDataHomeDir, "gigradar", "real-chrome-profile"));
    expect(fs.existsSync(handle.userDataDir)).toBe(true);

    closeRealChrome(handle);
    // Persistent -- closeRealChrome() must NOT have deleted it.
    expect(fs.existsSync(handle.userDataDir)).toBe(true);
  });

  it("reuses the SAME persistent --user-data-dir across separate calls -- the entire point (Google/SSO continuity)", async () => {
    spawnMock.mockReturnValue(createFakeChildProcess());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { spawnRealChrome, closeRealChrome } = await import("../real-chrome.js");
    const a = await spawnRealChrome();
    closeRealChrome(a); // simulate the first session ending before the second starts
    const b = await spawnRealChrome();

    expect(a.userDataDir).toBe(b.userDataDir);
    expect(a.persistent).toBe(true);
    expect(b.persistent).toBe(true);
    expect(a.cdpPort).not.toBe(b.cdpPort); // still a fresh port every launch

    closeRealChrome(b);
  });

  it("falls back to a fresh, disposable temp dir when the persistent profile is already locked by a live Chrome (concurrent flows)", async () => {
    spawnMock.mockReturnValue(createFakeChildProcess());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { spawnRealChrome, closeRealChrome } = await import("../real-chrome.js");
    const first = await spawnRealChrome();
    // Simulate Chrome's own SingletonLock -- a REAL symlink (matching
    // Chrome's actual "<hostname>-<pid>" target shape), encoding THIS
    // test process's own pid so isProfileLocked()'s liveness check (real
    // process.kill(pid, 0)) finds it genuinely alive, same as a real
    // concurrently-running Chrome would be.
    fs.symlinkSync(`test-host-${process.pid}`, path.join(first.userDataDir, "SingletonLock"));

    const second = await spawnRealChrome();

    expect(second.persistent).toBe(false);
    expect(second.userDataDir).not.toBe(first.userDataDir);
    expect(second.userDataDir.startsWith(os.tmpdir())).toBe(true);

    closeRealChrome(first);
    closeRealChrome(second);
    expect(fs.existsSync(second.userDataDir)).toBe(false); // one-shot dir WAS deleted
  });

  it("self-heals a STALE lock (encoded pid no longer running) instead of degrading forever -- uses the persistent profile and removes the dead lock", async () => {
    spawnMock.mockReturnValue(createFakeChildProcess());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { spawnRealChrome, closeRealChrome } = await import("../real-chrome.js");
    const expectedDir = path.join(xdgDataHomeDir, "gigradar", "real-chrome-profile");
    fs.mkdirSync(expectedDir, { recursive: true });
    const lockPath = path.join(expectedDir, "SingletonLock");
    // An astronomically unlikely-to-exist pid -- simulates a lock left
    // behind by an unclean exit (see this file's own doc comment on why
    // handle.process.kill() alone isn't reliable).
    fs.symlinkSync("test-host-999999", lockPath);

    const handle = await spawnRealChrome();

    expect(handle.persistent).toBe(true);
    expect(handle.userDataDir).toBe(expectedDir);
    expect(fs.existsSync(lockPath)).toBe(false); // stale lock removed

    closeRealChrome(handle);
  });
});

describe("spawnRealChrome: persistent: false (opt out)", () => {
  it("creates a FRESH, isolated temp --user-data-dir per call -- never the persistent profile", async () => {
    spawnMock.mockReturnValue(createFakeChildProcess());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const { spawnRealChrome, closeRealChrome } = await import("../real-chrome.js");
    const a = await spawnRealChrome({ persistent: false });
    const b = await spawnRealChrome({ persistent: false });

    expect(a.persistent).toBe(false);
    expect(b.persistent).toBe(false);
    expect(a.userDataDir).not.toBe(b.userDataDir);
    expect(a.userDataDir.startsWith(os.tmpdir())).toBe(true);
    expect(a.cdpPort).not.toBe(b.cdpPort);

    closeRealChrome(a);
    closeRealChrome(b);
    expect(fs.existsSync(a.userDataDir)).toBe(false);
    expect(fs.existsSync(b.userDataDir)).toBe(false);
  });
});

describe("spawnRealChrome: readiness timeout", () => {
  it("kills the process and removes a one-shot temp dir before rejecting, when the CDP endpoint never becomes ready", async () => {
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

    const pending = expect(spawnRealChrome({ persistent: false })).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(userDataDirAtCallTime)).toBe(false);
  });

  it("kills the process but leaves the persistent profile directory alone on a readiness timeout", async () => {
    vi.useFakeTimers();
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const { spawnRealChrome } = await import("../real-chrome.js");
    const expectedDir = path.join(xdgDataHomeDir, "gigradar", "real-chrome-profile");

    const pending = expect(spawnRealChrome()).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(expectedDir)).toBe(true); // never removed -- it's the shared, reused profile
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
  it("kills the process and removes the temp user-data-dir for a one-shot (persistent: false) handle", async () => {
    const { closeRealChrome } = await import("../real-chrome.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-test-"));
    const child = createFakeChildProcess();

    closeRealChrome({ process: child as never, cdpPort: 1, userDataDir: dir, persistent: false });

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("ALSO kills by matching --user-data-dir on the command line (pkill -f, belt-and-suspenders) -- see this file's own doc comment for why", async () => {
    const { closeRealChrome } = await import("../real-chrome.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-test-"));
    const child = createFakeChildProcess();

    closeRealChrome({ process: child as never, cdpPort: 1, userDataDir: dir, persistent: false });

    expect(spawnSyncMock).toHaveBeenCalledWith("pkill", ["-f", `--user-data-dir=${dir}`], { stdio: "ignore" });
  });

  it("kills the process but does NOT remove the directory for a persistent handle", async () => {
    const { closeRealChrome } = await import("../real-chrome.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-test-"));
    const child = createFakeChildProcess();

    closeRealChrome({ process: child as never, cdpPort: 1, userDataDir: dir, persistent: true });

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dir)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true }); // test's own cleanup
  });

  it("is safe to call even when the process is already gone and the temp dir is already removed", async () => {
    const { closeRealChrome } = await import("../real-chrome.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-test-"));
    fs.rmSync(dir, { recursive: true, force: true });
    const child = { kill: vi.fn(() => { throw new Error("already exited"); }) };

    expect(() => closeRealChrome({ process: child as never, cdpPort: 1, userDataDir: dir, persistent: false })).not.toThrow();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});

describe("minimizeChromeWindow / positionChromeWindowSideBySide (embedded-browser-and-guided-session epic)", () => {
  // Real bug, found and fixed live 2026-09-03: these used to address
  // Chrome's own shared `window 1 of application "Google Chrome"`, which
  // has no notion of which process spawned a given window -- could touch
  // the owner's own unrelated Chrome windows, or throw when window 1
  // wasn't the automation window at all. Now targeted by the SPECIFIC
  // spawned process's pid via System Events, never Chrome's own ambiguous
  // window list. These tests assert that pid-scoping directly.
  const FAKE_PID = 54321;

  it("minimizeChromeWindow shells out to osascript via execFile (argv-level, never a shell), scoped to the given pid via System Events -- never Chrome's own shared window list", async () => {
    const { minimizeChromeWindow } = await import("../real-chrome.js");

    await minimizeChromeWindow(FAKE_PID);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[], unknown, unknown];
    expect(cmd).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain("System Events");
    expect(args[1]).toContain(`first process whose unix id is ${FAKE_PID}`);
    expect(args[1]).toContain('set value of attribute "AXMinimized" of window 1 to true');
    // The old, ambiguous addressing must be gone entirely.
    expect(args[1]).not.toContain('tell application "Google Chrome" to set miniaturized');
  });

  it("positionChromeWindowSideBySide queries the real screen bounds via Finder, then sets the given pid's window position/size to the right half via System Events", async () => {
    const { positionChromeWindowSideBySide } = await import("../real-chrome.js");

    await positionChromeWindowSideBySide(FAKE_PID);

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[], unknown, unknown];
    expect(cmd).toBe("osascript");
    const script = args[1];
    expect(script).toContain('tell application "Finder" to set screenBounds to bounds of window of desktop');
    expect(script).toContain("System Events");
    expect(script).toContain(`first process whose unix id is ${FAKE_PID}`);
    expect(script).toContain("set position of window 1 to");
    expect(script).toContain("set size of window 1 to");
    expect(script).toContain("screenWidth / 2");
    // The old, ambiguous addressing must be gone entirely.
    expect(script).not.toContain('tell application "Google Chrome" to set bounds');
  });

  it("both are no-ops (never call execFile) on a non-macOS platform", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { minimizeChromeWindow, positionChromeWindowSideBySide } = await import("../real-chrome.js");

    await minimizeChromeWindow(FAKE_PID);
    await positionChromeWindowSideBySide(FAKE_PID);

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("both are best-effort -- an osascript failure is swallowed, never thrown", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) =>
      cb(new Error("osascript: Chrome not running")),
    );
    const { minimizeChromeWindow, positionChromeWindowSideBySide } = await import("../real-chrome.js");

    await expect(minimizeChromeWindow(FAKE_PID)).resolves.toBeUndefined();
    await expect(positionChromeWindowSideBySide(FAKE_PID)).resolves.toBeUndefined();
  });
});
