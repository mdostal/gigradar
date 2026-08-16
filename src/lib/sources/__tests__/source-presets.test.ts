// Proves source-presets story's acceptance criteria for ../source-presets.ts:
//   1. exactly 3 presets (indeed, welcome-to-the-jungle, zoho-recruit) --
//      the owner-confirmed closed list (design-discussion.md §3 "and
//      etc." -- resolved).
//   2. each preset, wrapped into a full SourceConfig (id/enabled/kind/
//      settings), validates against the SAME SourceConfigSchema
//      loadConfig()/saveConfig() use -- schema drift breaks this test,
//      not just manual upkeep (same pattern role-templates.test.ts
//      already established for RoleAreaConfigSchema).
//   3. no preset's settings.url carries a query string -- "real per-
//      listing/page URLs only, never a search URL" (design-discussion.md).
//   4. indeed defaults to customAuth: "browser-session"; the other two
//      leave it unset.
//   5. suggestsGmailDigest is true for indeed/zoho-recruit, false/unset
//      for welcome-to-the-jungle.
import { describe, expect, it } from "vitest";
import { SOURCE_PRESETS } from "../source-presets.js";
import { SourceConfigSchema } from "../../config/schema.js";

describe("SOURCE_PRESETS", () => {
  it("ships exactly the owner-confirmed closed list of 3 presets", () => {
    expect(SOURCE_PRESETS.map((p) => p.id).sort()).toEqual(["indeed", "welcome-to-the-jungle", "zoho-recruit"]);
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

  it("indeed defaults customAuth to browser-session (likely-aggressive bot detection, see design-discussion.md §3/§4.1)", () => {
    const indeed = SOURCE_PRESETS.find((p) => p.id === "indeed")!;
    expect(indeed.settings.customAuth).toBe("browser-session");
  });

  it("welcome-to-the-jungle and zoho-recruit leave customAuth unset (public by default)", () => {
    const wttj = SOURCE_PRESETS.find((p) => p.id === "welcome-to-the-jungle")!;
    const zoho = SOURCE_PRESETS.find((p) => p.id === "zoho-recruit")!;
    expect(wttj.settings.customAuth).toBeUndefined();
    expect(zoho.settings.customAuth).toBeUndefined();
  });

  it("indeed and zoho-recruit suggest a Gmail digest connection; welcome-to-the-jungle does not", () => {
    const indeed = SOURCE_PRESETS.find((p) => p.id === "indeed")!;
    const zoho = SOURCE_PRESETS.find((p) => p.id === "zoho-recruit")!;
    const wttj = SOURCE_PRESETS.find((p) => p.id === "welcome-to-the-jungle")!;
    expect(indeed.suggestsGmailDigest).toBe(true);
    expect(zoho.suggestsGmailDigest).toBe(true);
    expect(wttj.suggestsGmailDigest).toBeFalsy();
  });
});
