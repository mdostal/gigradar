// Where the vault's symmetric encryption key lives on disk. Deliberately a
// SEPARATE directory tree from src/lib/store/path.ts's getDefaultDataDir()
// (XDG_DATA_HOME) — see docs/ARCHITECTURE.md and
// .pHive/epics/encrypted-local-storage/docs/design-discussion.md §3 step 1:
// the epic's core security property is that the key never lives next to the
// data it protects (config.json, .env, session files all live under
// XDG_DATA_HOME). This mirrors getDefaultDataDir()'s exact XDG-resolution
// structure, just rooted at XDG_CONFIG_HOME instead.
import os from "node:os";
import path from "node:path";

const APP_DIR_NAME = "gigradar";
const KEY_FILE_NAME = "key";

/**
 * The directory the vault's key file lives in. Resolution order:
 *  1. `XDG_CONFIG_HOME` (the XDG Base Directory spec — respected on any OS
 *     if set).
 *  2. Platform fallback: `~/.config/gigradar` on macOS/Linux/other POSIX,
 *     `%LOCALAPPDATA%\gigradar` (or `~/AppData/Local/gigradar`) on Windows —
 *     same Windows convention as getDefaultDataDir(), since Windows has no
 *     first-class equivalent split between "config" and "data" the way XDG
 *     does on POSIX.
 */
export function getKeyConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return path.join(xdgConfigHome, APP_DIR_NAME);

  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, APP_DIR_NAME);
  }

  return path.join(os.homedir(), ".config", APP_DIR_NAME);
}

/** Full path to the vault's key file (does not imply it exists yet). */
export function getKeyPath(): string {
  return path.join(getKeyConfigDir(), KEY_FILE_NAME);
}
