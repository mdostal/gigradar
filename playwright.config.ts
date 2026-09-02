// deep-dive-audit-and-testing-framework epic, playwright-e2e-scaffold-and-ci
// story. Real, committed E2E coverage -- the deep-dive audit found zero
// Playwright specs existed anywhere in this repo, and zero CI workflow
// gated a PR on anything at all (only the tag-triggered release pipeline).
//
// webServer runs the REAL production build (npm run build && npm run
// start), matching CLAUDE.md's own "npm run build && npm run start" browser
// runtime mode -- never `npm run dev`, since that's not what any real user
// or the packaged app actually runs. XDG_DATA_HOME/GIGRADAR_DB_PATH point
// at an isolated temp dir seeded by tests/e2e/fixtures/seed.ts, same
// "never touch the real data dir" discipline vitest.setup.ts already
// established for the unit suite -- see that file's own header comment for
// the full "why XDG_DATA_HOME not GIGRADAR_DB_PATH" reasoning, which
// applies identically here.
import { defineConfig, devices } from "@playwright/test";
import { E2E_DATA_DIR, E2E_DB_PATH } from "./tests/e2e/env";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // all specs share one seeded server/DB -- see global-setup.ts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run start -- -p 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      XDG_DATA_HOME: E2E_DATA_DIR,
      GIGRADAR_DB_PATH: E2E_DB_PATH,
      NODE_OPTIONS: "--experimental-sqlite",
    },
  },
});
