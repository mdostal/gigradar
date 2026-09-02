// Runs once, before playwright.config.ts's webServer starts. Seeds a small,
// real, representative fixture -- a real Config (group + profile +
// applyProfile) and a few real gigs via the real store functions, never
// hand-rolled fake rows -- into the SAME isolated temp dir the webServer
// subprocess is pointed at (tests/e2e/env.ts). Requires NODE_OPTIONS=
// --experimental-sqlite on the process running `playwright test` itself
// (see package.json's test:e2e script) -- globalSetup runs in the SAME
// process as the config, not a fresh subprocess, so the flag must already
// be set when Playwright itself was launched.
import { E2E_DATA_DIR, E2E_DB_PATH } from "./env";

export default async function globalSetup(): Promise<void> {
  process.env.XDG_DATA_HOME = E2E_DATA_DIR;
  process.env.GIGRADAR_DB_PATH = E2E_DB_PATH;

  const { saveConfig } = await import("../../src/lib/config/save");
  const { recordScan, closeDb } = await import("../../src/lib/store");

  const saveResult = saveConfig({
    profile: { name: "E2E Test User", roles: ["Fractional CTO"], skills: ["TypeScript"], timezone: "America/Chicago" },
    groups: [
      {
        id: "g1",
        label: "Fractional CTO",
        needs: {
          engagementProfiles: [
            { id: "p1", label: "Hourly", types: ["contract"], minRate: 150, highRate: 250, maxHours: 20, maxHoursAtHighRate: 40, rateUnit: "hour" },
          ],
          freshStageOnly: false,
          remoteOnly: true,
        },
        roleArea: { coreTitles: ["fractional cto"], keywords: [], redKeywords: [] },
      },
    ],
    sources: [{ id: "braintrust", enabled: true }],
    applyProfile: { email: "e2e-test@example.test" },
  } as never);
  if (!saveResult.ok) throw new Error(`e2e global-setup: saveConfig failed: ${saveResult.error}`);

  recordScan([
    {
      sourceId: "braintrust",
      gigs: [
        { sourceId: "braintrust", externalId: "e2e-1", title: "Fractional CTO at Acme", company: "Acme Robotics", url: "https://example.test/e2e-1", tier: "green" },
        { sourceId: "braintrust", externalId: "e2e-2", title: "Fractional CTO at Northwind", company: "Northwind Labs", url: "https://example.test/e2e-2", tier: "yellow" },
      ],
    },
  ]);

  closeDb();
}
