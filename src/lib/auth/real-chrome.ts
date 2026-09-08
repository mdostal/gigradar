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
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
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
  /**
   * real-chrome-unattended-self-heal story (real-chrome-session-sharing
   * epic follow-up). Default `false` (a real, visible window — today's
   * original, only behavior). `true` adds `--headless=new` to the spawn
   * args -- Chrome's modern headless mode, distinct from the old
   * `--headless` this project has never used. Still the SAME real,
   * directly-spawned Chrome binary with NONE of `chromium.launch()`'s
   * automation flags (`--enable-automation`, `navigator.webdriver=true`)
   * -- this file's own header comment already identifies THOSE flags,
   * not headless-ness itself, as what Google's (and by the same
   * mechanism, Cloudflare's) bot detection actually keys on. Lets an
   * UNATTENDED caller (browser-session.ts's withBrowserSession(),
   * `attended: false`) reach this real, non-fingerprinted Chrome without
   * ever popping a visible window -- see that module's own doc comment
   * for why unattended callers were previously unable to reach this tier
   * at all.
   */
  headless?: boolean;
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
      ...(opts.headless ? ["--headless=new"] : []),
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

// -----------------------------------------------------------------------
// real-chrome-session-sharing epic, cross-module-real-chrome-registry
// story. THE OTHER HALF of the owner's real, live complaint ("it can get
// multiple browsers and multiple instances open at once rather than shared
// login and one thing at a time"): session-capture.ts,
// verification-copilot-session.ts, and assist-session.ts each independently
// call spawnRealChrome(), and the ONLY cross-module coordination was
// Chrome's own SingletonLock file on the shared profile directory
// (isProfileLocked() above). If a second real-chrome consumer (any of the
// three modules, for any sourceId) called spawnRealChrome() while a first
// was still live, it would see the profile locked and silently fall back
// to a fresh, DISPOSABLE, completely separate Chrome process/profile —
// exactly the "multiple browsers, multiple instances, no shared login"
// symptom, since a disposable profile shares nothing with the persistent
// one.
//
// acquireRealChrome()/releaseRealChrome() below are a thin, REFCOUNTED
// layer on top of spawnRealChrome()/attachToRealChrome()/closeRealChrome()
// (none of which change) — GLOBALTHIS-PINNED, same HMR-survival reasoning
// as every other in-memory session map in this codebase (see
// session-capture.ts's file-header comment for the canonical explanation).
// A second concurrent acquireRealChrome() call, while a first persistent
// session is still live, gets back the SAME already-attached Browser
// connection (refCount incremented) instead of spawning a competing
// process — the caller then opens its OWN page/tab in that shared browser
// for its own specific flow, so two genuinely concurrent flows (e.g. one
// issue's "Open browser to help clear it" while a different issue's
// Capture Login is still open) share ONE real window with multiple tabs,
// not two separate windows with two separate logins. releaseRealChrome()
// only actually closes the browser once every acquirer has released it.
//
// A DISPOSABLE handle (spawnRealChrome() itself already fell back because
// the persistent profile was locked by something this registry doesn't
// track — e.g. a genuinely external, non-gigradar Chrome instance holding
// that exact profile dir, an edge case real-chrome.ts's own header comment
// already accepts as a v1 risk) is never registered here — it's a one-off,
// closed directly by its own sole caller, unchanged from today's behavior.
// -----------------------------------------------------------------------

interface SharedPersistentEntry {
  handle: RealChromeHandle;
  browser: Browser;
  refCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate untyped globalThis cast; see session-capture.ts's file header for why this exact idiom is required.
const sharedState: { current: SharedPersistentEntry | null } = ((globalThis as any).__gigradarSharedRealChrome ??= {
  current: null,
});

/**
 * Acquires a real Chrome browser connection: reuses the currently-live
 * shared persistent session (incrementing its refcount) if one exists and
 * is still connected, otherwise spawns a fresh one via spawnRealChrome() +
 * attachToRealChrome() exactly as every existing call site already did.
 * Every caller MUST pair this with exactly one releaseRealChrome() call
 * (never call closeRealChrome()/browser.close() directly on a handle
 * acquired this way — see releaseRealChrome()'s own doc comment).
 */
export async function acquireRealChrome(): Promise<{ handle: RealChromeHandle; browser: Browser }> {
  const existing = sharedState.current;
  if (existing) {
    if (existing.browser.isConnected()) {
      existing.refCount += 1;
      return { handle: existing.handle, browser: existing.browser };
    }
    // Stale — the shared browser disconnected without going through
    // releaseRealChrome() (e.g. the human closed the real Chrome window
    // directly rather than clicking "Finish"/"Cancel"/"I'm done" in the
    // app). Drop it so the spawn below replaces it with a fresh one.
    sharedState.current = null;
  }

  const handle = await spawnRealChrome();
  let browser: Browser;
  try {
    browser = await attachToRealChrome(handle.cdpPort);
  } catch (e) {
    closeRealChrome(handle);
    throw e;
  }

  if (handle.persistent) {
    sharedState.current = { handle, browser, refCount: 1 };
    // Belt-and-suspenders: if the human closes this window directly, clear
    // the shared registry entry immediately rather than waiting for the
    // NEXT acquireRealChrome() call's isConnected() check to notice — a
    // NAMED listener (never removeAllListeners, per session-capture.ts's
    // CaptureEntry.disconnectedListener doc comment) that coexists fine
    // with each individual consumer's OWN disconnect listener.
    browser.on("disconnected", () => {
      if (sharedState.current?.browser === browser) sharedState.current = null;
    });
  }

  return { handle, browser };
}

/**
 * Releases a browser+handle pair acquired via acquireRealChrome(). If it's
 * the currently-shared persistent session, decrements its refcount and only
 * actually closes the browser + real Chrome process once every acquirer has
 * released it (refcount reaches zero) — a still-in-use shared session stays
 * open for whichever other flow(s) are still using it. A disposable
 * (non-shared) handle is closed immediately, same as before this registry
 * existed. Safe to call more than once for the same handle (idempotent,
 * same posture as closeRealChrome() itself).
 */
export async function releaseRealChrome(browser: Browser, handle: RealChromeHandle): Promise<void> {
  const existing = sharedState.current;
  if (existing && existing.handle === handle) {
    existing.refCount -= 1;
    if (existing.refCount > 0) return; // still in use elsewhere — leave the shared browser open
    sharedState.current = null;
  }

  try {
    await browser.close();
  } catch {
    // already closed/closing — nothing more to do.
  }
  closeRealChrome(handle);
}

// -----------------------------------------------------------------------
// embedded-browser-and-guided-session epic: window-management helpers, used
// so a real, headed Chrome window never sits there flashing/stealing focus
// on the owner's desktop for the duration of an unattended scan or a
// guided/full-auto profile-assist session. Both are macOS-only (this
// module is already macOS-gated -- see resolveRealChromePath()) and
// BEST-EFFORT: a failure here (System Events accessibility permission not
// granted, Chrome not yet frontmost, whatever) is logged and swallowed,
// never thrown -- the caller already has a working, authenticated browser
// at this point, and losing the window-placement nicety must never turn
// into a failed scan/session. Same execFile-argv-level-no-shell discipline
// src/lib/notify/desktop.ts already established for its own osascript
// call. Each function below is addressed by the SPECIFIC PID of the
// Chrome process it's meant to affect (via System Events' `first process
// whose unix id is <pid>`) -- see minimizeChromeWindow()'s own doc
// comment for the real, live-reproduced bug this replaced (blindly
// addressing Chrome's own shared `window 1`, which has no notion of which
// process spawned a given window and could touch the owner's own
// unrelated Chrome windows).
// -----------------------------------------------------------------------

function runOsascript(script: string, logContext: string): Promise<void> {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 5_000 }, (err) => {
      if (err) console.warn(`${MODULE_PREFIX}: ${logContext} failed (non-fatal): ${err.message}`);
      resolve();
    });
  });
}

/**
 * REAL BUG, FOUND AND FIXED LIVE 2026-09-03: both functions below used to
 * address `window 1 of application "Google Chrome"` — Chrome's own
 * AppleScript dictionary, which has NO notion of "which process spawned
 * this window." Every Chrome window on the machine, from every source
 * (the owner's own everyday browsing, a DIFFERENT gigradar-spawned
 * window, anything) shares that ONE "Google Chrome" application object —
 * "window 1" is whatever Chrome itself considers first (not necessarily
 * the automation window, not necessarily even stable), so this could
 * silently minimize/reposition the owner's own unrelated Chrome window,
 * or throw (live-reproduced: "Can't make miniaturized of window 1 into
 * type specifier") when window 1 happened to be some window that doesn't
 * support the property at all. Confirmed live while the owner was
 * actively trying to use a DIFFERENT window at the moment an unattended
 * scan's headed fallback fired.
 *
 * THE FIX: target the window by the SPECIFIC PID of the Chrome process
 * this module itself spawned (`RealChromeHandle.process.pid`, or
 * Playwright's own `browser.process()?.pid` for the
 * `channel: "chrome"`-launched fast-path tier in browser-session.ts) via
 * System Events' accessibility API (`first process whose unix id is
 * <pid>`) instead of Chrome's own ambiguous, shared window list. This can
 * only ever reach the window this exact process owns — never the owner's
 * own browsing, never a different spawned instance.
 *
 * TRADE-OFF: System Events UI-scripting requires macOS Accessibility
 * permission for whatever process runs `osascript` (unlike Chrome's own
 * AppleScript dictionary, which needed none) — if ungranted, these calls
 * simply fail (same best-effort, logged-and-swallowed posture as before),
 * degrading to "the window doesn't get minimized/positioned," never to
 * "the wrong window gets touched."
 */
export async function minimizeChromeWindow(pid: number): Promise<void> {
  if (process.platform !== "darwin") return;
  await runOsascript(
    `tell application "System Events" to tell (first process whose unix id is ${pid}) to set value of attribute "AXMinimized" of window 1 to true`,
    "minimizing the Chrome window",
  );
}

/**
 * Positions the specific Chrome window owned by process `pid` to the right
 * half of the primary display -- used for guided/full-auto profile-assist
 * sessions, where a human IS expected to be present and the owner
 * explicitly asked for a real, glanceable, directly-usable window (not a
 * hidden one) they can work side-by-side with the app, complementing (not
 * replacing) the embedded live-view pane. See this epic's
 * design-discussion.md for why true cross-app docking (tracking the
 * gigradar app's own window live) is out of scope here -- this is a fixed
 * half-of-screen placement, computed fresh each call from the primary
 * display's current bounds via Finder's own desktop-window bounds (the
 * same source `System Events`/`Finder`-based screen-geometry scripts
 * conventionally use on macOS). See minimizeChromeWindow()'s own doc
 * comment above for why `pid`-targeted System Events addressing replaced
 * Chrome's own ambiguous `window 1` addressing.
 */
export async function positionChromeWindowSideBySide(pid: number): Promise<void> {
  if (process.platform !== "darwin") return;
  await runOsascript(
    [
      'tell application "Finder" to set screenBounds to bounds of window of desktop',
      "set screenWidth to item 3 of screenBounds",
      "set screenHeight to item 4 of screenBounds",
      'tell application "System Events"',
      `  tell (first process whose unix id is ${pid})`,
      "    set position of window 1 to {(screenWidth / 2) as integer, 0}",
      "    set size of window 1 to {(screenWidth / 2) as integer, screenHeight}",
      "  end tell",
      "end tell",
    ].join("\n"),
    "positioning the Chrome window side-by-side",
  );
}
