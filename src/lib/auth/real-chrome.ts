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
// FRESH, ISOLATED PROFILE, EVERY SESSION. `--user-data-dir` always points at
// a freshly created temp directory -- never the caller's real personal
// Chrome profile. `closeRealChrome()` removes it; nothing from one session
// persists into the next.
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
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";

const MODULE_PREFIX = "gigradar real-chrome";

const MACOS_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** How long to wait for the spawned Chrome's CDP endpoint to answer before giving up. */
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 200;

/** Everything closeRealChrome() needs to fully tear a spawned Chrome instance down. */
export interface RealChromeHandle {
  process: ChildProcess;
  cdpPort: number;
  userDataDir: string;
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
export async function spawnRealChrome(): Promise<RealChromeHandle> {
  const chromePath = resolveRealChromePath();
  const cdpPort = await findFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-real-chrome-"));

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
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup on a failed startup
    }
    throw e;
  }

  return { process: child, cdpPort, userDataDir };
}

/** Thin wrapper around `chromium.connectOverCDP()` -- attaches to an already-running real Chrome without ever having launched it through Playwright. */
export async function attachToRealChrome(cdpPort: number): Promise<Browser> {
  return chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
}

/**
 * Terminates the spawned Chrome process and removes its temp
 * `--user-data-dir`. Safe to call more than once, and safe to call after the
 * process has already exited on its own (e.g. the user quit the window
 * directly) -- both the kill and the directory removal swallow their own
 * errors, since there is nothing more to clean up in either case.
 */
export function closeRealChrome(handle: RealChromeHandle): void {
  try {
    handle.process.kill();
  } catch {
    // already exited
  }
  try {
    fs.rmSync(handle.userDataDir, { recursive: true, force: true });
  } catch {
    // already removed, or was never created
  }
}
