import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, isEncryptedEnvelope } from "../../security/vault.js";
import { readEnvVar, setEnvVar } from "../env-store.js";
import { getEnvPath } from "../load.js";

// Same isolation pattern as load.test.ts / save.test.ts: every test points
// XDG_DATA_HOME (.env's location) AND XDG_CONFIG_HOME (the vault key's
// location — a deliberately separate directory tree, see key-path.ts) at
// fresh temp dirs, so this suite never touches a real user's actual XDG
// dirs and each test is fully isolated from the others.
let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-env-store-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-env-store-test-key-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
});

afterEach(() => {
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Writes `contents` to .env as a legacy PLAINTEXT fixture (the pre-encryption on-disk format). */
function writePlaintextEnv(contents: string, mode = 0o600): void {
  const envPath = getEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, contents);
  fs.chmodSync(envPath, mode);
}

/** Ensures the vault key exists under the current (test-isolated) XDG_CONFIG_HOME, for fixtures that need to encrypt() ahead of a test. Mirrors load.test.ts's/save.test.ts's own helper. */
function getOrCreateKeyForTest(): void {
  const keyPath = path.join(keyTmpDir, "gigradar", "key");
  if (fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
}

/** Writes `contents` to .env as an already-encrypted vault envelope. */
function writeEncryptedEnv(contents: string, mode = 0o600): void {
  getOrCreateKeyForTest();
  const envPath = getEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, encrypt(contents));
  fs.chmodSync(envPath, mode);
}

describe("setEnvVar + readEnvVar: round trip against a fresh XDG dir (AC1)", () => {
  it("given no .env yet, setEnvVar() followed by readEnvVar() for the same var returns the exact value written, and the on-disk .env is an encrypted envelope, never plaintext", () => {
    expect(fs.existsSync(getEnvPath())).toBe(false);

    const result = setEnvVar("ANTHROPIC_API_KEY", "sk-ant-test-value-123");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(getEnvPath())).toBe(true);
    const raw = fs.readFileSync(getEnvPath(), "utf8");
    expect(isEncryptedEnvelope(raw)).toBe(true);
    expect(raw).not.toContain("sk-ant-test-value-123");
    expect(raw).not.toContain("ANTHROPIC_API_KEY");

    expect(readEnvVar("ANTHROPIC_API_KEY")).toBe("sk-ant-test-value-123");
  });

  it("sets mode 0600 (owner-only) on the newly written .env file", () => {
    setEnvVar("ANTHROPIC_API_KEY", "value");

    const mode = fs.statSync(getEnvPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("setEnvVar: preserves other vars already present (AC2)", () => {
  it("given an existing LEGACY PLAINTEXT .env with other vars, after setEnvVar() the other vars are preserved AND the file is now encrypted", () => {
    writePlaintextEnv("BRAINTRUST_API_KEY=existing-value\nOTHER_VAR=another-value\n");
    expect(isEncryptedEnvelope(fs.readFileSync(getEnvPath(), "utf8"))).toBe(false);

    const result = setEnvVar("ANTHROPIC_API_KEY", "new-value");

    expect(result.ok).toBe(true);
    const raw = fs.readFileSync(getEnvPath(), "utf8");
    expect(isEncryptedEnvelope(raw)).toBe(true);

    const decrypted = decrypt(raw);
    expect(decrypted).toContain("BRAINTRUST_API_KEY=existing-value");
    expect(decrypted).toContain("OTHER_VAR=another-value");
    expect(decrypted).toContain("ANTHROPIC_API_KEY=new-value");

    expect(readEnvVar("BRAINTRUST_API_KEY")).toBe("existing-value");
    expect(readEnvVar("OTHER_VAR")).toBe("another-value");
    expect(readEnvVar("ANTHROPIC_API_KEY")).toBe("new-value");
  });

  it("preserves other vars already present in an ALREADY-ENCRYPTED .env too", () => {
    writeEncryptedEnv("BRAINTRUST_API_KEY=existing-value\n");

    const result = setEnvVar("ANTHROPIC_API_KEY", "new-value");

    expect(result.ok).toBe(true);
    expect(readEnvVar("BRAINTRUST_API_KEY")).toBe("existing-value");
    expect(readEnvVar("ANTHROPIC_API_KEY")).toBe("new-value");
  });

  it("overwrites an existing value for the same var name (a second setEnvVar() call for the same key replaces it, not appends)", () => {
    setEnvVar("ANTHROPIC_API_KEY", "first-value");

    const result = setEnvVar("ANTHROPIC_API_KEY", "second-value");

    expect(result.ok).toBe(true);
    expect(readEnvVar("ANTHROPIC_API_KEY")).toBe("second-value");
    const decrypted = decrypt(fs.readFileSync(getEnvPath(), "utf8"));
    expect((decrypted.match(/ANTHROPIC_API_KEY=/g) ?? []).length).toBe(1);
  });
});

describe("readEnvVar: fresh reads, never mutates process.env", () => {
  it("returns undefined for a var not present in .env", () => {
    setEnvVar("ANTHROPIC_API_KEY", "value");

    expect(readEnvVar("SOME_OTHER_VAR")).toBeUndefined();
  });

  it("returns undefined when .env does not exist at all, rather than throwing", () => {
    expect(fs.existsSync(getEnvPath())).toBe(false);

    expect(readEnvVar("ANTHROPIC_API_KEY")).toBeUndefined();
  });

  it("never populates process.env as a side effect of setEnvVar() or readEnvVar()", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    setEnvVar("ANTHROPIC_API_KEY", "value-for-process-env-check");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    readEnvVar("ANTHROPIC_API_KEY");
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("setEnvVar / readEnvVar: never log the name or value being set or read (AC8)", () => {
  it("does not console.log/warn/error the var name or value on setEnvVar()", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setEnvVar("ANTHROPIC_API_KEY", "top-secret-value-should-not-log");

    const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(allOutput).not.toContain("top-secret-value-should-not-log");
    expect(allOutput).not.toContain("ANTHROPIC_API_KEY");
  });

  it("does not console.log/warn/error the var name or value on readEnvVar()", () => {
    setEnvVar("ANTHROPIC_API_KEY", "another-secret-value");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    readEnvVar("ANTHROPIC_API_KEY");

    const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(allOutput).not.toContain("another-secret-value");
    expect(allOutput).not.toContain("ANTHROPIC_API_KEY");
  });

  it("a tamper-error thrown from setEnvVar() names the .env path but never any value", () => {
    writeEncryptedEnv("BRAINTRUST_API_KEY=existing-value\n");
    const envPath = getEnvPath();
    const envelope = JSON.parse(fs.readFileSync(envPath, "utf8"));
    const dataBuf = Buffer.from(envelope.data, "base64");
    const first = dataBuf[0];
    if (first === undefined) throw new Error("test fixture: unexpectedly empty ciphertext");
    dataBuf[0] = first ^ 0xff;
    envelope.data = dataBuf.toString("base64");
    fs.writeFileSync(envPath, JSON.stringify(envelope));

    const result = setEnvVar("ANTHROPIC_API_KEY", "new-value-should-not-leak");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain(envPath);
    expect(result.error).not.toContain("existing-value");
    expect(result.error).not.toContain("new-value-should-not-leak");
  });
});
