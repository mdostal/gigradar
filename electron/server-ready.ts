// Pure, Electron-free port-readiness polling logic — deliberately kept in
// its own module (no "electron" import anywhere in this file) so it can be
// unit-tested against a plain node:http server in the automated suite,
// with no real Electron process needed. main.ts wires this up to the
// spawned `next start` child and the native dialog/BrowserWindow.

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
