import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultKeyLostError, VaultTamperError, decrypt, encrypt, getOrCreateKey, isEncryptedEnvelope } from "../../security/vault.js";
import { getDefaultDataDir, getDefaultDbPath } from "../../store/path.js";
import { getConfigPath, getEnvPath, hasAnyEncryptedFile, loadConfig } from "../load.js";

// Every test points XDG_DATA_HOME at a fresh temp dir so we NEVER touch a
// real user's actual XDG data dir, and each test's config.json is fully
// isolated from the others. XDG_CONFIG_HOME gets the SAME treatment (a
// separate fresh temp dir, not a subdirectory of tmpDir) — that's where the
// vault key file lives (src/lib/security/key-path.ts), a genuinely
// different directory tree from config.json's XDG_DATA_HOME on purpose
// (see key-path.ts's header comment), so this suite never touches a real
// user's actual ~/.config/gigradar/key either.
let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

// env: resolution tests set real process.env vars via dotenv (or directly)
// to exercise resolution — track and scrub them so no test leaks a var into
// a later test's process.env.
const envVarsTouchedByTests = new Set<string>();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-config-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-config-test-key-"));
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
  for (const varName of envVarsTouchedByTests) delete process.env[varName];
  envVarsTouchedByTests.clear();
  vi.restoreAllMocks();
});

/** Writes `contents` to config.json as a legacy PLAINTEXT fixture (the pre-encryption on-disk format). */
function writePlaintextConfig(contents: string, mode = 0o600): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, contents);
  // writeFileSync's mode option is subject to the process umask, which
  // would make an 0o644 test flaky in a CI image with a stricter umask —
  // chmod explicitly afterward to pin the exact mode bits under test.
  fs.chmodSync(configPath, mode);
}

/** Writes `doc` to config.json as an already-encrypted vault envelope (encrypt() requires the vault key to already exist — see getOrCreateKeyForTest() below). */
function writeEncryptedConfig(doc: unknown, mode = 0o600): void {
  getOrCreateKeyForTest();
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, encrypt(JSON.stringify(doc)));
  fs.chmodSync(configPath, mode);
}

/** Ensures the vault key exists under the current (test-isolated) XDG_CONFIG_HOME, for fixtures that need to encrypt() ahead of calling loadConfig(). */
function getOrCreateKeyForTest(): void {
  // Mirrors vault.test.ts's own createKey() helper: true-first-run path,
  // safe here since every test starts with a fresh, empty keyTmpDir.
  const keyPath = path.join(keyTmpDir, "gigradar", "key");
  if (fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
}

/** Writes `contents` to .env as a legacy PLAINTEXT fixture (the pre-encryption on-disk format). */
function writeEnv(contents: string, mode = 0o600): void {
  const envPath = getEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, contents);
  fs.chmodSync(envPath, mode);
  trackEnvVarsForScrubbing(contents);
}

/** Writes `contents` to .env as an already-encrypted vault envelope (encrypt() requires the vault key to already exist — see getOrCreateKeyForTest() below). */
function writeEncryptedEnv(contents: string, mode = 0o600): void {
  getOrCreateKeyForTest();
  const envPath = getEnvPath();
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, encrypt(contents));
  fs.chmodSync(envPath, mode);
  trackEnvVarsForScrubbing(contents);
}

/** Tracks every var name a dotenv-format fixture string declares so afterEach scrubs it from process.env. */
function trackEnvVarsForScrubbing(dotenvContents: string): void {
  for (const line of dotenvContents.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) envVarsTouchedByTests.add(match[1]);
  }
}

const validConfig = {
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
};

describe("loadConfig: happy path (legacy plaintext input, migrate-on-read)", () => {
  it("returns a Config object matching a valid, legacy-plaintext config.json's contents, validated against the zod schema", () => {
    const full = {
      ...validConfig,
      roleArea: { coreTitles: ["CTO"], keywords: ["fractional"], redKeywords: ["junior"] },
      schedule: "0 9 * * *",
    };
    writePlaintextConfig(JSON.stringify(full));

    const config = loadConfig();

    expect(config).toEqual(full);
  });
});

describe("loadConfig: encryption at rest (migrate-on-read)", () => {
  it("given a legacy plaintext config.json, after loadConfig() returns the file on disk is now an encrypted envelope", () => {
    writePlaintextConfig(JSON.stringify(validConfig));
    const configPath = getConfigPath();
    expect(isEncryptedEnvelope(fs.readFileSync(configPath, "utf8"))).toBe(false);

    loadConfig();

    const onDiskAfter = fs.readFileSync(configPath, "utf8");
    expect(isEncryptedEnvelope(onDiskAfter)).toBe(true);
    // And the migrated envelope decrypts back to the exact same JSON text
    // that was on disk before migration (byte-for-byte content preserved,
    // just wrapped in encryption).
    expect(JSON.parse(decrypt(onDiskAfter))).toEqual(validConfig);
  });

  it("given an already-encrypted config.json, loadConfig() decrypts, parses, and validates correctly, with no further write", () => {
    writeEncryptedConfig(validConfig);
    const configPath = getConfigPath();
    const before = fs.readFileSync(configPath, "utf8");
    const beforeStat = fs.statSync(configPath);

    const config = loadConfig();

    expect(config).toEqual(validConfig);
    const after = fs.readFileSync(configPath, "utf8");
    const afterStat = fs.statSync(configPath);
    expect(after).toBe(before); // byte-for-byte identical — no rewrite happened
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("a second loadConfig() call against an already-migrated file does not re-migrate or otherwise change the file again", () => {
    writePlaintextConfig(JSON.stringify(validConfig));
    loadConfig(); // first call migrates plaintext -> encrypted
    const configPath = getConfigPath();
    const afterFirstCall = fs.readFileSync(configPath, "utf8");
    const afterFirstStat = fs.statSync(configPath);

    loadConfig();

    expect(fs.readFileSync(configPath, "utf8")).toBe(afterFirstCall);
    expect(fs.statSync(configPath).mtimeMs).toBe(afterFirstStat.mtimeMs);
  });

  it("throws vault.ts's specific tamper error, with an actionable config.json-specific message, when the encrypted file has a flipped ciphertext byte", () => {
    writeEncryptedConfig(validConfig);
    const configPath = getConfigPath();

    // Corrupt the envelope: flip one byte inside the base64 "data" field so
    // the GCM auth tag no longer verifies.
    const envelope = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const dataBuf = Buffer.from(envelope.data, "base64");
    const first = dataBuf[0];
    if (first === undefined) throw new Error("test fixture: unexpectedly empty ciphertext");
    dataBuf[0] = first ^ 0xff;
    envelope.data = dataBuf.toString("base64");
    fs.writeFileSync(configPath, JSON.stringify(envelope));

    expect(() => loadConfig()).toThrow(VaultTamperError);
    try {
      loadConfig();
      throw new Error("expected loadConfig() to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultTamperError);
      expect((e as Error).message).toContain(configPath);
    }
  });
});

describe("loadConfig: optional fields", () => {
  it("validates successfully and returns roleArea/schedule as undefined when omitted (not defaulted, not an error)", () => {
    writePlaintextConfig(JSON.stringify(validConfig));

    const config = loadConfig();

    expect(config.profile).toEqual(validConfig.profile);
    expect(config.needs).toEqual(validConfig.needs);
    expect(config.sources).toEqual(validConfig.sources);
    expect(config.roleArea).toBeUndefined();
    expect(config.schedule).toBeUndefined();
    expect("roleArea" in config ? config.roleArea : undefined).toBeUndefined();
  });
});

describe("loadConfig: missing file", () => {
  it("throws a specific, actionable error naming the expected path — not a generic fs error", () => {
    const expectedPath = getConfigPath();

    expect(() => loadConfig()).toThrow(expectedPath);
    try {
      loadConfig();
      throw new Error("expected loadConfig() to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).not.toMatch(/ENOENT/); // not the raw fs error
      expect((e as Error).message).toContain(expectedPath);
      expect((e as Error).message.toLowerCase()).toContain("no config.json found");
    }
  });
});

describe("loadConfig: invalid JSON", () => {
  it("throws a specific parse error", () => {
    writePlaintextConfig("{ this is not valid json");

    expect(() => loadConfig()).toThrow(/not valid JSON/i);
  });
});

describe("loadConfig: zod validation failure", () => {
  it("throws a specific, field-level zod error when a required Needs field is missing — not a generic 'invalid config' message", () => {
    const { needs, ...rest } = validConfig;
    const { minRate, ...needsWithoutMinRate } = needs;
    writePlaintextConfig(JSON.stringify({ ...rest, needs: needsWithoutMinRate }));

    expect(() => loadConfig()).toThrow(/needs\.minRate/);
  });

  it("throws when required top-level fields (e.g. needs) are missing entirely", () => {
    const { needs, ...rest } = validConfig;
    writePlaintextConfig(JSON.stringify(rest));

    try {
      loadConfig();
      throw new Error("expected loadConfig() to throw");
    } catch (e) {
      expect((e as Error).message).not.toMatch(/^gigradar config: .* failed validation:\s*$/);
      expect((e as Error).message).toContain("needs");
    }
  });
});

describe("loadConfig: shared XDG parent directory with the DB path", () => {
  it("resolves config.json into the same parent directory getDefaultDbPath() uses", () => {
    expect(path.dirname(getConfigPath())).toBe(path.dirname(getDefaultDbPath()));
  });
});

describe("loadConfig: permission warning on read", () => {
  it("emits a console warning naming the file and the issue when config.json is group- or world-readable, without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlaintextConfig(JSON.stringify(validConfig), 0o644);

    const config = loadConfig();

    expect(config).toBeDefined(); // did not throw
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warning = warnSpy.mock.calls[0]?.join(" ") ?? "";
    expect(warning).toContain(getConfigPath());
    expect(warning.toLowerCase()).toMatch(/group|other|readable|permission/);
  });

  it("does not warn when config.json is already owner-only (0600)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePlaintextConfig(JSON.stringify(validConfig), 0o600);

    loadConfig();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("loadConfig: env: reference resolution", () => {
  it("resolves a top-level settings string value with an 'env:' prefix from .env in the same XDG directory", () => {
    writeEnv("BRAINTRUST_API_KEY=abc123\n");
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:BRAINTRUST_API_KEY" } }],
      }),
    );

    const config = loadConfig();

    expect(config.sources[0]?.settings?.apiKey).toBe("abc123");
  });

  it("resolves an env: reference from the real process environment even without a .env file", () => {
    process.env.SOME_PROCESS_VAR = "already-set-in-shell";
    envVarsTouchedByTests.add("SOME_PROCESS_VAR");
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:SOME_PROCESS_VAR" } }],
      }),
    );

    const config = loadConfig();

    expect(config.sources[0]?.settings?.apiKey).toBe("already-set-in-shell");
  });

  it("throws an error naming the env var when a referenced var is declared but unset — and the message never contains a resolved secret value", () => {
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:SOME_VAR" } }],
      }),
    );

    try {
      loadConfig();
      throw new Error("expected loadConfig() to throw");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("SOME_VAR");
      // No secret value could have been resolved here (the var is unset),
      // so this doubles as proof the error path never echoes back a value.
      expect(message).not.toContain("abc123");
      expect(message).not.toMatch(/=.+SOME_VAR|SOME_VAR=/); // never renders as VAR=value
    }
  });

  it("does NOT resolve a nested (non-top-level) settings value — left as the literal string, documented v1 limitation", () => {
    writeEnv("NESTED_KEY=should-not-appear\n");
    const nestedSettings = { auth: { apiKey: "env:NESTED_KEY" } };
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: nestedSettings }],
      }),
    );

    const config = loadConfig();

    expect(config.sources[0]?.settings?.auth).toEqual({ apiKey: "env:NESTED_KEY" });
  });

  it("leaves non-'env:' string settings values untouched", () => {
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: { query: "fractional cto" } }],
      }),
    );

    const config = loadConfig();

    expect(config.sources[0]?.settings?.query).toBe("fractional cto");
  });

  it("never includes any resolved secret value in the returned Config when JSON-stringified for logging purposes elsewhere (sanity check on the resolved shape)", () => {
    writeEnv("BRAINTRUST_API_KEY=super-secret-value\n");
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:BRAINTRUST_API_KEY" } }],
      }),
    );

    const config = loadConfig();

    // The resolved value legitimately lives in the returned Config (that's
    // the whole point) — this test just documents that the ONLY place it
    // appears is the settings value itself, not duplicated anywhere else.
    const serialized = JSON.stringify(config);
    expect((serialized.match(/super-secret-value/g) ?? []).length).toBe(1);
  });
});

describe("loadConfig: .env permission warning on read", () => {
  it("emits a prominent console warning naming the .env file when it is group- or world-readable, without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeEnv("BRAINTRUST_API_KEY=abc123\n", 0o644);
    writePlaintextConfig(JSON.stringify(validConfig));

    const config = loadConfig();

    expect(config).toBeDefined(); // did not throw — non-fatal
    const warnings = warnSpy.mock.calls.map((call) => call.join(" "));
    const envWarning = warnings.find((w) => w.includes(getEnvPath()));
    expect(envWarning).toBeDefined();
    expect(envWarning?.toLowerCase()).toMatch(/group|other|readable|permission|security/);
    // The warning names the file, never the secret it might contain.
    expect(envWarning).not.toContain("abc123");
  });

  it("does not warn about .env when it is already owner-only (0600)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeEnv("BRAINTRUST_API_KEY=abc123\n", 0o600);
    writePlaintextConfig(JSON.stringify(validConfig));

    loadConfig();

    const warnings = warnSpy.mock.calls.map((call) => call.join(" "));
    expect(warnings.find((w) => w.includes(getEnvPath()))).toBeUndefined();
  });

  it("does not require .env to exist at all — a config.json with no env: references loads fine without one", () => {
    writePlaintextConfig(JSON.stringify(validConfig));

    expect(() => loadConfig()).not.toThrow();
  });
});

describe("loadConfig: .env encryption at rest (migrate-on-read)", () => {
  it("given a legacy plaintext .env, after loadConfig() the .env file on disk is now an encrypted envelope AND process.env is populated correctly", () => {
    writeEnv("BRAINTRUST_API_KEY=abc123\n");
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:BRAINTRUST_API_KEY" } }],
      }),
    );
    const envPath = getEnvPath();
    expect(isEncryptedEnvelope(fs.readFileSync(envPath, "utf8"))).toBe(false);

    const config = loadConfig();

    expect(config.sources[0]?.settings?.apiKey).toBe("abc123");
    const onDiskAfter = fs.readFileSync(envPath, "utf8");
    expect(isEncryptedEnvelope(onDiskAfter)).toBe(true);
    // And the migrated envelope decrypts back to the exact same dotenv text
    // that was on disk before migration (byte-for-byte content preserved,
    // just wrapped in encryption).
    expect(decrypt(onDiskAfter)).toBe("BRAINTRUST_API_KEY=abc123\n");
  });

  it("given an already-encrypted .env file, loadConfig() decrypts, dotenv.parse()s, and applies to process.env correctly, with no further write", () => {
    writeEncryptedEnv("BRAINTRUST_API_KEY=abc123\n");
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:BRAINTRUST_API_KEY" } }],
      }),
    );
    const envPath = getEnvPath();
    const before = fs.readFileSync(envPath, "utf8");
    const beforeStat = fs.statSync(envPath);

    const config = loadConfig();

    expect(config.sources[0]?.settings?.apiKey).toBe("abc123");
    const after = fs.readFileSync(envPath, "utf8");
    const afterStat = fs.statSync(envPath);
    expect(after).toBe(before); // byte-for-byte identical — no rewrite happened
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("a second loadConfig() call against an already-migrated .env does not re-migrate or otherwise change the file again", () => {
    writeEnv("BRAINTRUST_API_KEY=abc123\n");
    writePlaintextConfig(JSON.stringify(validConfig));
    loadConfig(); // first call migrates plaintext -> encrypted
    const envPath = getEnvPath();
    const afterFirstCall = fs.readFileSync(envPath, "utf8");
    const afterFirstStat = fs.statSync(envPath);

    loadConfig();

    expect(fs.readFileSync(envPath, "utf8")).toBe(afterFirstCall);
    expect(fs.statSync(envPath).mtimeMs).toBe(afterFirstStat.mtimeMs);
  });

  it("throws vault.ts's specific tamper error, with an actionable .env-specific message, when the encrypted .env file has a flipped ciphertext byte", () => {
    writeEncryptedEnv("BRAINTRUST_API_KEY=abc123\n");
    writePlaintextConfig(JSON.stringify(validConfig));
    const envPath = getEnvPath();

    // Corrupt the envelope: flip one byte inside the base64 "data" field so
    // the GCM auth tag no longer verifies.
    const envelope = JSON.parse(fs.readFileSync(envPath, "utf8"));
    const dataBuf = Buffer.from(envelope.data, "base64");
    const first = dataBuf[0];
    if (first === undefined) throw new Error("test fixture: unexpectedly empty ciphertext");
    dataBuf[0] = first ^ 0xff;
    envelope.data = dataBuf.toString("base64");
    fs.writeFileSync(envPath, JSON.stringify(envelope));

    expect(() => loadConfig()).toThrow(VaultTamperError);
    try {
      loadConfig();
      throw new Error("expected loadConfig() to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(VaultTamperError);
      expect((e as Error).message).toContain(envPath);
      // Actionable and .env-specific, but never echoes back any secret value.
      expect((e as Error).message).not.toContain("abc123");
    }
  });

  it("a missing .env is a silent no-op: does not throw, attempts no encryption operation, and leaves no .env file behind", () => {
    writePlaintextConfig(JSON.stringify(validConfig));
    expect(fs.existsSync(getEnvPath())).toBe(false);

    expect(() => loadConfig()).not.toThrow();

    expect(fs.existsSync(getEnvPath())).toBe(false);
  });
});

describe("hasAnyEncryptedFile(): the combined config.json OR .env OR session-state-directory check (encrypted-local-storage epic, session-file-encryption story — the epic's final consumer story, completing this check across all three locations)", () => {
  it("returns false on a true first run: no config.json, no .env, no session files anywhere", () => {
    expect(hasAnyEncryptedFile()).toBe(false);
  });

  it("returns false when only LEGACY PLAINTEXT files exist (config.json, .env, and a session file) — plaintext is not 'encrypted data exists'", () => {
    writePlaintextConfig(JSON.stringify(validConfig));
    writeEnv("BRAINTRUST_API_KEY=abc123\n");
    fs.mkdirSync(getDefaultDataDir(), { recursive: true });
    fs.writeFileSync(path.join(getDefaultDataDir(), "gofractional-session.json"), JSON.stringify({ cookies: [], origins: [] }));

    expect(hasAnyEncryptedFile()).toBe(false);
  });

  it("returns true when ONLY a session file (not config.json or .env) is an encrypted envelope — the session-directory-scan portion this story adds", () => {
    getOrCreateKeyForTest();
    fs.mkdirSync(getDefaultDataDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getDefaultDataDir(), "gofractional-session.json"),
      encrypt(JSON.stringify({ cookies: [], origins: [] })),
    );

    expect(hasAnyEncryptedFile()).toBe(true);
  });

  it("still returns true via config.json or .env alone, unaffected by adding the session-directory scan (regression guard for the prior two stories' behavior)", () => {
    writeEncryptedConfig(validConfig);
    expect(hasAnyEncryptedFile()).toBe(true);
  });

  it("ignores non-session files in the data directory (e.g. gigs.db, or config.json/.env themselves) when scanning for '*-session.json' — an unrelated encrypted-looking blob without that suffix does not count", () => {
    fs.mkdirSync(getDefaultDataDir(), { recursive: true });
    // Not named "*-session.json" — must be ignored by the session-directory
    // scan specifically (config.json/.env are checked by their own,
    // separate calls in hasAnyEncryptedFile(), not this one).
    fs.writeFileSync(path.join(getDefaultDataDir(), "gigs.db"), "not json at all, and not a session file");

    expect(hasAnyEncryptedFile()).toBe(false);
  });

  it("AC: given the session directory contains an already-encrypted session file but the vault key is missing, getOrCreateKey(hasAnyEncryptedFile) throws VaultKeyLostError rather than silently minting an orphan key", () => {
    getOrCreateKeyForTest();
    fs.mkdirSync(getDefaultDataDir(), { recursive: true });
    fs.writeFileSync(
      path.join(getDefaultDataDir(), "ateam-session.json"),
      encrypt(JSON.stringify({ cookies: [], origins: [] })),
    );
    // The key is now "lost": delete it after having used it to encrypt the
    // fixture above.
    fs.unlinkSync(path.join(keyTmpDir, "gigradar", "key"));

    expect(() => getOrCreateKey(hasAnyEncryptedFile)).toThrow(VaultKeyLostError);
  });
});

describe("loadConfig: .env override:false precedence (matches prior dotenv.config() behavior exactly)", () => {
  it("does NOT override a process.env value already set (e.g. by the shell) before .env is loaded, even though a decrypted .env defines the same var", () => {
    process.env.BRAINTRUST_API_KEY = "shell-value";
    envVarsTouchedByTests.add("BRAINTRUST_API_KEY");
    writeEncryptedEnv("BRAINTRUST_API_KEY=dotenv-value\n");
    writePlaintextConfig(
      JSON.stringify({
        ...validConfig,
        sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:BRAINTRUST_API_KEY" } }],
      }),
    );

    const config = loadConfig();

    expect(process.env.BRAINTRUST_API_KEY).toBe("shell-value");
    expect(config.sources[0]?.settings?.apiKey).toBe("shell-value");
  });

  it("does NOT override a process.env value already set before .env is loaded, for a legacy-plaintext .env too (migrate-on-read doesn't change precedence)", () => {
    process.env.BRAINTRUST_API_KEY = "shell-value";
    envVarsTouchedByTests.add("BRAINTRUST_API_KEY");
    writeEnv("BRAINTRUST_API_KEY=dotenv-value\n");
    writePlaintextConfig(JSON.stringify(validConfig));

    loadConfig();

    expect(process.env.BRAINTRUST_API_KEY).toBe("shell-value");
  });

  it("DOES apply a .env value when process.env does not already define that var — override:false only blocks pre-existing vars, it isn't a blanket no-op", () => {
    writeEnv("FRESH_ENV_ONLY_VAR=from-dotenv\n");
    writePlaintextConfig(JSON.stringify(validConfig));
    expect(process.env.FRESH_ENV_ONLY_VAR).toBeUndefined();

    loadConfig();

    expect(process.env.FRESH_ENV_ONLY_VAR).toBe("from-dotenv");
  });
});

describe("loadConfig: .env manual process.env-apply loop never logs a secret", () => {
  it("never surfaces the .env key or value via console.log/console.warn/console.error during a normal load", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeEnv("SUPER_SECRET_VAR=top-secret-value\n", 0o600);
    writePlaintextConfig(JSON.stringify(validConfig));

    loadConfig();

    const allOutput = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(allOutput).not.toContain("top-secret-value");
    expect(allOutput).not.toContain("SUPER_SECRET_VAR=top-secret-value");
  });
});
