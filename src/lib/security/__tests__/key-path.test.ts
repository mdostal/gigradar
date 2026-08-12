import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultDataDir } from "../../store/path.js";
import { getKeyConfigDir, getKeyPath } from "../key-path.js";

// Mirrors src/lib/store/path.ts's own XDG-resolution convention: every test
// saves/restores the env vars it touches so nothing leaks into another
// test file's process.env (tests across files share one process). Also
// saves/restores process.platform itself for the getKeyConfigDir() vs.
// getDefaultDataDir() separation tests below, which simulate win32/POSIX
// regardless of the real OS this suite happens to run on.
let originalXdgConfigHome: string | undefined;
let originalXdgDataHome: string | undefined;
let originalLocalAppData: string | undefined;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalXdgDataHome = process.env.XDG_DATA_HOME;
  originalLocalAppData = process.env.LOCALAPPDATA;
});

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;

  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;

  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;

  setPlatform(originalPlatform);
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
      // Distinct directory NAME ("gigradar-config") from getDefaultDataDir()'s
      // "gigradar" — see the shared separation test below.
      expect(keyPath).toBe(path.join(base, "gigradar-config", "key"));
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

// Shared test guarding the epic's core security property: the vault key
// never lives next to the data it protects. Story:
// windows-key-data-separation (.pHive/epics/security-hardening/stories/
// windows-key-data-separation.yaml) — a Windows fallback bug used to make
// getKeyConfigDir() and getDefaultDataDir() resolve to the IDENTICAL
// directory. This guarantee is deliberately SCOPED to the fallback code
// path (no XDG_CONFIG_HOME/XDG_DATA_HOME set): a user who explicitly sets
// both env vars to the same value themselves has made their own
// configuration choice, which getOrCreateKey()'s collision warning (see
// vault.test.ts) handles separately, non-blockingly.
describe("getKeyConfigDir() vs getDefaultDataDir(): key and data directories never collide on the fallback path", () => {
  it("on the real current platform (whatever this repo's test suite actually runs on), with no XDG env vars set, resolves to genuinely different directories — passes without needing a real Windows machine", () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;

    expect(getKeyConfigDir()).not.toBe(getDefaultDataDir());
  });

  it("simulated win32 fallback (no XDG env vars set): getKeyConfigDir() and getDefaultDataDir() resolve to genuinely different directories", () => {
    setPlatform("win32");
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";

    const keyDir = getKeyConfigDir();
    const dataDir = getDefaultDataDir();

    expect(keyDir).not.toBe(dataDir);
    expect(keyDir).toBe(path.join("C:\\Users\\test\\AppData\\Local", "gigradar-config"));
    expect(dataDir).toBe(path.join("C:\\Users\\test\\AppData\\Local", "gigradar"));
  });

  it("simulated win32 fallback: getKeyConfigDir() returns the exact same, stable path on repeated calls (not randomized)", () => {
    setPlatform("win32");
    delete process.env.XDG_CONFIG_HOME;
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local";

    const first = getKeyConfigDir();
    const second = getKeyConfigDir();
    const third = getKeyConfigDir();

    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("simulated POSIX fallback (no XDG env vars set): getKeyConfigDir() and getDefaultDataDir() remain unchanged from their current, already-correct behavior — no regression", () => {
    setPlatform("linux");
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;

    const keyDir = getKeyConfigDir();
    const dataDir = getDefaultDataDir();

    expect(keyDir).toBe(path.join(os.homedir(), ".config", "gigradar"));
    expect(dataDir).toBe(path.join(os.homedir(), ".local", "share", "gigradar"));
    expect(keyDir).not.toBe(dataDir);
  });
});
