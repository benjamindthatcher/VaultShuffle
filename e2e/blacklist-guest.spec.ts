import { expect, test, type Page } from "@playwright/test";

async function dismissAnalyticsBanner(page: Page) {
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
}

test("a guest can blacklist then manually reactivate a Library game", async ({ page }) => {
  await page.goto("/library");
  await dismissAnalyticsBanner(page);

  const blacklist = page.getByRole("button", { name: "Blacklist", exact: true }).first();
  await expect(blacklist).toBeVisible({ timeout: 30_000 });
  const card = blacklist.locator("xpath=ancestor::article[1]");
  const title = await card.getByRole("heading").first().innerText();
  await blacklist.click();

  const blacklistedTab = page.getByRole("tab", { name: /^Blacklisted/ });
  await expect(blacklistedTab).toHaveAttribute("aria-selected", "false");
  await blacklistedTab.click();
  await expect(page.getByRole("tabpanel", { name: "blacklisted games" }).getByText(title, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Reactivate" }).click();
  await page.getByRole("tab", { name: /^Active/ }).click();
  await expect(page.getByRole("tabpanel", { name: "active games" }).getByText(title, { exact: true })).toBeVisible();
});
