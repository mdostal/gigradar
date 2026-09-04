import { expect, test } from "@playwright/test";

// deep-dive-audit-and-testing-framework epic, playwright-e2e-scaffold-and-ci
// story. Catches exactly the regression class flagged as high-severity in
// dashboard-results-view.yaml's own risk section: a save that doesn't
// actually persist/revalidate. Edits a real field, saves, reloads, and
// asserts the CHANGE survived a real page reload -- not just that the
// in-memory React state updated.
//
// config-dashboard-and-section-pages story: "/config" is now the
// dashboard home (cards, no form fields) -- the Profile FORM itself moved
// to "/config/profile".
test("editing the profile name, saving, and reloading persists the change", async ({ page }) => {
  await page.goto("/config/profile");

  const nameInput = page.getByLabel("Name", { exact: true });
  await expect(nameInput).toHaveValue("E2E Test User");

  await nameInput.fill("E2E Test User (edited)");
  await page.getByRole("button", { name: "Save config" }).click();
  await expect(page.getByRole("status")).toContainText("Saved");

  await page.reload();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("E2E Test User (edited)");
});
