import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeyPath } from "../key-path.js";
import { VaultKeyLostError, VaultTamperError, decrypt, encrypt, getOrCreateKey, isEncryptedEnvelope } from "../vault.js";

// Every test points XDG_CONFIG_HOME at a fresh temp dir so the vault key
// file is fully isolated from any real user's ~/.config/gigradar/key AND
// from every other test — vault.ts is deliberately stateless (no
// module-level key cache, see vault.ts's header comment), so pointing the
// env var at a fresh directory per test is sufficient isolation, with no
// leftover in-memory state to reset.
let tmpDir: string;
let originalXdgConfigHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-vault-test-"));
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Creates a fresh key for the current XDG_CONFIG_HOME (true-first-run path). */
function createKey(): Buffer {
  return getOrCreateKey(() => false);
}

/** Returns a copy of `buf` with its first byte XOR-flipped, for tamper tests. */
function flipFirstByte(buf: Buffer): Buffer {
  const copy = Buffer.from(buf);
  const first = copy[0];
  if (first === undefined) throw new Error("test fixture buffer is unexpectedly empty");
  copy[0] = first ^ 0xff;
  return copy;
}

describe("encrypt() / decrypt(): round trip", () => {
  it("returns the exact original plaintext after encrypt() then decrypt()", () => {
    createKey();
    const plaintext = 'a realistic secret: {"apiKey":"sk-abc123","note":"don\'t log me"}';

    const envelope = encrypt(plaintext);
    const result = decrypt(envelope);

    expect(result).toBe(plaintext);
  });

  it("round-trips the empty string", () => {
    createKey();

    expect(decrypt(encrypt(""))).toBe("");
  });

  it("round-trips multi-byte unicode content correctly", () => {
    createKey();
    const plaintext = "unicode: café, 日本語, 😀";

    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it("produces a JSON envelope with the exact {v, iv, tag, data} shape", () => {
    createKey();

    const envelope = JSON.parse(encrypt("hello")) as Record<string, unknown>;

    expect(Object.keys(envelope).sort()).toEqual(["data", "iv", "tag", "v"]);
    expect(envelope.v).toBe(1);
    expect(typeof envelope.iv).toBe("string");
    expect(typeof envelope.tag).toBe("string");
    expect(typeof envelope.data).toBe("string");
  });

  it("uses a fresh, unique 12-byte IV on every call, even for identical plaintext (never IV reuse under the same key)", () => {
    createKey();

    const envelopeA = JSON.parse(encrypt("same plaintext")) as { iv: string; data: string };
    const envelopeB = JSON.parse(encrypt("same plaintext")) as { iv: string; data: string };

    expect(Buffer.from(envelopeA.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(envelopeB.iv, "base64")).toHaveLength(12);
    expect(envelopeA.iv).not.toBe(envelopeB.iv);
    // Same plaintext + different IV must also produce different ciphertext.
    expect(envelopeA.data).not.toBe(envelopeB.data);
  });

  it("encrypt() throws a clear error, and never creates a key, if called before any key exists", () => {
    // No createKey() call — the key file genuinely does not exist yet.
    expect(() => encrypt("secret")).toThrow(/vault key not found/i);
    expect(fs.existsSync(getKeyPath())).toBe(false);
  });
});

describe("decrypt(): tamper detection", () => {
  it("throws a specific, distinctly-identifiable tamper error when a byte in the DECODED ciphertext is flipped and re-encoded", () => {
    createKey();
    const envelope = JSON.parse(encrypt("sensitive plaintext")) as {
      v: number;
      iv: string;
      tag: string;
      data: string;
    };

    // Decode the base64 `data` field to raw ciphertext bytes, flip one bit,
    // then re-encode — per the design doc's verification plan, this
    // exercises GCM's auth-tag check itself rather than risking a
    // different (less meaningful) base64-decode failure that a naive
    // JSON/base64-TEXT byte flip could trigger instead.
    const rawCiphertext = flipFirstByte(Buffer.from(envelope.data, "base64"));
    const tamperedEnvelope = { ...envelope, data: rawCiphertext.toString("base64") };

    expect(() => decrypt(JSON.stringify(tamperedEnvelope))).toThrow(VaultTamperError);
    // Distinctly different from a generic parse failure: verify the actual
    // thrown error is the tamper type, not merely "throws something".
    try {
      decrypt(JSON.stringify(tamperedEnvelope));
      expect.unreachable("decrypt() should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultTamperError);
      expect((e as Error).message).toMatch(/corrupted or has been tampered with/i);
    }
  });

  it("throws the same specific tamper error when a byte in the DECODED auth tag is flipped and re-encoded", () => {
    createKey();
    const envelope = JSON.parse(encrypt("sensitive plaintext")) as {
      v: number;
      iv: string;
      tag: string;
      data: string;
    };

    const rawTag = flipFirstByte(Buffer.from(envelope.tag, "base64"));
    const tamperedEnvelope = { ...envelope, tag: rawTag.toString("base64") };

    expect(() => decrypt(JSON.stringify(tamperedEnvelope))).toThrow(VaultTamperError);
  });

  it("throws a DIFFERENT, non-tamper error for input that is simply not valid JSON", () => {
    createKey();

    expect(() => decrypt("not json at all {{{")).toThrow(Error);
    try {
      decrypt("not json at all {{{");
      expect.unreachable("decrypt() should have thrown");
    } catch (e) {
      expect(e).not.toBeInstanceOf(VaultTamperError);
    }
  });

  it("throws a DIFFERENT, non-tamper error for valid JSON that doesn't match the envelope shape", () => {
    createKey();

    expect(() => decrypt(JSON.stringify({ hello: "world" }))).toThrow(Error);
    try {
      decrypt(JSON.stringify({ hello: "world" }));
      expect.unreachable("decrypt() should have thrown");
    } catch (e) {
      expect(e).not.toBeInstanceOf(VaultTamperError);
    }
  });

  it("throws the tamper error (not a crash/undefined behavior) when the IV itself is corrupted", () => {
    createKey();
    const envelope = JSON.parse(encrypt("sensitive plaintext")) as {
      v: number;
      iv: string;
      tag: string;
      data: string;
    };

    const rawIv = flipFirstByte(Buffer.from(envelope.iv, "base64"));
    const tamperedEnvelope = { ...envelope, iv: rawIv.toString("base64") };

    expect(() => decrypt(JSON.stringify(tamperedEnvelope))).toThrow(VaultTamperError);
  });
});

describe("getOrCreateKey(): first-run vs key-loss branch logic", () => {
  it("given no key file and hasAnyEncryptedFileFn() => false, generates a new 32-byte key, writes it to getKeyPath() with mode 0600, and returns it", () => {
    const keyPath = getKeyPath();
    expect(fs.existsSync(keyPath)).toBe(false);

    const key = getOrCreateKey(() => false);

    expect(key).toBeInstanceOf(Buffer);
    expect(key).toHaveLength(32);
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.readFileSync(keyPath)).toHaveLength(32);
    expect(fs.readFileSync(keyPath).equals(key)).toBe(true);

    const mode = fs.statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("given no key file and hasAnyEncryptedFileFn() => true, throws a specific key-lost error naming what's unreadable and what to do next, and writes NOTHING", () => {
    const keyPath = getKeyPath();

    expect(() => getOrCreateKey(() => true)).toThrow(VaultKeyLostError);
    try {
      getOrCreateKey(() => true);
      expect.unreachable("getOrCreateKey() should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultKeyLostError);
      const message = (e as Error).message;
      // Names the situation and gives actionable next steps.
      expect(message).toMatch(/unreadable|permanently/i);
      expect(message).toMatch(/re-run config setup|re-capture/i);
    }

    // Never silently mints a replacement key on this branch.
    expect(fs.existsSync(keyPath)).toBe(false);
  });

  it("given an existing key file, returns the exact same key bytes on every call, regardless of hasAnyEncryptedFileFn()'s return value", () => {
    const originalKey = getOrCreateKey(() => false);

    const secondCall = getOrCreateKey(() => true); // must NOT throw — key exists, callback is irrelevant now.
    const thirdCall = getOrCreateKey(() => false);

    expect(secondCall.equals(originalKey)).toBe(true);
    expect(thirdCall.equals(originalKey)).toBe(true);
  });

  it("does not call hasAnyEncryptedFileFn() at all when the key file already exists (the callback is only consulted on the missing-key path)", () => {
    getOrCreateKey(() => false);
    let called = false;

    getOrCreateKey(() => {
      called = true;
      return false;
    });

    expect(called).toBe(false);
  });
});

describe("isEncryptedEnvelope()", () => {
  const REAL_CONFIG_JSON = JSON.stringify(
    {
      profile: {
        name: "Ada",
        roles: ["Fractional CTO"],
        skills: ["TypeScript", "Architecture"],
        timezone: "America/Chicago",
      },
      needs: {
        minRate: 150,
        highRate: 250,
        maxHours: 20,
        maxHoursAtHighRate: 40,
        allowContractToHire: false,
        freshStageOnly: true,
        remoteOnly: true,
      },
      sources: [{ id: "braintrust", enabled: true }],
      roleArea: { coreTitles: ["CTO"], keywords: ["fractional"], redKeywords: ["junior"] },
      schedule: "0 9 * * *",
    },
    null,
    2,
  );

  const REAL_STORAGE_STATE_JSON = JSON.stringify(
    {
      cookies: [
        {
          name: "session",
          value: "target-session-value",
          domain: ".targetsource.example",
          path: "/",
          expires: 1999999999,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [
        {
          origin: "https://app.targetsource.example",
          localStorage: [{ name: "token", value: "target-local-storage-token" }],
        },
      ],
    },
    null,
    2,
  );

  it("returns false, false, true for real config.json content, real storageState content, and a valid encrypted envelope respectively", () => {
    createKey();
    const validEnvelope = encrypt("some plaintext");

    expect(isEncryptedEnvelope(REAL_CONFIG_JSON)).toBe(false);
    expect(isEncryptedEnvelope(REAL_STORAGE_STATE_JSON)).toBe(false);
    expect(isEncryptedEnvelope(validEnvelope)).toBe(true);
  });

  it("returns false for non-JSON plaintext", () => {
    expect(isEncryptedEnvelope("this is not JSON at all")).toBe(false);
    expect(isEncryptedEnvelope("")).toBe(false);
  });

  it("returns false for valid JSON missing a required envelope field", () => {
    expect(isEncryptedEnvelope(JSON.stringify({ v: 1, iv: "AAAA", tag: "BBBB" }))).toBe(false);
  });

  it("returns false for valid JSON with an extra, unexpected field alongside the correct shape", () => {
    expect(isEncryptedEnvelope(JSON.stringify({ v: 1, iv: "AAAA", tag: "BBBB", data: "CCCC", extra: "nope" }))).toBe(
      false,
    );
  });

  it("returns false when field types don't match (e.g. v as a string, or iv as a number)", () => {
    expect(isEncryptedEnvelope(JSON.stringify({ v: "1", iv: "AAAA", tag: "BBBB", data: "CCCC" }))).toBe(false);
    expect(isEncryptedEnvelope(JSON.stringify({ v: 1, iv: 1234, tag: "BBBB", data: "CCCC" }))).toBe(false);
  });

  it("returns false for a JSON array or a JSON primitive, even though both are valid JSON", () => {
    expect(isEncryptedEnvelope(JSON.stringify([1, 2, 3]))).toBe(false);
    expect(isEncryptedEnvelope(JSON.stringify("just a string"))).toBe(false);
    expect(isEncryptedEnvelope(JSON.stringify(42))).toBe(false);
    expect(isEncryptedEnvelope(JSON.stringify(null))).toBe(false);
  });
});

// Story: windows-key-data-separation (.pHive/epics/security-hardening/
// stories/windows-key-data-separation.yaml) / grill finding H2. The
// fallback-path fix (key-path.test.ts) can't catch a user who explicitly
// sets XDG_CONFIG_HOME and XDG_DATA_HOME to the SAME value themselves —
// that's their own configuration choice, so getOrCreateKey() logs a
// one-time, non-blocking warning instead of throwing. Each test here uses
// vi.resetModules() + a fresh dynamic import of vault.ts so the
// once-per-process warned flag (module-scoped state in vault.ts) starts
// clean, regardless of what earlier tests in this file already triggered.
describe("getOrCreateKey(): key/data directory collision warning", () => {
  it("logs a one-time warning (never a thrown error) when XDG_CONFIG_HOME and XDG_DATA_HOME are both set to the SAME value", async () => {
    process.env.XDG_DATA_HOME = tmpDir; // same value as XDG_CONFIG_HOME (set in the file-level beforeEach above)

    vi.resetModules();
    const freshVault = await import("../vault.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    let key: Buffer | undefined;
    expect(() => {
      key = freshVault.getOrCreateKey(() => false);
    }).not.toThrow();

    expect(key).toBeInstanceOf(Buffer); // the warning never blocks the actual key resolution
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/key directory and data directory are the same/i);

    warnSpy.mockRestore();
    delete process.env.XDG_DATA_HOME;
  });

  it("warns only ONCE per process even across multiple getOrCreateKey() calls with the same colliding directories", async () => {
    process.env.XDG_DATA_HOME = tmpDir;

    vi.resetModules();
    const freshVault = await import("../vault.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    freshVault.getOrCreateKey(() => false); // true-first-run branch: creates the key file
    freshVault.getOrCreateKey(() => false); // existing-key branch, called twice more
    freshVault.getOrCreateKey(() => false);

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
    delete process.env.XDG_DATA_HOME;
  });

  it("does NOT warn when the key and data directories are genuinely different (the normal, correctly-separated case)", async () => {
    delete process.env.XDG_DATA_HOME; // resolves to the platform default, distinct from XDG_CONFIG_HOME's tmpDir

    vi.resetModules();
    const freshVault = await import("../vault.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    freshVault.getOrCreateKey(() => false);

    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
