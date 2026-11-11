import { expect, test } from "@playwright/test";

// gate-reasons-in-dashboard story. Proves the per-rule gate reasons reach
// the real UI end to end: the All Gigs ⚠ tooltip lists the failed rules
// (not the old generic copy) and the detail panel's Gate check section
// shows every rule with its concrete reason. Gigs/config are seeded by
// global-setup.ts (e2e-3: $26/hr + not remote; e2e-4: contract-to-hire).
test("the ⚠ tooltip lists failed rules and the detail panel shows every rule's reason", async ({ page }) => {
  await page.goto("/gigs");

  const row = page.locator("tr", { has: page.getByRole("link", { name: "Fractional CTO at Initech" }) });
  const warning = row.getByRole("button", { name: /Didn't pass 2 rules/ });
  await expect(warning).toHaveAttribute("aria-label", /Hourly: \$26\/hr is below your \$150\/hr floor/);
  await expect(warning).toHaveAttribute("aria-label", /Remote only: listing is not remote — you require remote/);
  await warning.hover();
  await expect(row.getByRole("tooltip")).toContainText("Hourly: $26/hr is below your $150/hr floor");
  await expect(row.getByRole("tooltip")).not.toContainText("didn't meet your configured");

  const cthRow = page.locator("tr", { has: page.getByRole("link", { name: "Fractional CTO at Globex" }) });
  await expect(cthRow.getByRole("button", { name: /Engagement type: contract-to-hire is excluded/ })).toBeVisible();

  await row.getByRole("button", { name: "View →" }).click();
  const gateCheck = page.getByRole("dialog").getByRole("region", { name: "Gate check" });
  await expect(gateCheck).toContainText("Didn't pass");
  await expect(gateCheck.locator('[data-rule-id="profile:p1"]')).toHaveAttribute("data-outcome", "fail");
  await expect(gateCheck.locator('[data-rule-id="profile:p1"]')).toContainText("$26/hr is below your $150/hr floor");
  await expect(gateCheck.locator('[data-rule-id="remote"]')).toHaveAttribute("data-outcome", "fail");
  await expect(gateCheck.locator('[data-rule-id="role-fit"]')).toHaveAttribute("data-outcome", "pass");
  await expect(gateCheck.locator('[data-rule-id="role-area"]')).toContainText('title matches your core title "fractional cto"');
});
