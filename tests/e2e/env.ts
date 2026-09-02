// Computed exactly ONCE per test run (module-level, not per-import) so
// playwright.config.ts's webServer env and global-setup.ts's seeding both
// agree on the SAME isolated temp data dir -- never the real
// ~/.local/share/gigradar/, same discipline vitest.setup.ts already
// established for the unit suite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const E2E_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gigradar-e2e-data-"));
export const E2E_DB_PATH = path.join(E2E_DATA_DIR, "gigradar", "gigs.db");
