import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same reasoning as src/app/__tests__/actions.test.ts: revalidatePath()
// asserts a real Next.js request context that doesn't exist under vitest,
// so the whole module is mocked here — this test exercises saveConfigAction's
// own logic (the {ok,error} convention + revalidatePath-on-success-only),
// not Next's cache internals.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import { getConfigPath } from "@/lib/config/load";
import { closeDb, getDb } from "@/lib/store/db";
import { recordScan } from "@/lib/store/gigs";
import { saveDraft, setDraftStatus } from "@/lib/store/drafts";
import { decrypt } from "@/lib/security/vault";
import { getAutoFireApprovedCountAction, saveConfigAction } from "../actions";

// Same isolation pattern as src/lib/config/__tests__/save.test.ts: every
// test points XDG_DATA_HOME (config.json) AND XDG_CONFIG_HOME (the vault
// key — config.json is encrypted at rest now, see the config-json-
// encryption story) at fresh temp dirs, so this suite NEVER touches a real
// user's actual XDG data directory / config.json / ~/.config/gigradar/key.
let tmpDir: string;
let keyTmpDir: string;
let originalXdgDataHome: string | undefined;
let originalXdgConfigHome: string | undefined;
const envVarsTouchedByTests = new Set<string>();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-config-action-test-"));
  keyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-config-action-test-key-"));
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_HOME = tmpDir;
  process.env.XDG_CONFIG_HOME = keyTmpDir;
  vi.mocked(revalidatePath).mockClear();
});

afterEach(() => {
  closeDb(); // no-op when the gigs-store tests below never opened one
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(keyTmpDir, { recursive: true, force: true });
  for (const varName of envVarsTouchedByTests) delete process.env[varName];
  envVarsTouchedByTests.clear();
});

/** Reads config.json's raw bytes off disk and decrypts them — config.json is encrypted at rest, so a plain JSON.parse(fs.readFileSync(...)) no longer works directly. Still never routed through this repo's env-resolving reader. */
function readOnDiskConfig(): unknown {
  return JSON.parse(decrypt(fs.readFileSync(getConfigPath(), "utf8")));
}

const validConfig = {
  profile: {
    name: "Ada",
    roles: ["Fractional CTO"],
    skills: ["TypeScript", "Architecture"],
    timezone: "America/Chicago",
  },
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
  sources: [{ id: "braintrust", enabled: true }],
};

describe("saveConfigAction: successful save (first-run, no config.json yet)", () => {
  it("writes the document, returns {ok:true,data}, and calls revalidatePath('/config')", async () => {
    expect(fs.existsSync(getConfigPath())).toBe(false);

    const result = await saveConfigAction(validConfig);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
    expect(result.data.profile.name).toBe("Ada");

    const onDisk = readOnDiskConfig() as typeof validConfig;
    expect(onDisk.profile.name).toBe("Ada");

    expect(revalidatePath).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/config");
  });
});

describe("saveConfigAction: validation failure", () => {
  it("returns {ok:false,error} with a specific field-level message, writes nothing, and never calls revalidatePath", async () => {
    const { needs, ...rest } = validConfig; // omit required `needs`

    const result = await saveConfigAction(rest);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("needs");
    expect(fs.existsSync(getConfigPath())).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a Needs field emptied to an invalid type (a real form-clearing scenario) with a field-level error", async () => {
    const result = await saveConfigAction({
      ...validConfig,
      needs: {
        ...validConfig.needs,
        engagementProfiles: [{ ...validConfig.needs.engagementProfiles[0], minRate: Number.NaN }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("needs.engagementProfiles.0.minRate");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it(
    "rejects an empty-string minRate (exactly what ConfigClient's form now sends for a cleared numeric " +
      "field, post-fix) rather than silently accepting it as 0 — a regression guard for a real bug caught " +
      "during this story's live browser verification: Number('') is 0 in JS, so a naive string->Number " +
      "coercion in the form would have silently saved 0 for a blank required field instead of failing",
    async () => {
      const result = await saveConfigAction({
        ...validConfig,
        needs: {
          ...validConfig.needs,
          engagementProfiles: [{ ...validConfig.needs.engagementProfiles[0], minRate: "" }],
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure — a blank required Needs field must not silently become 0");
      expect(result.error).toContain("needs.engagementProfiles.0.minRate");
      expect(fs.existsSync(getConfigPath())).toBe(false);
    },
  );
});

describe("saveConfigAction: env: preservation through the REAL UI/Server-Action path", () => {
  it(
    "an edit carrying a settings.apiKey = env:VAR reference, saved through saveConfigAction (the exact " +
      "function the config form's Save button calls), lands on disk with the env: reference verbatim — " +
      "the fake secret value itself never appears anywhere in the file",
    async () => {
      const FAKE_SECRET_VALUE = "sk-live-ui-path-secret-do-not-persist-7q2w9e";
      process.env.FAKE_UI_SOURCE_API_KEY = FAKE_SECRET_VALUE;
      envVarsTouchedByTests.add("FAKE_UI_SOURCE_API_KEY");

      // This is exactly the shape ConfigClient's draftToEdits() produces for
      // a source row whose settings editor has one key/value pair with an
      // env:-prefixed value — the real UI path, not a hand-built shortcut.
      const edits = {
        ...validConfig,
        sources: [
          {
            id: "braintrust",
            enabled: true,
            settings: { apiKey: "env:FAKE_UI_SOURCE_API_KEY" },
          },
        ],
      };

      const result = await saveConfigAction(edits);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
      // The in-memory ActionResult the client would resync its form state
      // from still carries the literal, unresolved string.
      expect(result.data.sources[0]?.settings?.apiKey).toBe("env:FAKE_UI_SOURCE_API_KEY");

      // The proof that matters: independently re-read the RAW file bytes
      // from disk via plain fs.readFileSync (never through loadConfig() or
      // any resolving function) — the on-disk bytes are an encrypted
      // envelope, so neither the literal env: string nor the fake secret is
      // visible in them at all — then decrypt (still via vault.ts directly,
      // never this repo's env-resolving code) to confirm the literal env:
      // reference survived and the fake secret never appears even
      // decrypted.
      const rawFileContent = fs.readFileSync(getConfigPath(), "utf8");
      expect(rawFileContent).not.toContain("env:FAKE_UI_SOURCE_API_KEY");
      expect(rawFileContent).not.toContain(FAKE_SECRET_VALUE);

      const rawParsed = readOnDiskConfig() as {
        sources: [{ settings: { apiKey: string } }];
      };
      expect(rawParsed.sources[0].settings.apiKey).toBe("env:FAKE_UI_SOURCE_API_KEY");
      expect(JSON.stringify(rawParsed)).not.toContain(FAKE_SECRET_VALUE);
    },
  );

  it("preserves an env: reference verbatim on a SECOND save through the action, editing an unrelated field", async () => {
    const FAKE_SECRET_VALUE = "another-ui-path-fake-secret-3m4n5o";
    process.env.OTHER_FAKE_UI_KEY = FAKE_SECRET_VALUE;
    envVarsTouchedByTests.add("OTHER_FAKE_UI_KEY");

    const first = await saveConfigAction({
      ...validConfig,
      sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:OTHER_FAKE_UI_KEY" } }],
    });
    expect(first.ok).toBe(true);

    // A second, real round-trip: edit profile only (mirroring how the real
    // form always resubmits the full document, including the untouched
    // sources section carrying the env: reference).
    const second = await saveConfigAction({
      ...validConfig,
      profile: { ...validConfig.profile, name: "Updated via UI path" },
      sources: [{ id: "braintrust", enabled: true, settings: { apiKey: "env:OTHER_FAKE_UI_KEY" } }],
    });

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected ok");
    expect(second.data.profile.name).toBe("Updated via UI path");
    expect(second.data.sources[0]?.settings?.apiKey).toBe("env:OTHER_FAKE_UI_KEY");

    const rawFileContent = fs.readFileSync(getConfigPath(), "utf8");
    expect(rawFileContent).not.toContain("env:OTHER_FAKE_UI_KEY"); // encrypted at rest — not visible in the raw bytes
    expect(rawFileContent).not.toContain(FAKE_SECRET_VALUE);

    const decrypted = readOnDiskConfig() as {
      sources: [{ settings: { apiKey: string } }];
    };
    expect(decrypted.sources[0].settings.apiKey).toBe("env:OTHER_FAKE_UI_KEY");
  });
});

describe("saveConfigAction: roleArea/schedule optional semantics", () => {
  it("omits roleArea and schedule from the written document when never provided (first-run)", async () => {
    const result = await saveConfigAction(validConfig);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.roleArea).toBeUndefined();
    expect(result.data.schedule).toBeUndefined();

    const onDisk = readOnDiskConfig() as Record<string, unknown>;
    expect("roleArea" in onDisk).toBe(false);
    expect("schedule" in onDisk).toBe(false);
  });

  it("un-sets a previously-saved roleArea when an edit explicitly sends roleArea: undefined (the disabled-toggle case)", async () => {
    const withRoleArea = await saveConfigAction({
      ...validConfig,
      roleArea: { coreTitles: ["CTO"], keywords: ["fractional"], redKeywords: ["junior"] },
    });
    expect(withRoleArea.ok).toBe(true);
    if (!withRoleArea.ok) throw new Error("expected ok");
    expect(withRoleArea.data.roleArea).toBeDefined();

    // Mirrors draftToEdits()'s behavior when the "Configure role-area
    // filtering" checkbox is unchecked: roleArea is sent explicitly as
    // undefined rather than omitted from the object.
    const unset = await saveConfigAction({ ...validConfig, roleArea: undefined });

    expect(unset.ok).toBe(true);
    if (!unset.ok) throw new Error("expected ok");
    expect(unset.data.roleArea).toBeUndefined();

    const onDisk = readOnDiskConfig() as Record<string, unknown>;
    expect("roleArea" in onDisk).toBe(false);
  });
});

describe("saveConfigAction: autoFire round-trip (graduated-auto-fire-trust epic)", () => {
  it("omits autoFire from the written document when never provided -- same optional-section semantics as roleArea/schedule", async () => {
    const result = await saveConfigAction(validConfig);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.autoFire).toBeUndefined();

    const onDisk = readOnDiskConfig() as Record<string, unknown>;
    expect("autoFire" in onDisk).toBe(false);
  });

  it("persists a killSwitch + rule list exactly as sent -- what AutoFireRulesEditor's draftToEdits() produces", async () => {
    const withAutoFire = await saveConfigAction({
      ...validConfig,
      autoFire: {
        killSwitch: false,
        rules: [{ sourceId: "braintrust", tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }],
      },
    });

    expect(withAutoFire.ok).toBe(true);
    if (!withAutoFire.ok) throw new Error(`expected ok, got: ${withAutoFire.error}`);
    expect(withAutoFire.data.autoFire).toEqual({
      killSwitch: false,
      rules: [{ sourceId: "braintrust", tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }],
    });

    const onDisk = readOnDiskConfig() as { autoFire: unknown };
    expect(onDisk.autoFire).toEqual({
      killSwitch: false,
      rules: [{ sourceId: "braintrust", tier: "green", enabled: true, minApprovals: 3, dailyCap: 3 }],
    });
  });

  it("a rule with minApprovals sent as a non-numeric string (a cleared/invalid field) fails validation with a specific field-level error, same as needs.minRate's own convention", async () => {
    const result = await saveConfigAction({
      ...validConfig,
      autoFire: {
        killSwitch: false,
        rules: [{ sourceId: "braintrust", tier: "green", enabled: true, minApprovals: "", dailyCap: 3 }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/autoFire.*minApprovals/);
  });
});

describe("getAutoFireApprovedCountAction (read-only trust-status lookup)", () => {
  let storeTmpDir: string;

  beforeEach(() => {
    storeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-config-action-store-test-"));
    process.env.GIGRADAR_DB_PATH = path.join(storeTmpDir, "gigs.db");
    envVarsTouchedByTests.add("GIGRADAR_DB_PATH");
  });

  afterEach(() => {
    fs.rmSync(storeTmpDir, { recursive: true, force: true });
  });

  it("returns the real approved-draft count for a (sourceId, tier) pair", async () => {
    const db = getDb();
    recordScan([{ sourceId: "braintrust", gigs: [{ sourceId: "braintrust", externalId: "1", title: "x", url: "https://x.test", tier: "green" }] }], {
      db,
      now: "2026-01-01T00:00:00.000Z",
    });
    saveDraft("braintrust:1", { coverText: "hi", answers: {} }, { db, now: "2026-01-01T00:00:00.000Z" });
    setDraftStatus("braintrust:1", "approved", { db, now: "2026-01-01T00:00:00.000Z" });

    const result = await getAutoFireApprovedCountAction("braintrust", "green");

    expect(result).toEqual({ ok: true, data: 1 });
  });

  it("returns 0 for a pair with no approval history at all -- not an error", async () => {
    const result = await getAutoFireApprovedCountAction("never-configured-source", "green");
    expect(result).toEqual({ ok: true, data: 0 });
  });
});
