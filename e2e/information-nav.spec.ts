import { expect, test } from "@playwright/test";

const signedInSession = {
  logged_in: true,
  account_type: "steam",
  identity_verified: true,
  user_id: "test-user",
  steam_id: "76561198000000000",
  display_name: "Test player",
  steam_display_name: "Test player",
  avatar_url: "",
  has_steam_key: true,
};

test("FAQ shows the signed in app navigation before library data loads", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: signedInSession }));
  await page.route("**/api/app-data", async route => {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await route.fulfill({ status: 503, json: { error: "Library unavailable" } });
  });
  await page.route("**/api/steam/owned-games", route => route.fulfill({ json: { progress: { status: "idle" } } }));

  await page.goto("/faq");

  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 3_000 });
  await expect(nav.getByRole("link", { name: "Library" })).toBeVisible();
  await expect(page.getByText("Test player", { exact: true }).first()).toBeVisible();
});

test("FAQ retries the session after an app bootstrap failure", async ({ page }) => {
  let sessionAvailable = false;
  await page.route("**/api/session", route => sessionAvailable
    ? route.fulfill({ json: signedInSession })
    : route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }));
  await page.route("**/api/app-data", route => route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } }));
  await page.route("**/api/steam/owned-games", route => route.fulfill({ json: { progress: { status: "idle" } } }));

  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "FAQ" })).toBeVisible();
  sessionAvailable = true;
  await page.getByRole("link", { name: "FAQ" }).click();

  await expect(page).toHaveURL(/\/faq$/);
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Test player", { exact: true }).first()).toBeVisible();
});

test("FAQ keeps the public header for guests", async ({ page }) => {
  await page.route("**/api/session", route => route.fulfill({ json: { ...signedInSession, logged_in: false, account_type: "guest" } }));
  await page.goto("/faq");

  await expect(page.getByRole("heading", { name: "VaultShuffle FAQ" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
});
