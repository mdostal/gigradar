// oauth-session-capture-v2 epic, real-chrome-spawn-attach story. THE ACTUAL
// FIX for Google's "Couldn't sign you in -- this browser or app may not be
// secure" rejection (see .pHive/epics/oauth-session-capture-v2/docs/design-discussion.md
// §4). `chromium.launch()` -- regardless of which Chrome binary/channel it
// launches -- injects automation fingerprints (navigator.webdriver=true,
// --enable-automation) that Google's sign-in flow specifically detects,
// independent of the binary choice. This module never calls
// `playwright.chromium.launch()`. Instead it spawns a real, independent
// Chrome process directly via `child_process.spawn()`, then attaches to it
// over CDP via `chromium.connectOverCDP()` -- a later, passive attach that
// does not carry launch-time fingerprints.
//
// PERSISTENT PROFILE BY DEFAULT (product-review-followups epic,
// ateam-session-lifetime-blocker story). `--user-data-dir` points at a
// STABLE directory under the app's own data dir (getDefaultDataDir() +
// "real-chrome-profile"), reused across every spawnRealChrome() call --
// NOT a freshly created temp directory, and NOT the caller's real personal
// Chrome profile either (still fully isolated from whatever Chrome the
// human already has open day to day). closeRealChrome() never deletes it.
//
// Why the reversal from this file's original "fresh, isolated, every
// session" design: verified live (owner's own real a.team account,
// 2026-08-30) that a fresh throwaway profile every capture meant Google's
// OWN sign-in session had zero continuity between attempts -- every single
// Capture Login (or verification-copilot/profile-assist session) demanded
// a full interactive Google re-auth, password and 2FA included, no
// different from a stranger's browser. A persistent profile means "log
// into Google once" is finally true: Chrome remembers Google's OWN session
// cookie the exact same way a human's day-to-day browser would, and every
// SITE-specific captured session (the actual artifact that gets written to
// disk/Portunus) is still scoped down to that one source's origins via
// filterStorageStateToAllowlist() exactly as before -- this change only
// affects the INPUT browser used during interactive login, never widens
// what a captured session file itself can contain. Still 127.0.0.1-only, a
// fresh CDP port every launch, and never the human's own real Chrome
// profile -- the isolation this file cares about (this profile can't leak
// into the human's regular browsing, and a captured session file can't
// exceed one source's origins) is intact; only "does Chrome remember
// Google between two separate gigradar launches" changed.
//
// `opts.persistent: false` (or a caller-supplied `opts.userDataDir`) keeps
// today's original fresh-temp-dir behavior for a caller that genuinely
// wants a one-shot, disposable profile -- see spawnRealChrome()'s own doc
// comment.
//
// 127.0.0.1 ONLY, FRESH PORT PER SESSION. The CDP debug port is local-only
// (Chrome's own default when `--remote-debugging-address` is not passed) and
// chosen fresh per call via `findFreePort()` -- never fixed/guessable. A real
// Chrome instance with an open CDP port is a local attack surface; keeping it
// unpredictable and localhost-bound is this module's mitigation, and the
// window is only ever open for one capture/session's duration.
//
// macOS ONLY, FIRST PASS (matches scripts/prepare-tauri-sidecars.sh's own
// established "macOS only, first pass" scope precedent). A missing Chrome
// binary throws a specific, actionable error naming the exact path checked
// -- NEVER a silent fallback to Playwright's bundled Chromium, which would
// silently reintroduce the exact fingerprinting problem this module exists
// to fix.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { getDefaultDataDir } from "../store/path.js";

const MODULE_PREFIX = "gigradar real-chrome";

const MACOS_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The shared, reused profile directory — see this file's header comment. */
function persistentProfileDir(): string {
  return path.join(getDefaultDataDir(), "real-chrome-profile");
}

/**
 * True if the persistent profile is currently in use by ANOTHER LIVE Chrome
 * process — Chrome itself creates `SingletonLock` (a symlink whose target
 * encodes `<hostname>-<pid>`) in a `--user-data-dir` for exactly this
 * detection, and refuses/coalesces a second launch against an
 * already-locked profile. Two real-chrome flows genuinely running at once
 * (e.g. a Capture Login left open while profile-assist starts a session for
 * a different source) would otherwise either fail to launch a second
 * process or silently steal the first one's window/port — checked here so
 * that case degrades to a fresh, disposable profile for the SECOND caller
 * instead, never a broken/coalesced launch.
 *
 * Checks the encoded PID's ACTUAL liveness (`process.kill(pid, 0)` — signal
 * 0 only ever probes existence, never kills) rather than just the lock
 * file's existence — live-verified (2026-08-30) that closeRealChrome()'s
 * `handle.process.kill()` doesn't reliably terminate the real, independent
 * Chrome process it spawned (a real macOS Chrome.app launch quirk — see
 * that function's own doc comment), which can leave a genuinely-stale lock
 * behind. A stale lock (encoded PID no longer running) is self-healed by
 * removing it here and reporting "not locked," rather than needlessly
 * degrading every future launch to a disposable profile forever.
 */
function isProfileLocked(dir: string): boolean {
  const lockPath = path.join(dir, "SingletonLock");
  let target: string;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return false; // no lock file, or not a symlink -- not locked
  }

  const match = /-(\d+)$/.exec(target);
  if (!match) return true; // unrecognized shape -- be conservative, treat as locked

  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
    return true; // the encoded PID is genuinely still alive
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
      // EPERM (the pid exists but this process can't signal it) or
      // anything else unexpected -- conservatively treat as still locked
      // rather than risk a false "it's dead" on a real, live process.
      return true;
    }
    // ESRCH (no such process) -- a stale lock left behind by an unclean
    // exit. Remove it so this and every future call sees a clean profile.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best-effort -- a failed cleanup here just means the NEXT check
      // re-attempts it; never fatal.
    }
    return false;
  }
}

/**
 * Belt-and-suspenders kill: sends SIGKILL to every process whose command
 * line contains this exact `--user-data-dir=<userDataDir>` flag, via `pkill
 * -f`. Added alongside `handle.process.kill()` in closeRealChrome() below
 * because that alone was live-verified (2026-08-30) to NOT reliably
 * terminate the real Chrome process spawnRealChrome() launched — the
 * tracked `ChildProcess` handle can end up stale (a real macOS Chrome.app
 * launch quirk: the directly-spawned binary can exit while the actual
 * browser continues running under different PID(s)), leaving a real,
 * running Chrome instance holding the profile lock indefinitely. Matching
 * on the launch flag (unique per invocation — never reused, unlike a PID)
 * rather than any specific PID sidesteps that unreliability entirely.
 * `spawnSync` with an argv array (never a shell string) — safe regardless
 * of `userDataDir`'s content, though in practice it's always a path this
 * module generated itself. Best-effort: `pkill` exits non-zero when it
 * finds nothing to kill, which is the common, expected case, not an error.
 */
function killByUserDataDir(userDataDir: string): void {
  try {
    spawnSync("pkill", ["-f", `--user-data-dir=${userDataDir}`], { stdio: "ignore" });
  } catch {
    // pkill itself missing/unusable -- nothing more to do here.
  }
}

/** How long to wait for the spawned Chrome's CDP endpoint to answer before giving up. */
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 200;

/** Everything closeRealChrome() needs to fully tear a spawned Chrome instance down. */
export interface RealChromeHandle {
  process: ChildProcess;
  cdpPort: number;
  userDataDir: string;
  /** Whether `userDataDir` is the shared, reused persistent profile (never deleted by closeRealChrome()) or a one-shot temp dir (deleted). */
  persistent: boolean;
}

export interface SpawnRealChromeOptions {
  /**
   * Default `true`: reuse the shared persistent profile (see this file's
   * header comment) so Google/SSO sign-in carries over between sessions.
   * Pass `false` for a caller that genuinely wants today's original
   * one-shot, disposable profile instead.
   */
  persistent?: boolean;
}

/** Resolves the real Chrome binary path for the current platform, or throws a specific, actionable error -- never a silent fallback. See this file's header comment. */
function resolveRealChromePath(): string {
  if (process.platform !== "darwin") {
    throw new Error(
      `${MODULE_PREFIX}: real-Chrome spawn-then-attach is macOS-only in this first pass (platform "${process.platform}" is not supported yet).`,
    );
  }
  if (!fs.existsSync(MACOS_CHROME_PATH)) {
    throw new Error(
      `${MODULE_PREFIX}: Google Chrome not found at "${MACOS_CHROME_PATH}". Install Google Chrome, then retry.`,
    );
  }
  return MACOS_CHROME_PATH;
}

/** Picks a free local port by binding to port 0 and reading back what the OS assigned, bound to 127.0.0.1 only -- see this file's header comment. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error(`${MODULE_PREFIX}: could not determine a free local port.`)));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Polls Chrome's own `/json/version` CDP endpoint until it answers, or throws after READY_TIMEOUT_MS. */
async function waitForCdpReady(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Not up yet -- keep polling.
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`${MODULE_PREFIX}: real Chrome did not become ready on CDP port ${port} within ${READY_TIMEOUT_MS}ms.`);
}

/**
 * Spawns a real, independent Chrome process -- DIRECTLY via
 * `child_process.spawn()`, never `playwright.chromium.launch()` -- with a
 * fresh isolated `--user-data-dir` and a fresh local-only
 * `--remote-debugging-port`. Waits for its CDP endpoint to respond before
 * returning. On any failure to become ready, kills the process and removes
 * the temp profile dir before re-throwing -- never leaks either on a failed
 * startup.
 */
export async function spawnRealChrome(opts: SpawnRealChromeOptions = {}): Promise<RealChromeHandle> {
  const chromePath = resolveRealChromePath();
  const cdpPort = await findFreePort();

  const wantsPersistent = opts.persistent ?? true;
  const persistent = wantsPersistent && !isProfileLocked(persistentProfileDir());
  const userDataDir = persistent ? persistentProfileDir() : fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-"));
  if (persistent) fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: "ignore" },
  );

  try {
    await waitForCdpReady(cdpPort);
  } catch (e) {
    try {
      child.kill();
    } catch {
      // already exited
    }
    if (!persistent) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup on a failed startup
      }
    }
    throw e;
  }

  return { process: child, cdpPort, userDataDir, persistent };
}

/** Thin wrapper around `chromium.connectOverCDP()` -- attaches to an already-running real Chrome without ever having launched it through Playwright. */
export async function attachToRealChrome(cdpPort: number): Promise<Browser> {
  return chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
}

/**
 * Terminates the spawned Chrome process. For a one-shot (`persistent:
 * false`) handle, also removes its temp `--user-data-dir` — same as this
 * function's original behavior. For the shared persistent profile, the
 * directory is deliberately left alone: it's reused by the NEXT
 * spawnRealChrome() call, that's the entire point (see this file's header
 * comment). Safe to call more than once, and safe to call after the process
 * has already exited on its own (e.g. the user quit the window directly) —
 * both the kill and the directory removal swallow their own errors, since
 * there is nothing more to clean up in either case.
 */
export function closeRealChrome(handle: RealChromeHandle): void {
  try {
    handle.process.kill();
  } catch {
    // already exited
  }
  // Belt-and-suspenders — see killByUserDataDir()'s own doc comment for why
  // the call above alone isn't reliable enough to trust on its own.
  killByUserDataDir(handle.userDataDir);

  if (handle.persistent) return;
  try {
    fs.rmSync(handle.userDataDir, { recursive: true, force: true });
  } catch {
    // already removed, or was never created
  }
}
