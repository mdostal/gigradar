// Proves source-presets story's acceptance criteria for ../source-presets.ts:
//   1. exactly 11 presets (indeed, welcome-to-the-jungle, zoho-recruit,
//      catalant, gun-io, shiny, greenhouse, ashby, workable, contra,
//      landing-jobs) -- the ats-navigator epic's original 3, plus Catalant,
//      plus a deep-research expansion pass, plus Gun.io and Shiny.
//   2. each preset, wrapped into a full SourceConfig (id/enabled/kind/
//      settings), validates against the SAME SourceConfigSchema
//      loadConfig()/saveConfig() use -- schema drift breaks this test,
//      not just manual upkeep (same pattern role-templates.test.ts
//      already established for RoleAreaConfigSchema).
//   3. no preset's settings.url carries a query string -- "real per-
//      listing/page URLs only, never a search URL" (design-discussion.md).
//   4. every preset with customAuth: "browser-session" also sets
//      settings.loginUrl and settings.allowedOrigins -- Capture Login
//      needs both (see origins.ts's resolveLoginUrl()/resolveAllowedOrigins()
//      config-driven fallback).
//   5. suggestsGmailDigest is true for the platforms known to notify by
//      email, false/unset for the rest.
import { describe, expect, it } from "vitest";
import { SOURCE_PRESETS, sourceConfigFromPreset } from "../source-presets.js";
import { SourceConfigSchema } from "../../config/schema.js";

describe("SOURCE_PRESETS", () => {
  it("ships exactly the owner-confirmed list of 11 presets", () => {
    expect(SOURCE_PRESETS.map((p) => p.id).sort()).toEqual([
      "ashby",
      "catalant",
      "contra",
      "greenhouse",
      "gun-io",
      "indeed",
      "landing-jobs",
      "shiny",
      "welcome-to-the-jungle",
      "workable",
      "zoho-recruit",
    ]);
  });

  it("has a unique id per preset", () => {
    const ids = SOURCE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const preset of SOURCE_PRESETS) {
    describe(`${preset.label} (${preset.id})`, () => {
      it("has non-empty label, description, settings.url, settings.hint", () => {
        expect(preset.label.length).toBeGreaterThan(0);
        expect(preset.description.length).toBeGreaterThan(0);
        expect(String(preset.settings.url).length).toBeGreaterThan(0);
        expect(String(preset.settings.hint).length).toBeGreaterThan(0);
      });

      it("validates against SourceConfigSchema when wrapped as a real SourceConfig", () => {
        const config = { id: preset.id, enabled: true, kind: "custom-llm", settings: preset.settings };
        const result = SourceConfigSchema.safeParse(config);
        expect(result.success).toBe(true);
      });

      it("settings.url is a real https URL with no query string (never a search page)", () => {
        const url = String(preset.settings.url);
        expect(() => new URL(url)).not.toThrow();
        expect(new URL(url).protocol).toBe("https:");
        expect(url).not.toContain("?");
      });

      it("has a genuine, specific hint describing the platform's listing layout, not filler", () => {
        const hint = String(preset.settings.hint);
        expect(hint.length).toBeGreaterThan(40);
      });
    });
  }

  it("indeed, catalant, gun-io, and shiny default customAuth to browser-session (bot detection / login-gated)", () => {
    const indeed = SOURCE_PRESETS.find((p) => p.id === "indeed")!;
    const catalant = SOURCE_PRESETS.find((p) => p.id === "catalant")!;
    const gunIo = SOURCE_PRESETS.find((p) => p.id === "gun-io")!;
    const shiny = SOURCE_PRESETS.find((p) => p.id === "shiny")!;
    expect(indeed.settings.customAuth).toBe("browser-session");
    expect(catalant.settings.customAuth).toBe("browser-session");
    expect(gunIo.settings.customAuth).toBe("browser-session");
    expect(shiny.settings.customAuth).toBe("browser-session");
  });

  it("every other preset leaves customAuth unset (all public by default)", () => {
    for (const id of ["welcome-to-the-jungle", "zoho-recruit", "greenhouse", "ashby", "workable", "contra", "landing-jobs"]) {
      const preset = SOURCE_PRESETS.find((p) => p.id === id)!;
      expect(preset.settings.customAuth, id).toBeUndefined();
    }
  });

  it("every preset with customAuth: browser-session also sets loginUrl and allowedOrigins (Capture Login needs both)", () => {
    for (const preset of SOURCE_PRESETS) {
      if (preset.settings.customAuth !== "browser-session") continue;
      expect(String(preset.settings.loginUrl ?? ""), `${preset.id}.settings.loginUrl`).not.toBe("");
      expect(Array.isArray(preset.settings.allowedOrigins), `${preset.id}.settings.allowedOrigins`).toBe(true);
      expect((preset.settings.allowedOrigins as string[]).length, `${preset.id}.settings.allowedOrigins`).toBeGreaterThan(0);
    }
  });

  it("indeed, zoho-recruit, greenhouse, and workable suggest a Gmail digest connection; the rest do not", () => {
    const digestExpected: Record<string, boolean> = {
      indeed: true,
      "welcome-to-the-jungle": false,
      "zoho-recruit": true,
      catalant: false,
      "gun-io": false,
      shiny: false,
      greenhouse: true,
      ashby: false,
      workable: true,
      contra: false,
      "landing-jobs": false,
    };
    for (const [id, expected] of Object.entries(digestExpected)) {
      const preset = SOURCE_PRESETS.find((p) => p.id === id)!;
      expect(Boolean(preset.suggestsGmailDigest), id).toBe(expected);
    }
  });
});

describe("sourceConfigFromPreset", () => {
  const zoho = SOURCE_PRESETS.find((p) => p.id === "zoho-recruit")!;

  it("produces a SourceConfig with kind: custom-llm and settings matching the preset's settings exactly", () => {
    const config = sourceConfigFromPreset(zoho, []);
    expect(config).toEqual({ id: "zoho-recruit", enabled: true, kind: "custom-llm", settings: zoho.settings });
  });

  it("uses the preset's own id when it is not already taken", () => {
    const config = sourceConfigFromPreset(zoho, ["indeed", "some-other-source"]);
    expect(config.id).toBe("zoho-recruit");
  });

  it("uniques the id with an incrementing numeric suffix when the preset's id is already taken", () => {
    const config = sourceConfigFromPreset(zoho, ["zoho-recruit"]);
    expect(config.id).toBe("zoho-recruit-2");
  });

  it("keeps incrementing the suffix past multiple collisions", () => {
    const config = sourceConfigFromPreset(zoho, ["zoho-recruit", "zoho-recruit-2", "zoho-recruit-3"]);
    expect(config.id).toBe("zoho-recruit-4");
  });

  it("validates against SourceConfigSchema", () => {
    const config = sourceConfigFromPreset(zoho, ["zoho-recruit"]);
    expect(SourceConfigSchema.safeParse(config).success).toBe(true);
  });
});
