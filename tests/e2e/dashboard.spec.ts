import { expect, test } from "@playwright/test";

// deep-dive-audit-and-testing-framework epic, playwright-e2e-scaffold-and-ci
// story. Proves the giglist actually renders real, seeded gig data end to
// end (global-setup.ts seeds 2 real gigs via the real store) -- the exact
// kind of regression class this repo's own docs previously accepted
// "live-verified on the owner's real machine" as the terminal check for.
//
// dashboard-drafts-data-integrity epic, relocate-giglist-to-all-gigs
// story: this table moved from "/" to "/gigs" -- "/" is now the real
// Dashboard (glance tiles/Today/metrics teaser), a different page this
// spec deliberately does not cover (no seeded-gig-row assertions apply
// there).
test("the giglist loads and shows the seeded gigs with correct fields", async ({ page }) => {
  await page.goto("/gigs");

  await expect(page.getByRole("link", { name: "Fractional CTO at Acme" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Fractional CTO at Northwind" })).toBeVisible();

  const row = page.locator("tr", { has: page.getByRole("link", { name: "Fractional CTO at Acme" }) });
  await expect(row.getByText("Acme Robotics")).toBeVisible();
});
