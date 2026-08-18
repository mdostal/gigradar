// Pure, Electron-free port-readiness polling logic — deliberately kept in
// its own module (no "electron" import anywhere in this file) so it can be
// unit-tested against a plain node:http server in the automated suite,
// with no real Electron process needed. main.ts wires this up to the
// spawned `next start` child and the native dialog/BrowserWindow.
import { connect, createServer } from "node:net";

/**
 * Asks the OS for a free TCP port (bind to port 0, read back what it
 * assigned, then close) rather than hardcoding one -- a hardcoded 3000
 * collides with anything else already using that port (a dev server,
 * another local app, etc.), which failed this app's own startup outright
 * with no workaround short of freeing the port. Mirrors src-tauri/src/lib.rs's
 * find_free_port() -- same reasoning, same small accepted TOCTOU race
 * between closing this probe socket and the real server binding the same
 * port, acceptable for this app's single-user desktop context.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("gigradar: could not read back the assigned port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** gigradar's documented default port (docs/gmail-oauth-setup.md tells users to
 * register their Google OAuth client's redirect URI against this port) -- kept
 * as a PREFERENCE, not a hard requirement, so an install still starts even when
 * something else on the machine already holds it. */
export const DEFAULT_PORT = 3000;

/**
 * True if `port` is currently free -- checked via a CONNECT attempt, never
 * a bind attempt. `net.createServer().listen()` binds with `SO_REUSEADDR`
 * by Node's own default, which lets a second bind to an already-actively-
 * listening port SUCCEED -- live-verified on a real always-on local
 * service already bound to port 3000: `listen(3000, "127.0.0.1")` fired
 * its success callback even though something else was actively serving
 * that port, a false "free" positive that sent gigradar's own server to
 * port 3000 while a DIFFERENT app was already answering there -- the
 * app window ended up loading that other app's page instead of gigradar's
 * own. A connect attempt has no such false positive: a live listener
 * always accepts the connection; a genuinely free port always refuses it
 * (`ECONNREFUSED`).
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

export interface ResolvedPort {
  port: number;
  /** True when `preferredPort` (or a `GIGRADAR_PORT` override) was unavailable
   * and a random free port was substituted instead -- callers should warn the
   * user, since Gmail OAuth's redirect URI is only valid for a fixed, ahead-of-time
   * registered port and won't match a fallback. */
  usedFallback: boolean;
  /** The port that was actually tried first (the `GIGRADAR_PORT` override, if
   * set, otherwise `preferredPort`). */
  preferredPort: number;
}

/** Prefers `GIGRADAR_PORT` (if set) or `preferredPort` (DEFAULT_PORT by
 * default) so a stable, once-registered Gmail OAuth redirect URI keeps
 * working across launches -- but falls back to any OS-assigned free port
 * rather than refusing to start at all when the preferred port is already
 * held by some other local process (e.g. an unrelated service that also
 * happens to use it). */
export async function resolvePort(preferredPort: number = DEFAULT_PORT): Promise<ResolvedPort> {
  const envOverride = process.env.GIGRADAR_PORT ? Number(process.env.GIGRADAR_PORT) : undefined;
  const wanted = envOverride && Number.isFinite(envOverride) ? envOverride : preferredPort;

  if (await isPortFree(wanted)) {
    return { port: wanted, usedFallback: false, preferredPort: wanted };
  }
  const fallback = await findFreePort();
  return { port: fallback, usedFallback: true, preferredPort: wanted };
}

/** Thrown by `waitForServerReady` when the deadline passes with no
 * successful response. Distinguished from a generic Error so callers (e.g.
 * main.ts) can tell "never came up in time" apart from other failures. */
export class ServerReadyTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for ${url} to respond`);
    this.name = "ServerReadyTimeoutError";
  }
}

export interface WaitForServerReadyOptions {
  /** Delay between poll attempts. */
  intervalMs?: number;
  /** Total time budget before giving up — the "clear timeout ceiling" the
   * story calls for, so a server that never comes up doesn't hang forever. */
  timeoutMs?: number;
}

/** Best-effort single probe: resolves `true` if `url` responds to an HTTP
 * request at all (any status code counts — this only asks "is something
 * listening", not "is the response 200"), `false` on any network error or
 * timeout. Never throws. */
export async function probeOnce(url: string, requestTimeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
    // Drain/close the body so repeated polling doesn't leak sockets.
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Poll `url` on a fixed interval (bounded retry loop) until it responds or
 * `timeoutMs` elapses. Resolves on the first successful response; rejects
 * with `ServerReadyTimeoutError` once the deadline passes. */
export async function waitForServerReady(url: string, options: WaitForServerReadyOptions = {}): Promise<void> {
  const { intervalMs = 300, timeoutMs = 30_000 } = options;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await probeOnce(url, Math.min(intervalMs, 2000))) return;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new ServerReadyTimeoutError(url, timeoutMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
