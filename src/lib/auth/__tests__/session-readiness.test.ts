// Tests for src/lib/auth/session-readiness.ts (stale-pages-and-source-status
// epic, source-login-status-badge story).
//
// checkSessionReadiness() is deliberately NOT tested against a mocked
// readStorageStateFile() for the local-backend "connected" case -- this
// story's own implementation caught a real bug during development (a naive
// raw fs.readFileSync()+JSON.parse() would misreport every legitimately
// ENCRYPTED session file as "needs-login", since session files are
// encrypted at rest via vault.ts, same as config.json). Proving that bug
// class stays fixed requires a REAL encrypted file on a REAL isolated
// filesystem, not a mock that could silently paper over the same mistake
// resurfacing later. Portunus is mocked (its own subprocess mechanics are
// already covered by session-backend.test.ts) -- this suite's job is only to
// verify checkSessionReadiness() dispatches to it correctly and maps
// success/failure to the right readiness state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { checkSessionReadiness } from "../session-readiness.js";
import { writeStorageStateAtomically } from "../session-capture.js";
import type { SourceConfig } from "../../types.js";

let tmpDataDir: string;
let tmpKeyDir: string;

beforeEach(() => {
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-session-readiness-test-"));
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-session-readiness-test-key-"));
  process.env.XDG_DATA_HOME = tmpDataDir;
  process.env.XDG_CONFIG_HOME = tmpKeyDir;
  spawnMock.mockReset();
});

afterEach(() => {
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.rmSync(tmpKeyDir, { recursive: true, force: true });
});

describe("checkSessionReadiness: sources that don't need login at all", () => {
  it("returns no-login-needed for a source with no browser-session auth of any kind", async () => {
    const cfg: SourceConfig = { id: "braintrust", enabled: true };
    expect(await checkSessionReadiness(cfg)).toBe("no-login-needed");
  });

  it("returns no-login-needed for a custom-llm source with customAuth omitted", async () => {
    const cfg: SourceConfig = { id: "monster", enabled: true, kind: "custom-llm", settings: { url: "https://example.com" } };
    expect(await checkSessionReadiness(cfg)).toBe("no-login-needed");
  });
});

describe("checkSessionReadiness: local backend", () => {
  it('returns "connected" for a hand-written adapter (gofractional -- registered in SOURCE_ORIGINS) with a real, encrypted, valid session file on disk', async () => {
    const cfg: SourceConfig = { id: "gofractional", enabled: true };
    const filePath = path.join(tmpDataDir, "gigradar", "gofractional-session.json");
    writeStorageStateAtomically(filePath, { cookies: [], origins: [] });

    expect(await checkSessionReadiness(cfg)).toBe("connected");
  });

  it('returns "connected" for a custom-llm source with customAuth:"browser-session" and a real session file', async () => {
    const cfg: SourceConfig = { id: "gun-io", enabled: true, kind: "custom-llm", settings: { url: "https://app.gun.io/", customAuth: "browser-session" } };
    const filePath = path.join(tmpDataDir, "gigradar", "gun-io-session.json");
    writeStorageStateAtomically(filePath, { cookies: [], origins: [] });

    expect(await checkSessionReadiness(cfg)).toBe("connected");
  });

  it('returns "needs-login" when no session file exists yet (e.g. wellfound before Capture Login)', async () => {
    const cfg: SourceConfig = { id: "wellfound", enabled: true };
    expect(await checkSessionReadiness(cfg)).toBe("needs-login");
  });

  it('returns "needs-login" (never throws) when the session file exists but is not valid JSON', async () => {
    const cfg: SourceConfig = { id: "gofractional", enabled: true };
    const filePath = path.join(tmpDataDir, "gigradar", "gofractional-session.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not valid json");

    await expect(checkSessionReadiness(cfg)).resolves.toBe("needs-login");
  });

  it('returns "needs-login" (never "connected") when the file parses but is the wrong shape', async () => {
    const cfg: SourceConfig = { id: "gofractional", enabled: true };
    const filePath = path.join(tmpDataDir, "gigradar", "gofractional-session.json");
    writeStorageStateAtomically(filePath, { notASession: true } as never);

    expect(await checkSessionReadiness(cfg)).toBe("needs-login");
  });
});

describe("checkSessionReadiness: portunus backend", () => {
  /** Simulates a real portunus process exit -- same shape session-backend.test.ts's own helper uses. */
  function fakeChild(stdout: string, exitCode: number) {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const child = {
      stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { if (event === "data") cb(Buffer.from(stdout)); } },
      stderr: { on: () => {} },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        (listeners[event] ??= []).push(cb);
        if (event === "exit") queueMicrotask(() => cb(exitCode));
      },
    };
    return child;
  }

  it('returns "connected" when readSessionViaPortunus resolves', async () => {
    const cfg: SourceConfig = {
      id: "gun-io",
      enabled: true,
      kind: "custom-llm",
      settings: { url: "https://app.gun.io/", customAuth: "browser-session", sessionBackend: "portunus" },
    };
    const tmpFile = path.join(tmpDataDir, "portunus-fake-tempfile.json");
    fs.writeFileSync(tmpFile, JSON.stringify({ schema: "portunus.session.v1", session: { cookies: [], origins: [] } }));
    spawnMock.mockReturnValue(fakeChild(tmpFile, 0));

    expect(await checkSessionReadiness(cfg)).toBe("connected");
  });

  it('returns "needs-login" (never throws) when readSessionViaPortunus rejects -- e.g. no session stored yet', async () => {
    const cfg: SourceConfig = {
      id: "wellfound",
      enabled: true,
      settings: { sessionBackend: "portunus" },
    };
    spawnMock.mockReturnValue(fakeChild("", 1));

    await expect(checkSessionReadiness(cfg)).resolves.toBe("needs-login");
  });
});
