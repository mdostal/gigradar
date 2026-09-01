import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt, isEncryptedEnvelope } from "../../security/vault.js";
import { getConfigPath } from "../load.js";
import { readRawConfig, saveConfig } from "../save.js";

// Same isolation pattern as load.test.ts: every test points XDG_DATA_HOME
// (config.json's location) AND XDG_CONFIG_HOME (the vault key's location —
// a deliberately separate directory tree, see key-path.ts) at fresh temp
// dirs, so this suite NEVER touches a real user's actual XDG data dir or
// ~/.config/gigradar/key, and each test is fully isolated from the others.
let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;

// Some tests set a real process.env var to a fake secret value to exercise
// the "env:" literal-passthrough guarantee — track and scrub so no test
// leaks a var into a later test's process.env.
const envVarsTouchedByTests = new Set<string>();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-config-save-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-config-save-test-key-"));
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
});

/** Writes `contents` to config.json as a legacy PLAINTEXT fixture (the pre-encryption on-disk format). */
function writeConfig(contents: unknown, mode = 0o600): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(contents));
  // Pin the exact mode bits regardless of the process umask — mirrors
  // load.test.ts's writeConfig() helper.
  fs.chmodSync(configPath, mode);
}

/** Ensures the vault key exists under the current (test-isolated) XDG_CONFIG_HOME, for fixtures that need to encrypt() ahead of a test. */
function getOrCreateKeyForTest(): void {
  const keyPath = path.join(keyTmpDir, "gigradar", "key");
  if (fs.existsSync(keyPath)) return;
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 });
}

/** Writes `doc` to config.json as an already-encrypted vault envelope. */
function writeEncryptedConfig(doc: unknown, mode = 0o600): void {
  getOrCreateKeyForTest();
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, encrypt(JSON.stringify(doc)));
  fs.chmodSync(configPath, mode);
}

/** Reads config.json's raw bytes directly — plain fs, nothing from this repo's config modules. Used to independently verify what actually landed on disk. */
function readRawFileBytes(): string {
  return fs.readFileSync(getConfigPath(), "utf8");
}

/** Reads config.json's raw bytes and decrypts them (the file MUST be an encrypted envelope) — for assertions that need to inspect the actual saved content. */
function readAndDecryptOnDisk(): unknown {
  const raw = readRawFileBytes();
  expect(isEncryptedEnvelope(raw)).toBe(true);
  return JSON.parse(decrypt(raw));
}

const validConfig = {
  profile: {
    name: "Ada",
    roles: ["Fractional CTO"],
    skills: ["TypeScript", "Architecture"],
    timezone: "America/Chicago",
  },
  groups: [
    {
      id: "g1",
      label: "Group 1",
      needs: {
        engagementProfiles: [
          {
            id: "fractional-contract",
            label: "Fractional/contract",
            types: ["contract", "fractional"],
            minRate: 150,
            highRate: 250,
            maxHours: 20,
            maxHoursAtHighRate: 40,
            rateUnit: "hour",
          },
        ],
        freshStageOnly: true,
        remoteOnly: true,
      },
    },
  ],
  sources: [{ id: "braintrust", enabled: true }],
};

describe("saveConfig: encryption at rest", () => {
  it("given saveConfig() succeeds, the resulting config.json's raw bytes on disk are an encrypted envelope, never plaintext JSON", () => {
    const result = saveConfig(validConfig);

    expect(result.ok).toBe(true);
    const rawFileContent = readRawFileBytes();
    expect(isEncryptedEnvelope(rawFileContent)).toBe(true);
    // Definitely not plaintext JSON of the config itself.
    expect(() => {
      const parsed = JSON.parse(rawFileContent);
      if (parsed && typeof parsed === "object" && "profile" in parsed) {
        throw new Error("raw file content parsed as plaintext config — encryption did not happen");
      }
    }).not.toThrow();
  });

  it("accepts a legacy plaintext existing config.json as the merge base and writes the result back encrypted", () => {
    writeConfig(validConfig);
    expect(isEncryptedEnvelope(readRawFileBytes())).toBe(false);

    const result = saveConfig({ profile: { ...validConfig.profile, name: "Grace" } });

    expect(result.ok).toBe(true);
    expect(isEncryptedEnvelope(readRawFileBytes())).toBe(true);
    expect((readAndDecryptOnDisk() as typeof validConfig).profile.name).toBe("Grace");
  });

  it("accepts an already-encrypted existing config.json as the merge base and writes the result back encrypted", () => {
    writeEncryptedConfig(validConfig);

    const result = saveConfig({ profile: { ...validConfig.profile, name: "Grace" } });

    expect(result.ok).toBe(true);
    expect((readAndDecryptOnDisk() as typeof validConfig).profile.name).toBe("Grace");
  });
});

describe("saveConfig: happy path (overwrite existing file)", () => {
  it("overwrites config.json with the edited, validated document when a valid config.json already exists", () => {
    writeConfig(validConfig);

    const result = saveConfig({
      ...validConfig,
      profile: { ...validConfig.profile, name: "Grace" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.profile.name).toBe("Grace");

    const onDisk = readAndDecryptOnDisk() as typeof validConfig;
    expect(onDisk.profile.name).toBe("Grace");
  });

  it("shallow-merges edits at the top level, leaving untouched sections intact", () => {
    const full = {
      ...validConfig,
      schedule: "0 9 * * *",
    };
    writeConfig(full);

    // Only editing group 0's `needs` here — profile/sources/schedule should
    // survive untouched via the merge against the freshly re-read raw document.
    const group = full.groups[0]!;
    const editedProfiles = [{ ...group.needs.engagementProfiles[0]!, minRate: 200 }];
    const result = saveConfig({ groups: [{ ...group, needs: { ...group.needs, engagementProfiles: editedProfiles } }] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.groups[0]!.needs.engagementProfiles[0]!.minRate).toBe(200);
    expect(result.data.profile).toEqual(full.profile);
    expect(result.data.sources).toEqual(full.sources);
    expect(result.data.schedule).toBe(full.schedule);
  });
});

describe("saveConfig: THE single most important test — env: references are never resolved", () => {
  it("writes an env: reference back to disk as the literal string, never the value process.env resolves it to", () => {
    // A fake secret value that must NEVER appear anywhere in config.json.
    const FAKE_SECRET_VALUE = "sk-live-super-secret-do-not-persist-4f9a1c";
    process.env.FAKE_SOURCE_API_KEY = FAKE_SECRET_VALUE;
    envVarsTouchedByTests.add("FAKE_SOURCE_API_KEY");

    const edited = {
      ...validConfig,
      sources: [
        {
          id: "braintrust",
          enabled: true,
          settings: { apiKey: "env:FAKE_SOURCE_API_KEY" },
        },
      ],
    };

    const result = saveConfig(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);

    // First: the in-memory returned Config still carries the literal,
    // unresolved "env:" string — saveConfig() never resolved it even in
    // memory.
    expect(result.data.sources[0]?.settings?.apiKey).toBe("env:FAKE_SOURCE_API_KEY");

    // The proof that actually matters: independently re-read the RAW file
    // bytes from disk via plain fs.readFileSync — NOT via loadConfig() or
    // any env-resolving function — confirm they're an encrypted envelope
    // (never plaintext, so the fake secret can't be grepped out of the file
    // at rest either), then decrypt with the vault module directly (still
    // never touching this repo's env-resolving code) and assert:
    //   1. the literal "env:FAKE_SOURCE_API_KEY" string is present, and
    //   2. the fake secret value is NOT present anywhere in the file
    //      content, in any form — encrypted OR decrypted.
    const rawFileContent = readRawFileBytes();
    expect(isEncryptedEnvelope(rawFileContent)).toBe(true);
    expect(rawFileContent).not.toContain(FAKE_SECRET_VALUE);
    expect(rawFileContent).not.toContain("env:FAKE_SOURCE_API_KEY"); // ciphertext — the literal string isn't visible either

    const decryptedContent = decrypt(rawFileContent);
    expect(decryptedContent).toContain("env:FAKE_SOURCE_API_KEY");
    expect(decryptedContent).not.toContain(FAKE_SECRET_VALUE);

    // Belt-and-suspenders: re-parse the decrypted bytes as JSON
    // independently too, confirming the same thing structurally, not just
    // as a substring.
    const rawParsed = JSON.parse(decryptedContent);
    expect(rawParsed.sources[0].settings.apiKey).toBe("env:FAKE_SOURCE_API_KEY");
    expect(JSON.stringify(rawParsed)).not.toContain(FAKE_SECRET_VALUE);
  });

  it("preserves an env: reference verbatim even when merging edits onto an existing raw document that already had one", () => {
    const FAKE_SECRET_VALUE = "another-fake-secret-should-never-be-written-9z8y7x";
    process.env.OTHER_FAKE_KEY = FAKE_SECRET_VALUE;
    envVarsTouchedByTests.add("OTHER_FAKE_KEY");

    writeConfig({
      ...validConfig,
      sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:OTHER_FAKE_KEY" } }],
    });

    // Edit an unrelated section (profile) — the env: reference in `sources`
    // was never part of this call's `edits` at all, yet must survive the
    // merge unchanged (proving the merge path doesn't route the pre-existing
    // raw document through any resolving step either).
    const result = saveConfig({ profile: { ...validConfig.profile, name: "Updated Name" } });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.sources[0]?.settings?.apiKey).toBe("env:OTHER_FAKE_KEY");

    const decryptedContent = decrypt(readRawFileBytes());
    expect(decryptedContent).toContain("env:OTHER_FAKE_KEY");
    expect(decryptedContent).not.toContain(FAKE_SECRET_VALUE);
  });
});

describe("saveConfig: first-run / ENOENT tolerance", () => {
  it("creates config.json successfully when no file exists yet, rather than throwing ENOENT", () => {
    expect(fs.existsSync(getConfigPath())).toBe(false);

    let result: ReturnType<typeof saveConfig> | undefined;
    expect(() => {
      result = saveConfig(validConfig);
    }).not.toThrow();

    expect(result?.ok).toBe(true);
    expect(fs.existsSync(getConfigPath())).toBe(true);
    expect(readAndDecryptOnDisk()).toEqual(validConfig);
  });

  it("creates the parent XDG data directory too, if it doesn't exist yet", () => {
    // A totally fresh XDG_DATA_HOME with nothing in it at all — not even
    // the gigradar subdirectory.
    const configPath = getConfigPath();
    expect(fs.existsSync(path.dirname(configPath))).toBe(false);

    const result = saveConfig(validConfig);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
  });
});

describe("saveConfig: validation failure writes nothing", () => {
  it("returns a field-level error and does not write anything when no config.json existed before", () => {
    expect(fs.existsSync(getConfigPath())).toBe(false);

    const { groups, ...rest } = validConfig; // omit required `groups`
    const result = saveConfig(rest);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("groups");
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });

  it("leaves the existing (already-encrypted) file completely untouched when an edit fails validation", () => {
    writeEncryptedConfig(validConfig);
    const before = fs.readFileSync(getConfigPath(), "utf8");
    const beforeStat = fs.statSync(getConfigPath());

    // minRate must be a number — send a string to fail schema validation.
    const group = validConfig.groups[0]!;
    const result = saveConfig({
      ...validConfig,
      groups: [
        {
          ...group,
          needs: {
            ...group.needs,
            engagementProfiles: [{ ...group.needs.engagementProfiles[0], minRate: "not-a-number" }],
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("groups.0.needs.engagementProfiles.0.minRate");

    const after = fs.readFileSync(getConfigPath(), "utf8");
    const afterStat = fs.statSync(getConfigPath());
    expect(after).toBe(before);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it(
    "REGRESSION (this story's highest-stakes correctness requirement): given a LEGACY PLAINTEXT config.json and " +
      "edits that fail validation, the file on disk is left completely byte-for-byte untouched — still plaintext, " +
      "unchanged — because the internal raw-read (readRawConfigDocument(), saveConfig()'s merge base) must NOT " +
      "migrate-write ahead of the failed validation, only loadConfig()/readRawConfig() (standalone reads) may do that",
    () => {
      writeConfig(validConfig); // legacy plaintext fixture, NOT pre-encrypted
      const before = fs.readFileSync(getConfigPath(), "utf8");
      const beforeStat = fs.statSync(getConfigPath());
      expect(isEncryptedEnvelope(before)).toBe(false);

      const group = validConfig.groups[0]!;
      const result = saveConfig({
        ...validConfig,
        groups: [
          {
            ...group,
            needs: {
              ...group.needs,
              engagementProfiles: [{ ...group.needs.engagementProfiles[0], minRate: "not-a-number" }],
            },
          },
        ],
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toContain("groups.0.needs.engagementProfiles.0.minRate");

      const after = fs.readFileSync(getConfigPath(), "utf8");
      const afterStat = fs.statSync(getConfigPath());
      // Byte-for-byte identical — NOT re-encrypted, NOT touched at all.
      expect(after).toBe(before);
      expect(isEncryptedEnvelope(after)).toBe(false);
      expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    },
  );

  it("rejects a non-object edits argument without writing anything", () => {
    expect(fs.existsSync(getConfigPath())).toBe(false);

    // @ts-expect-error deliberately passing an invalid shape to prove runtime guard
    const result = saveConfig("not an object");

    expect(result.ok).toBe(false);
    expect(fs.existsSync(getConfigPath())).toBe(false);
  });
});

describe("saveConfig: file permissions", () => {
  it("sets mode 0600 (owner-only) on a newly created config.json", () => {
    saveConfig(validConfig);

    const mode = fs.statSync(getConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("re-pins mode 0600 even when overwriting a file that was previously more permissive", () => {
    writeConfig(validConfig, 0o644);
    expect(fs.statSync(getConfigPath()).mode & 0o777).toBe(0o644);

    const result = saveConfig({ ...validConfig, profile: { ...validConfig.profile, name: "Updated" } });

    expect(result.ok).toBe(true);
    const mode = fs.statSync(getConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("readRawConfig: the config-editing UI's pre-populate read path", () => {
  it("returns {} (never throws) when no config.json exists yet — first-run", () => {
    expect(fs.existsSync(getConfigPath())).toBe(false);
    expect(readRawConfig()).toEqual({});
  });

  it("returns the raw, unresolved, DECRYPTED document, with any env: reference intact as a literal string", () => {
    process.env.RAW_READ_FAKE_SECRET = "must-not-appear-resolved";
    envVarsTouchedByTests.add("RAW_READ_FAKE_SECRET");

    writeEncryptedConfig({
      ...validConfig,
      sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:RAW_READ_FAKE_SECRET" } }],
    });

    const raw = readRawConfig() as typeof validConfig & {
      sources: [{ settings: { apiKey: string } }];
    };
    expect(raw.sources[0].settings.apiKey).toBe("env:RAW_READ_FAKE_SECRET");
    expect(JSON.stringify(raw)).not.toContain("must-not-appear-resolved");
  });

  it("given a legacy plaintext config.json, readRawConfig() (the standalone external entry point) returns the parsed document AND the file on disk is now encrypted after the call", () => {
    writeConfig(validConfig);
    const configPath = getConfigPath();
    expect(isEncryptedEnvelope(fs.readFileSync(configPath, "utf8"))).toBe(false);

    const raw = readRawConfig();

    expect(raw).toEqual(validConfig);
    expect(isEncryptedEnvelope(fs.readFileSync(configPath, "utf8"))).toBe(true);
  });

  it("given a config.json still in the deprecated flat needs shape (minRate/allowContractToHire, no engagementProfiles), readRawConfig() returns it already migrated to groups with a real profile — the config UI never sees the old shape", () => {
    writeConfig({
      profile: { name: "Ada", roles: [], skills: [], timezone: "UTC" },
      needs: {
        minRate: 150,
        highRate: 250,
        maxHours: 20,
        maxHoursAtHighRate: 40,
        allowContractToHire: false,
        freshStageOnly: true,
        remoteOnly: true,
      },
      sources: [],
    });

    const raw = readRawConfig() as {
      groups: { needs: { engagementProfiles: { minRate: number; types: string[] }[] } }[];
    };

    expect(raw.groups[0]?.needs.engagementProfiles).toHaveLength(1);
    expect(raw.groups[0]?.needs.engagementProfiles[0]?.minRate).toBe(150);
    expect(raw.groups[0]?.needs.engagementProfiles[0]?.types).toEqual(["contract", "fractional"]);
  });

  it("given an already-encrypted config.json, readRawConfig() decrypts and returns the document with no further write", () => {
    writeEncryptedConfig(validConfig);
    const configPath = getConfigPath();
    const before = fs.readFileSync(configPath, "utf8");
    const beforeStat = fs.statSync(configPath);

    const raw = readRawConfig();

    expect(raw).toEqual(validConfig);
    const after = fs.readFileSync(configPath, "utf8");
    const afterStat = fs.statSync(configPath);
    expect(after).toBe(before);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });
});

describe("saveConfig: no resolved secret ever appears in an error message", () => {
  it("a validation-failure error message never contains an env-resolved value, even when the input included an env: reference", () => {
    process.env.YET_ANOTHER_FAKE_SECRET = "must-not-leak-into-error-messages";
    envVarsTouchedByTests.add("YET_ANOTHER_FAKE_SECRET");

    const { groups, ...rest } = validConfig;
    const result = saveConfig({
      ...rest,
      sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:YET_ANOTHER_FAKE_SECRET" } }],
      // groups omitted -> validation failure
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).not.toContain("must-not-leak-into-error-messages");
  });
});

// adapter-batch-public-boards epic, public-fetch-adapters story's own
// acceptance criterion / clobber-risk regression guard: `saveConfig()`'s
// `sources` field is a full-section replace (see this file's header
// comment), so the integrate step that activates the three new fetch-based
// sources in the owner's real config.json MUST read the current `sources`
// array first (readRawConfig()) and write the COMPLETE merged array —
// existing entries untouched, new ones appended. This asserts that exact
// read-merge-write pattern never silently drops an already-configured
// source, using the SAME 4-source shape (braintrust/builtin/gofractional/
// ateam) the real owner's config.json actually had going into this story.
describe("saveConfig: read-merge-write sources (adapter-batch-public-boards activation pattern)", () => {
  const preexistingConfig = {
    ...validConfig,
    sources: [
      { id: "braintrust", enabled: true, settings: { apiKey: "env:FAKE_BRAINTRUST_KEY" } },
      { id: "builtin", enabled: true },
      { id: "gofractional", enabled: true, settings: { sessionStatePath: "env:FAKE_GF_SESSION_PATH" } },
      { id: "ateam", enabled: true, settings: { sessionStatePath: "env:FAKE_ATEAM_SESSION_PATH" } },
    ],
  };

  it("adding 3 new fetch-based sources via readRawConfig() + full merged array keeps all 4 original sources AND adds the 3 new ones, enabled", () => {
    writeConfig(preexistingConfig);

    // The exact pattern the integrate step must follow: read current
    // sources first...
    const current = readRawConfig() as typeof preexistingConfig;
    expect(current.sources).toHaveLength(4);

    // ...build the COMPLETE merged array (never just the new entries)...
    const merged = [
      ...current.sources,
      { id: "fractionaljobs", enabled: true },
      { id: "fractionus", enabled: true },
      { id: "fractionalfinders", enabled: true },
    ];

    // ...and write that whole array as the edit.
    const result = saveConfig({ sources: merged });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.data.sources).toHaveLength(7);

    // All 4 original sources STILL present, byte-identical (including their
    // unresolved "env:" settings — never touched by this edit).
    expect(result.data.sources.find((s) => s.id === "braintrust")).toEqual(preexistingConfig.sources[0]);
    expect(result.data.sources.find((s) => s.id === "builtin")).toEqual(preexistingConfig.sources[1]);
    expect(result.data.sources.find((s) => s.id === "gofractional")).toEqual(preexistingConfig.sources[2]);
    expect(result.data.sources.find((s) => s.id === "ateam")).toEqual(preexistingConfig.sources[3]);

    // The 3 new fetch-based sources ADDED, enabled.
    for (const id of ["fractionaljobs", "fractionus", "fractionalfinders"]) {
      expect(result.data.sources.find((s) => s.id === id)).toEqual({ id, enabled: true });
    }

    // Confirmed on disk too, not just the in-memory return value.
    const onDisk = readAndDecryptOnDisk() as typeof preexistingConfig;
    expect(onDisk.sources).toHaveLength(7);
    expect(onDisk.sources.map((s) => s.id).sort()).toEqual(
      ["ateam", "braintrust", "builtin", "fractionaljobs", "fractionalfinders", "fractionus", "gofractional"].sort(),
    );
  });

  it("regression guard: a NAIVE write of only the new entries (no read-merge) WOULD have wiped the existing 4 — demonstrating why the merge above is required", () => {
    writeConfig(preexistingConfig);

    // The clobber this story's design_decisions explicitly warns against:
    // passing just the new sources, skipping the read-merge step.
    const result = saveConfig({
      sources: [
        { id: "fractionaljobs", enabled: true },
        { id: "fractionus", enabled: true },
        { id: "fractionalfinders", enabled: true },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    // This IS the clobber — sources ends up with only the 3 new entries,
    // the 4 original ones silently gone. Asserted here as a demonstration
    // of the exact failure mode the read-merge-write pattern above avoids,
    // not as desired behavior.
    expect(result.data.sources).toHaveLength(3);
    expect(result.data.sources.find((s) => s.id === "braintrust")).toBeUndefined();
  });
});
