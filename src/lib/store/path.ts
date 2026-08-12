// Where the gig database lives on disk. Deliberately OUTSIDE the repo tree —
// see docs/ARCHITECTURE.md: user data never lands inside src/lib or any path
// that could get committed. XDG-style so it also respects the user's own
// override on Linux (and anyone who sets XDG_DATA_HOME on macOS).
import os from "node:os";
import path from "node:path";

const APP_DIR_NAME = "gigradar";
const DB_FILE_NAME = "gigs.db";

/**
 * The directory gigradar's own data (the SQLite store, today) lives in.
 * Resolution order:
 *  1. `XDG_DATA_HOME` (the XDG Base Directory spec — respected on any OS if set).
 *  2. Platform fallback: `~/.local/share/gigradar` on macOS/Linux/other POSIX,
 *     `%LOCALAPPDATA%\gigradar` (or `~/AppData/Local/gigradar`) on Windows.
 * Never `./data` or any path inside the repo — a Next.js dev server and a
 * cron/CLI process both need a stable, non-repo location to share.
 */
export function getDefaultDataDir(): string {
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) return path.join(xdgDataHome, APP_DIR_NAME);

  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, APP_DIR_NAME);
  }

  return path.join(os.homedir(), ".local", "share", APP_DIR_NAME);
}

/** Full path to the gig database file (does not imply it exists yet). */
export function getDefaultDbPath(): string {
  return path.join(getDefaultDataDir(), DB_FILE_NAME);
}
