import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKeyPath } from "../key-path.js";

// Mirrors src/lib/store/path.ts's own XDG-resolution convention: every test
// saves/restores the env vars it touches so nothing leaks into another
// test file's process.env (tests across files share one process).
let originalXdgConfigHome: string | undefined;
let originalLocalAppData: string | undefined;

beforeEach(() => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalLocalAppData = process.env.LOCALAPPDATA;
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
});

describe("getKeyPath: XDG_CONFIG_HOME resolution", () => {
  it("resolves under XDG_CONFIG_HOME when it is set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config/root";

    expect(getKeyPath()).toBe(path.join("/custom/config/root", "gigradar", "key"));
  });

  it("ignores a blank/whitespace-only XDG_CONFIG_HOME, same as getDefaultDataDir()'s XDG_DATA_HOME handling", () => {
    process.env.XDG_CONFIG_HOME = "   ";

    expect(getKeyPath()).not.toContain("   ");
  });

  it("falls back to the platform default when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;

    const keyPath = getKeyPath();

    if (process.platform === "win32") {
      const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
      expect(keyPath).toBe(path.join(base, "gigradar", "key"));
    } else {
      expect(keyPath).toBe(path.join(os.homedir(), ".config", "gigradar", "key"));
    }
  });

  it("the key path is a `key` file directly under a `gigradar` directory, never inside the XDG_DATA_HOME data directory", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config/root";

    const keyPath = getKeyPath();

    expect(path.basename(keyPath)).toBe("key");
    expect(path.basename(path.dirname(keyPath))).toBe("gigradar");
  });
});
