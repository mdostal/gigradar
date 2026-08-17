import http from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFreePort, probeOnce, resolvePort, ServerReadyTimeoutError, waitForServerReady } from "../server-ready.ts";

// Exercises the port-ready polling/retry logic in isolation against a real
// node:http server standing in for the spawned `next start` child — no
// Electron process involved, matching this story's verification strategy
// ("unit test the port-ready polling/retry logic in isolation ... covers
// the ready-detection and the timeout/conflict-error path without needing
// a real Electron process in the automated suite").

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

/** Starts a bare HTTP server on an OS-assigned free port and returns its
 * `http://127.0.0.1:<port>` URL. */
function startFakeServer(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("probeOnce", () => {
  it("resolves true when something responds", async () => {
    const url = await startFakeServer((_req, res) => res.end("ok"));
    await expect(probeOnce(url)).resolves.toBe(true);
  });

  it("resolves false when nothing is listening on the port", async () => {
    // Reserve a free port, then close the server immediately so the port is
    // (almost certainly) unbound again — nothing answers there.
    const url = await startFakeServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await expect(probeOnce(url, 300)).resolves.toBe(false);
  });
});

describe("waitForServerReady", () => {
  it("detects readiness once the server starts responding, without waiting out the full timeout", async () => {
    // The server doesn't start listening until partway through the poll
    // loop's window — proving this resolves on the first successful probe
    // rather than only after the deadline.
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const url = await startFakeServer((_req, res) => res.end("ready"));

    await waitForServerReady(url, { intervalMs: 50, timeoutMs: 5000 });

    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("resolves on the very first probe when the server is already up", async () => {
    const url = await startFakeServer((_req, res) => res.end("ready"));
    await expect(waitForServerReady(url, { intervalMs: 50, timeoutMs: 5000 })).resolves.toBeUndefined();
  });

  it("times out with ServerReadyTimeoutError when nothing ever responds", async () => {
    // 127.0.0.1 with no listener on this port for the whole test.
    const deadPortUrl = "http://127.0.0.1:1"; // port 1 is a privileged, unbound port — nothing answers here
    const startedAt = Date.now();

    await expect(waitForServerReady(deadPortUrl, { intervalMs: 50, timeoutMs: 300 })).rejects.toThrow(
      ServerReadyTimeoutError,
    );

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(2000);
  });

  it("times out with an actionable message naming the URL and timeout", async () => {
    const deadPortUrl = "http://127.0.0.1:1";
    await expect(waitForServerReady(deadPortUrl, { intervalMs: 50, timeoutMs: 200 })).rejects.toThrow(
      /Timed out after 200ms waiting for http:\/\/127\.0\.0\.1:1 to respond/,
    );
  });
});

describe("findFreePort", () => {
  it("returns a port that is genuinely free to bind on", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);

    // Prove it's really free: bind it ourselves.
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
    });
  });
});

describe("resolvePort", () => {
  const originalGigradarPort = process.env.GIGRADAR_PORT;

  beforeEach(() => {
    delete process.env.GIGRADAR_PORT;
  });

  afterEach(() => {
    if (originalGigradarPort === undefined) delete process.env.GIGRADAR_PORT;
    else process.env.GIGRADAR_PORT = originalGigradarPort;
  });

  it("uses the preferred port when it's free, with usedFallback: false", async () => {
    const preferred = await findFreePort();
    await expect(resolvePort(preferred)).resolves.toEqual({
      port: preferred,
      usedFallback: false,
      preferredPort: preferred,
    });
  });

  it("falls back to a different free port when the preferred one is already taken", async () => {
    const taken = await new Promise<number>((resolve) => {
      server = http.createServer((_req, res) => res.end("busy"));
      server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
    });

    const result = await resolvePort(taken);
    expect(result.usedFallback).toBe(true);
    expect(result.preferredPort).toBe(taken);
    expect(result.port).not.toBe(taken);
  });

  it("prefers GIGRADAR_PORT over the passed-in preferredPort when set", async () => {
    const override = await findFreePort();
    process.env.GIGRADAR_PORT = String(override);

    await expect(resolvePort(1)).resolves.toEqual({
      port: override,
      usedFallback: false,
      preferredPort: override,
    });
  });
});
