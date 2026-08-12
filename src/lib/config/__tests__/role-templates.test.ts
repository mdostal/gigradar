// Proves the `role-templates` story's two schema-drift/self-consistency
// acceptance criteria for `../role-templates.ts`'s five starter templates:
//   1. each template's `config` validates against the SAME `RoleAreaConfigSchema`
//      `loadConfig()`/`saveConfig()` use (same pattern as
//      `example-config.test.ts`'s config.example.json check) — schema drift
//      breaks this test, not just manual upkeep.
//   2. no template's `coreTitles`/`keywords` overlaps its OWN `redKeywords` —
//      a self-contradictory template would silently misclassify via
//      ../matching/tiering.ts's precedence rules (coreTitles-in-title wins
//      GREEN even over a redKeywords hit; overlap here would mean shipping a
//      template that fights itself).
import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATES } from "../role-templates.js";
import { RoleAreaConfigSchema } from "../schema.js";

describe("ROLE_TEMPLATES", () => {
  it("ships exactly five templates (the story's declared v1 set)", () => {
    expect(ROLE_TEMPLATES).toHaveLength(5);
  });

  it("has a unique id per template", () => {
    const ids = ROLE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const template of ROLE_TEMPLATES) {
    describe(`${template.label} (${template.id})`, () => {
      it("validates against RoleAreaConfigSchema", () => {
        const result = RoleAreaConfigSchema.safeParse(template.config);
        expect(result.success).toBe(true);
      });

      it("has non-empty coreTitles, keywords, and redKeywords", () => {
        expect(template.config.coreTitles.length).toBeGreaterThan(0);
        expect(template.config.keywords.length).toBeGreaterThan(0);
        expect(template.config.redKeywords.length).toBeGreaterThan(0);
      });

      it("has zero overlap between coreTitles+keywords and its own redKeywords", () => {
        const green = [...template.config.coreTitles, ...template.config.keywords].map((s) => s.toLowerCase());
        const red = new Set(template.config.redKeywords.map((s) => s.toLowerCase()));

        const overlap = green.filter((g) => red.has(g));

        expect(overlap).toEqual([]);
      });
    });
  }
});
