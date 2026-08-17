// Electron main process — the desktop-window runtime mode alongside the
// existing (unchanged) `npm run dev`/`start` browser mode. See
// docs/ARCHITECTURE.md's "Running the dashboard" section and
// .pHive/epics/electron-wrapper/docs/design-discussion.md for the full
// rationale.
//
// Non-negotiable architecture: server code never runs inside Electron's own
// main-process runtime. This file only spawns the EXISTING `npm run start`
// script as a genuine child process (the system's own Node, same as
// `npm run dev`/`start` already require today) and points a BrowserWindow
// at it once it's actually ready. This sidesteps ever needing to know
// whether Electron's own bundled Node honors `--experimental-sqlite` the
// same way a plain `node` invocation does — Electron's runtime never loads
// `node:sqlite` at all.
//
// Terminal-launched, not a double-clickable packaged app (explicitly out of
// scope for this story): this process inherits a normal shell's PATH,
// which the spawned child needs to resolve `npm`/`node` and which
// Playwright's Capture Login flow needs for its own browser launch. A
// GUI-launched/packaged app would NOT get this for free.
import { app, BrowserWindow, dialog } from "electron";
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeOnce, resolvePort, ServerReadyTimeoutError, waitForServerReady } from "./server-ready.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let child: ChildProcess | null = null;
let win: BrowserWindow | null = null;

/** Kills the spawned `next start` tree, not just the `npm` wrapper process.
 * `child` is spawned with `detached: true` (see below) specifically so it
 * gets its own process group — `npm run start` itself spawns `next start`
 * as a further child, and signaling only the `npm` pid does not reliably
 * propagate to that grandchild. Signaling the negative pid targets the
 * whole group, so nothing is left squatting on our chosen port for the
 * next launch. Safe to call multiple times (window-all-closed AND before-quit
 * both call this) and safe to call after the child already exited. */
function killChild(): void {
  if (!child || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    child = null;
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Process group may already be gone — nothing left to clean up.
  }
  child = null;
}

function showFatalDialog(title: string, message: string): void {
  dialog.showErrorBox(title, message);
}

async function main(): Promise<void> {
  // Prefer DEFAULT_PORT (or a GIGRADAR_PORT override) -- see resolvePort()'s
  // own doc comment -- but fall back to any OS-assigned free port rather
  // than refusing to start when that preferred port is already held by an
  // unrelated local process. A fallback means Gmail OAuth's registered
  // redirect URI (docs/gmail-oauth-setup.md) won't match this session.
  const { port, usedFallback, preferredPort } = await resolvePort();
  const serverUrl = `http://127.0.0.1:${port}`;

  if (usedFallback) {
    console.warn(
      `gigradar: preferred port ${preferredPort} is already in use by another process on this ` +
        `machine -- using ${port} instead so gigradar can still start. If you use Gmail Connect, ` +
        `its OAuth redirect URI won't match this session; set GIGRADAR_PORT to a port you control ` +
        `and update your Google OAuth client's redirect URI to match (see docs/gmail-oauth-setup.md).`,
    );
  }

  // Pre-flight: if something is already answering on our freshly-chosen
  // port before we've spawned anything of our own, another process grabbed
  // it in the brief window between findFreePort() releasing it and us
  // getting here (or a previous gigradar session left something running).
  // Fail fast with an actionable dialog instead of spawning a second
  // `next start` doomed to fail with EADDRINUSE.
  if (await probeOnce(serverUrl, 500)) {
    showFatalDialog(
      "gigradar — port already in use",
      `Port ${port} became unavailable right after gigradar chose it (e.g. a concurrent ` +
        `process grabbed it, or a previous gigradar Electron session that didn't shut down ` +
        `cleanly).\n\nRelaunch "npm run electron" to try again.`,
    );
    app.quit();
    return;
  }

  child = spawn("npm", ["run", "start"], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  // Keep a bounded tail of stderr so a startup failure's dialog can show
  // something actionable (e.g. the real EADDRINUSE/stack trace) instead of
  // a bare "it didn't start" message. Also mirrored to this process's own
  // stdout/stderr so `npm run electron`'s terminal shows the server's
  // normal logs, same as running `npm run start` directly would.
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  const childExitedEarly = new Promise<never>((_resolve, reject) => {
    child?.once("exit", (code, signal) => {
      reject(new Error(`gigradar server process exited early (code ${code}, signal ${signal}) before becoming ready.`));
    });
  });

  try {
    // Whichever settles first wins: the server actually becoming ready, or
    // the child dying before it ever did (e.g. a real EADDRINUSE that
    // slipped past the pre-flight check's race window, or any other
    // startup crash) — never wait out the full timeout for a child that's
    // already dead.
    await Promise.race([waitForServerReady(serverUrl, { intervalMs: 300, timeoutMs: 30_000 }), childExitedEarly]);
  } catch (err) {
    const isPortConflict = /EADDRINUSE/.test(stderrTail);
    const isTimeout = err instanceof ServerReadyTimeoutError;
    const detail = stderrTail ? `\n\n${stderrTail}` : "";

    if (isPortConflict) {
      showFatalDialog(
        "gigradar — port already in use",
        `Port ${port} became unavailable after gigradar chose it. Relaunch "npm run electron" ` +
          `to try again.${detail}`,
      );
    } else if (isTimeout) {
      showFatalDialog(
        "gigradar — failed to start",
        `gigradar's server did not respond at ${serverUrl} within 30 seconds. It may have ` +
          `failed to start.${detail}`,
      );
    } else {
      showFatalDialog("gigradar — failed to start", `${err instanceof Error ? err.message : String(err)}${detail}`);
    }

    killChild();
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "gigradar",
  });
  win.on("closed", () => {
    win = null;
  });
  await win.loadURL(serverUrl);
}

app.whenReady().then(main);

// Not just the happy-path close event: quitting via the Dock/Cmd+Q on
// macOS fires before-quit without necessarily firing window-all-closed
// first, and vice versa closing the last window doesn't always mean the
// app is quitting on every platform. Both call killChild() (idempotent) so
// the spawned `next start` process is never left orphaned on its chosen
// port regardless of which shutdown path the user takes.
app.on("window-all-closed", () => {
  killChild();
  app.quit();
});

app.on("before-quit", () => {
  killChild();
});
