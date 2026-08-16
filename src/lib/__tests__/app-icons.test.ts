import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ICONS, DEFAULT_APP_ICON_ID, resolveAppIcon } from "../app-icons.js";

// src/lib/__tests__ -> lib -> src -> repo root.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("resolveAppIcon()", () => {
  it("returns the matching option for a known id", () => {
    const icon = resolveAppIcon("classic");

    expect(icon.id).toBe("classic");
  });

  it("falls back to the default for an unknown id", () => {
    const icon = resolveAppIcon("some-id-that-was-never-registered");

    expect(icon.id).toBe(DEFAULT_APP_ICON_ID);
  });

  it("falls back to the default when undefined (config.appIcon omitted)", () => {
    const icon = resolveAppIcon(undefined);

    expect(icon.id).toBe(DEFAULT_APP_ICON_ID);
  });
});

describe("APP_ICONS", () => {
  it("every option has a unique id and a path under /icons/", () => {
    const ids = APP_ICONS.map((icon) => icon.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const icon of APP_ICONS) {
      expect(icon.path).toMatch(/^\/icons\/.+\.png$/);
    }
  });

  it("DEFAULT_APP_ICON_ID names a real option in the list", () => {
    expect(APP_ICONS.some((icon) => icon.id === DEFAULT_APP_ICON_ID)).toBe(true);
  });

  it("every option's path resolves to a real file under public/", () => {
    for (const icon of APP_ICONS) {
      const onDisk = path.join(REPO_ROOT, "public", icon.path);

      expect(fs.existsSync(onDisk), `${icon.path} (id: ${icon.id})`).toBe(true);
    }
  });
});
