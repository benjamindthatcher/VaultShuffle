import { expect, test, type Page } from "@playwright/test";

/**
 * The guest Vault, which is the only flow that can be exercised without a real
 * Steam account. It runs the same components, pool and draw code as a signed-in
 * library, so a break in any of them shows up here.
 */

async function dismissAnalyticsBanner(page: Page) {
  const gotIt = page.getByRole("button", { name: "Got it" });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
}

async function openVault(page: Page) {
  await page.goto("/vault");
  await dismissAnalyticsBanner(page);
  // The draw controls only exist once the guest catalogue has resolved.
  await expect(page.getByRole("button", { name: /just pick something/i })).toBeEnabled({ timeout: 30_000 });
}

/**
 * The title of whatever the Vault is currently showing as the pick.
 *
 * Scoped to the result card itself. Matching any section containing "Current
 * pick" also matched the page wrapper, whose first heading is the visually
 * hidden "Vault" - so the assertions passed whether or not a pick existed.
 */
function pickTitle(page: Page) {
  return page.locator('[class*="resultCard"]').getByRole("heading", { level: 2 }).first();
}

test("a guest can set a session, mood and goal and get a pick", async ({ page }) => {
  await openVault(page);

  await page.getByRole("button", { name: /^Session/ }).click();
  await page.getByRole("button", { name: /Short Session/i }).first().click();
  await page.getByRole("button", { name: /Chill/i }).first().click();
  await page.getByRole("button", { name: /Surprise Me/i }).first().click();

  await page.getByRole("button", { name: /^Open the Vault|^Draw/i }).first().click();

  await expect(pickTitle(page)).toBeVisible({ timeout: 30_000 });
  await expect(pickTitle(page)).not.toBeEmpty();
});

test("a guest can skip the setup entirely and still get a pick", async ({ page }) => {
  await openVault(page);

  await page.getByRole("button", { name: /just pick something/i }).click();

  await expect(pickTitle(page)).toBeVisible({ timeout: 30_000 });
  await expect(pickTitle(page)).not.toBeEmpty();
});

test("a pick can be rerolled, and the result is openable on Steam", async ({ page }) => {
  await openVault(page);

  await page.getByRole("button", { name: /just pick something/i }).click();
  await expect(pickTitle(page)).toBeVisible({ timeout: 30_000 });
  const first = await pickTitle(page).innerText();

  // Rerolling lives in the draw bar above the card, not in the card's actions.
  await page.getByRole("button", { name: /just pick something/i }).click();
  await expect(pickTitle(page)).toBeVisible({ timeout: 30_000 });
  await expect(pickTitle(page)).not.toHaveText(first, { timeout: 30_000 });

  // The whole point of the product: a way out to the game itself.
  const openOnSteam = page.getByRole("link", { name: /on Steam/i }).first();
  await expect(openOnSteam).toBeVisible();
  await expect(openOnSteam).toHaveAttribute("href", /steam/i);
});
