import { expect, test } from "@playwright/test";

// deep-dive-audit-and-testing-framework epic, playwright-e2e-scaffold-and-ci
// story. Proves the contextual hover-chat panel (chat-copilot-self-tuning
// epic, Slice 2) opens from a real giglist row and accepts input, without
// ever making a real LLM call -- the seeded fixture config has no
// Anthropic credential configured, so submitting a message deterministically
// surfaces the real, user-facing "no Anthropic credential" error via the
// real Server Action round-trip. This is a stronger, more honest proof the
// wiring works end to end than mocking the network layer would be.
//
// dashboard-drafts-data-integrity epic, relocate-giglist-to-all-gigs
// story: the giglist (and its rows) moved from "/" to "/gigs".
test("the contextual chat panel opens from a giglist row and accepts input", async ({ page }) => {
  await page.goto("/gigs");

  const row = page.locator("tr", { has: page.getByRole("link", { name: "Fractional CTO at Acme" }) });
  await row.hover();
  await row.getByRole("button", { name: /^ask about/i }).click();

  const chattingAbout = page.getByText("Chatting about");
  await expect(chattingAbout).toBeVisible();
  // The context label sits in the very next paragraph within the same header block.
  await expect(chattingAbout.locator("xpath=following-sibling::p[1]")).toHaveText("Fractional CTO at Acme");

  const input = page.getByPlaceholder("Ask about this…");
  await input.fill("why did this match?");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(/no Anthropic credential/)).toBeVisible();
});
