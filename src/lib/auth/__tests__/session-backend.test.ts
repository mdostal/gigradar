// Tests for src/lib/auth/session-backend.ts (oauth-session-capture-v2
// epic, portunus-session-backend story). Highest-stakes coverage:
//   1. writeSessionViaPortunus() pipes the session JSON via STDIN --
//      never argv (would leak into `ps`/shell history).
//   2. readSessionViaPortunus() parses Portunus's real envelope shape
//      (`{schema, session, ...}` -- NOT the raw storageState) and returns
//      only the `.session` field.
//   3. readSessionViaPortunus() deletes the tempfile Portunus wrote,
//      immediately after reading it -- on every outcome, including a
//      validation failure.
//   4. isPortunusAvailable() is a real presence/absence check, cached.
//   5. sessionBackendFrom() defaults to "local" and throws on anything
//      other than "local"/"portunus".
// `node:child_process`'s spawn() is fully mocked -- no real portunus
// process. Envelope shape below is the REAL shape live-confirmed against
// portunus 0.19.0 during this story's research step (see
// session-backend.ts's own header comment) -- not guessed.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

/** A fake ChildProcess: real EventEmitter (so "error"/"exit" listeners genuinely fire), with stdin/stdout/stderr as real PassThrough streams so writeSessionViaPortunus()'s stdin.write()/.end() and the stdout/stderr "data" listeners exercise real stream behavior, not a hand-rolled mock. */
function createFakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

/** Simulates a real portunus process exit: pushes stdout/stderr data (if any), then emits "exit" on the next microtask (matches real child_process timing -- listeners attached synchronously after spawn() returns still catch it). */
function finishChild(child: ReturnType<typeof createFakeChildProcess>, opts: { stdout?: string; stderr?: string; code: number }) {
  if (opts.stdout) child.stdout.write(opts.stdout);
  if (opts.stderr) child.stderr.write(opts.stderr);
  queueMicrotask(() => child.emit("exit", opts.code));
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isPortunusAvailable", () => {
  it("resolves true when `portunus --version` exits 0", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    const { isPortunusAvailable } = await import("../session-backend.js");

    const pending = isPortunusAvailable();
    queueMicrotask(() => child.emit("exit", 0));

    expect(await pending).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith("portunus", ["--version"], expect.objectContaining({ stdio: "ignore" }));
  });

  it("resolves false when portunus isn't installed (spawn 'error', e.g. ENOENT)", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { isPortunusAvailable } = await import("../session-backend.js");

    const pending = isPortunusAvailable();
    queueMicrotask(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));

    expect(await pending).toBe(false);
  });

  it("resolves false on a non-zero exit code", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { isPortunusAvailable } = await import("../session-backend.js");

    const pending = isPortunusAvailable();
    queueMicrotask(() => child.emit("exit", 1));

    expect(await pending).toBe(false);
  });

  it("resolves false and kills the child when it hangs past PORTUNUS_AVAILABILITY_TIMEOUT_MS -- real, live-reproduced incident (2026-09-05, v0.35.0 release verification): a genuinely hung 'portunus --version' otherwise wedged every future /config render forever, since the result is cached per-process", async () => {
    vi.useFakeTimers();
    try {
      const child = createFakeChildProcess();
      spawnMock.mockReturnValue(child);
      vi.resetModules();
      const { isPortunusAvailable, PORTUNUS_AVAILABILITY_TIMEOUT_MS } = await import("../session-backend.js");

      const pending = isPortunusAvailable();
      await vi.advanceTimersByTimeAsync(PORTUNUS_AVAILABILITY_TIMEOUT_MS);

      expect(await pending).toBe(false);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches the result -- a second call does not spawn a second process", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { isPortunusAvailable } = await import("../session-backend.js");

    const first = isPortunusAvailable();
    queueMicrotask(() => child.emit("exit", 0));
    await first;

    await isPortunusAvailable();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("sessionBackendFrom", () => {
  it('defaults to "local" when settings.sessionBackend is absent', async () => {
    const { sessionBackendFrom } = await import("../session-backend.js");
    expect(sessionBackendFrom({ id: "gofractional", enabled: true })).toBe("local");
    expect(sessionBackendFrom({ id: "gofractional", enabled: true, settings: {} })).toBe("local");
  });

  it('returns "local"/"portunus" verbatim when explicitly set', async () => {
    const { sessionBackendFrom } = await import("../session-backend.js");
    expect(sessionBackendFrom({ id: "gofractional", enabled: true, settings: { sessionBackend: "local" } })).toBe("local");
    expect(sessionBackendFrom({ id: "gofractional", enabled: true, settings: { sessionBackend: "portunus" } })).toBe("portunus");
  });

  it("throws a specific error for an unrecognized value -- never silently treats it as local", async () => {
    const { sessionBackendFrom } = await import("../session-backend.js");
    expect(() => sessionBackendFrom({ id: "gofractional", enabled: true, settings: { sessionBackend: "cloud" } })).toThrow(
      /unrecognized settings\.sessionBackend/,
    );
  });
});

const SAMPLE_STORAGE_STATE = {
  cookies: [
    { name: "session", value: "abc123", domain: "gofractional.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const },
  ],
  origins: [],
};

describe("writeSessionViaPortunus", () => {
  it("spawns `portunus session store <site> <account> --ttl-seconds <n> --stdin` and pipes the JSON via stdin -- never argv", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { writeSessionViaPortunus } = await import("../session-backend.js");

    let stdinReceived = "";
    child.stdin.on("data", (chunk: Buffer) => {
      stdinReceived += chunk.toString("utf8");
    });

    const pending = writeSessionViaPortunus("gofractional", "gigradar", SAMPLE_STORAGE_STATE, 7776000);
    finishChild(child, { code: 0 });
    await pending;

    expect(spawnMock).toHaveBeenCalledWith(
      "portunus",
      ["session", "store", "gofractional", "gigradar", "--ttl-seconds", "7776000", "--stdin"],
      expect.objectContaining({ stdio: ["pipe", "ignore", "pipe"] }),
    );
    // Every spawn() arg is a fixed flag or a plain site/account/ttl string --
    // the session JSON itself never appears in argv.
    const argv = spawnMock.mock.calls[0]?.[1] as string[];
    expect(argv.some((a) => a.includes("abc123"))).toBe(false);
    expect(JSON.parse(stdinReceived)).toEqual(SAMPLE_STORAGE_STATE);
  });

  it("rejects with portunus's own stderr on a non-zero exit", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { writeSessionViaPortunus } = await import("../session-backend.js");

    const pending = writeSessionViaPortunus("gofractional", "gigradar", SAMPLE_STORAGE_STATE, 60);
    finishChild(child, { code: 1, stderr: "portunus: something went wrong" });

    await expect(pending).rejects.toThrow(/portunus session store.*failed.*portunus: something went wrong/s);
  });

  it("rejects with a specific error if portunus isn't installed (spawn 'error')", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { writeSessionViaPortunus } = await import("../session-backend.js");

    const pending = writeSessionViaPortunus("gofractional", "gigradar", SAMPLE_STORAGE_STATE, 60);
    queueMicrotask(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));

    await expect(pending).rejects.toThrow(/failed to spawn portunus/);
  });
});

describe("readSessionViaPortunus", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-portunus-test-")), "portunus-session-fake");
  });

  it("parses the REAL portunus envelope shape and returns only the .session field, then deletes the tempfile", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { readSessionViaPortunus } = await import("../session-backend.js");

    const envelope = {
      schema: "portunus.session.v1",
      namespace: { site: "gofractional", account: "gigradar" },
      ttl: { seconds: 7776000, expires_at: "2027-01-01T00:00:00Z" },
      rotation: { generation: 1, interval_seconds: null, last_rotated_at: "2026-08-15T00:00:00Z", rotate_after: null },
      session: SAMPLE_STORAGE_STATE,
    };
    fs.writeFileSync(tmpFile, JSON.stringify(envelope));

    const pending = readSessionViaPortunus("gofractional", "gigradar");
    finishChild(child, { code: 0, stdout: tmpFile });

    const result = await pending;
    expect(result).toEqual(SAMPLE_STORAGE_STATE);
    expect(spawnMock).toHaveBeenCalledWith("portunus", ["session", "load", "gofractional", "gigradar"], expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }));
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('rejects with portunus\'s own "unknown secret" stderr when nothing is stored, without ever reading a tempfile', async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { readSessionViaPortunus } = await import("../session-backend.js");

    const pending = readSessionViaPortunus("gofractional", "nonexistent-account");
    finishChild(child, { code: 1, stderr: "portunus: unknown secret: session:gofractional:nonexistent-account" });

    await expect(pending).rejects.toThrow(/unknown secret: session:gofractional:nonexistent-account/);
  });

  it("rejects and still deletes the tempfile when the envelope's schema is unexpected", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { readSessionViaPortunus } = await import("../session-backend.js");

    fs.writeFileSync(tmpFile, JSON.stringify({ schema: "some.other.schema.v9", session: SAMPLE_STORAGE_STATE }));

    const pending = readSessionViaPortunus("gofractional", "gigradar");
    finishChild(child, { code: 0, stdout: tmpFile });

    await expect(pending).rejects.toThrow(/unexpected envelope shape/);
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it("rejects and still deletes the tempfile when .session doesn't match the storageState shape", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValue(child);
    vi.resetModules();
    const { readSessionViaPortunus } = await import("../session-backend.js");

    fs.writeFileSync(tmpFile, JSON.stringify({ schema: "portunus.session.v1", session: { notCookiesOrOrigins: true } }));

    const pending = readSessionViaPortunus("gofractional", "gigradar");
    finishChild(child, { code: 0, stdout: tmpFile });

    await expect(pending).rejects.toThrow(/does not match the expected storageState shape/);
    expect(fs.existsSync(tmpFile)).toBe(false);
  });
});
