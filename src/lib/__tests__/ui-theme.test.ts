import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_UI_THEME, UI_THEMES, resolveUiTheme } from "../ui-theme.js";

// src/lib/__tests__ -> lib -> src -> repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("resolveUiTheme()", () => {
  it("returns the matching theme id for a known value", () => {
    expect(resolveUiTheme("editorial")).toBe("editorial");
    expect(resolveUiTheme("terminal")).toBe("terminal");
    expect(resolveUiTheme("radar")).toBe("radar");
    expect(resolveUiTheme("signal-deck")).toBe("signal-deck");
    expect(resolveUiTheme("signal-desk")).toBe("signal-desk");
  });

  it("falls back to the default for an unknown value", () => {
    expect(resolveUiTheme("some-theme-that-was-never-registered")).toBe(DEFAULT_UI_THEME);
  });

  it("falls back to the default when undefined (config.uiTheme omitted -- existing installs)", () => {
    expect(resolveUiTheme(undefined)).toBe(DEFAULT_UI_THEME);
  });

  it("falls back to the default for a non-string value (defensive against a hand-edited config.json)", () => {
    expect(resolveUiTheme(42)).toBe(DEFAULT_UI_THEME);
    expect(resolveUiTheme(null)).toBe(DEFAULT_UI_THEME);
  });
});

describe("UI_THEMES", () => {
  it("DEFAULT_UI_THEME names a real option in the list", () => {
    expect(UI_THEMES.some((t) => t.id === DEFAULT_UI_THEME)).toBe(true);
  });

  it("DEFAULT_UI_THEME is signal-deck (gigradar-command-center epic: promoted over the original radar default, which remains selectable)", () => {
    expect(DEFAULT_UI_THEME).toBe("signal-deck");
  });

  it("every theme id has a corresponding CSS file under src/app/themes/", () => {
    for (const theme of UI_THEMES) {
      const cssPath = path.join(REPO_ROOT, "src/app/themes", `${theme.id}.css`);
      expect(fs.existsSync(cssPath), `${theme.id}.css`).toBe(true);
    }
  });
});
