import { expect, test, type Page } from "@playwright/test";

const session = { logged_in: true, account_type: "manual", identity_verified: false, user_id: "library-test", steam_id: "76561198000000000", display_name: "Library tester", steam_display_name: "Library tester", avatar_url: "", has_steam_key: false };
const games = Array.from({ length: 130 }, (_, i) => ({
  id: `library-${i}`, user_id: session.user_id, title: `Library Game ${String(i).padStart(3, "0")}`,
  genre: "Adventure", store: "Steam", ownership: "Owned", status: "Not Started", rating: 0,
  hours_played: 0, completion_percentage: 0, priority: "Medium", date_added: null,
  last_played_at: null, notes: "", steam_appid: 620 + i, header_url: "/assets/vault/vault-stage-open.png",
}));
const emptyVault = { pinnedIds: [] as string[], pins: [], snoozedIds: [], currentPickId: null };

async function fixture(page: Page, { failFirst = false, delay = 0 } = {}) {
  const stored = structuredClone(games);
  const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let bootstrapReads = 0;
  await page.addInitScript(() => localStorage.setItem("vault-cookie-consent", "disabled"));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/app-data") {
      bootstrapReads++;
      return route.fulfill({ json: { session, games: stored, collections: [], memberships: [], vaultState: emptyVault } });
    }
    if (path.startsWith("/api/games/") && route.request().method() === "PATCH") {
      const id = path.split("/").at(-1)!;
      const patch = route.request().postDataJSON();
      writes.push({ id, patch });
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (failFirst && writes.length === 1) return route.fulfill({ status: 400, json: { error: "Test save rejected" } });
      const game = stored.find(entry => entry.id === id)!;
      Object.assign(game, patch.restore_active ? { status: "Not Started", completed_at: null, slept_at: null } : patch);
      return route.fulfill({ json: game });
    }
    if (path === "/api/steam/owned-games") return route.fulfill({ json: { progress: { status: "idle", imported: 0, total: 0, percent: 0, playHistoryMissing: false, lastError: null, startedAt: null, completedAt: null } } });
    if (path === "/api/session") return route.fulfill({ json: session });
    return route.fulfill({ json: {} });
  });
  await page.goto("/library", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tab", { name: "Active 130", exact: true })).toBeVisible();
  return { stored, writes, reads: () => bootstrapReads };
}

const cards = (page: Page) => page.locator("article[data-game-id]");
const card = (page: Page, id = 0) => page.locator(`article[data-game-id="library-${id}"]`);
const undo = (page: Page) => page.locator("[data-library-undo]").getByRole("button", { name: "Undo", exact: true });

for (const action of ["Blacklist", "Complete"] as const) {
  test(`Active bulk ${action} updates all selected games immediately and supports batch Undo`, async ({ page }) => {
    const state = await fixture(page, { delay: 900 });
    if (action === "Complete") await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await card(page, 0).getByRole("checkbox").check();
    await card(page, 1).getByRole("checkbox").check();
    const button = page.getByRole("button", { name: `${action} 2`, exact: true });
    await button.scrollIntoViewIfNeeded();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/library-bulk-${action.toLowerCase()}.png`, animations: "disabled" });
    await button.click();
    await expect(page.getByRole("tab", { name: "Active 128", exact: true })).toBeVisible();
    await expect(card(page, 0)).toHaveCount(0);
    await expect(card(page, 1)).toHaveCount(0);
    await expect(card(page, 2)).toBeAttached();
    await undo(page).click();
    await expect(page.getByRole("tab", { name: "Active 130", exact: true })).toBeVisible();
    await expect.poll(() => state.writes.length).toBe(4);
    await expect.poll(() => state.stored.slice(0, 2).map(game => game.status)).toEqual(["Not Started", "Not Started"]);
    expect(state.writes.map(write => write.patch.status)).toEqual([
      action === "Blacklist" ? "Slept" : "Completed", action === "Blacklist" ? "Slept" : "Completed", "Not Started", "Not Started",
    ]);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Active 130", exact: true })).toBeVisible();
  });
}

test("bulk partial failure restores the failed game and keeps Undo for the saved game", async ({ page }) => {
  const state = await fixture(page, { failFirst: true, delay: 200 });
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await card(page, 0).getByRole("checkbox").check();
  await card(page, 1).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Blacklist 2", exact: true }).click();
  await expect.poll(() => state.reads()).toBeGreaterThan(1);
  await expect(page.getByRole("tab", { name: "Active 129", exact: true })).toBeVisible();
  await expect(page.locator("[data-library-undo]")).toContainText("1 game blacklisted");
  await undo(page).click();
  await expect.poll(() => state.stored.slice(0, 2).map(game => game.status)).toEqual(["Not Started", "Not Started"]);
  expect(state.writes.map(write => write.id)).toEqual(["library-0", "library-1", "library-1"]);
});

test("blacklist then immediate Undo is optimistic and persists the final choice", async ({ page }) => {
  const state = await fixture(page, { delay: 900 });
  await card(page).getByRole("button", { name: "Blacklist", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Active 129", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Blacklisted 1", exact: true })).toBeVisible();
  await undo(page).click();
  await expect(card(page)).toBeVisible();
  await expect.poll(() => state.writes.length).toBe(2);
  await expect.poll(() => state.stored[0].status).toBe("Not Started");
  expect(state.writes.map(entry => entry.patch.status)).toEqual(["Slept", "Not Started"]);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Active 130", exact: true })).toBeVisible();
});

test("a failed background save restores the game and reports the failure", async ({ page }) => {
  const state = await fixture(page, { failFirst: true, delay: 600 });
  await card(page).getByRole("button", { name: "Blacklist", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await expect.poll(() => state.reads()).toBeGreaterThan(1);
  await expect(card(page)).toBeVisible();
  await expect(page.getByText(/could not be saved/i)).toBeVisible();
  await expect(undo(page)).toHaveCount(0);
});

test("decided cards open details; checkboxes select; completion Undo restores Blacklisted", async ({ page }) => {
  await fixture(page);
  await card(page).getByRole("button", { name: "Blacklist", exact: true }).click();
  await page.getByRole("tab", { name: "Blacklisted 1", exact: true }).click();
  await card(page).getByRole("button", { name: "Details for Library Game 000", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Blacklisted", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await card(page).getByRole("checkbox").check();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Complete", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Completed 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).first().click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Completed 0", exact: true })).toBeVisible();
  await card(page).getByRole("button", { name: "Reactivate", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Active 130", exact: true })).toBeVisible();
});

test("removing a game beyond the first batch preserves the mounted list", async ({ page }) => {
  await fixture(page);
  await card(page, 59).scrollIntoViewIfNeeded();
  await expect.poll(() => cards(page).count()).toBeGreaterThan(60);
  await card(page, 75).getByRole("button", { name: "Blacklist", exact: true }).click();
  await expect(card(page, 75)).toHaveCount(0);
  await expect(card(page, 76)).toBeVisible();
  expect(await cards(page).count()).toBeGreaterThan(60);
});

test("mobile grid and list keep every core action visible with no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  for (const mode of ["Grid", "List"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await card(page).scrollIntoViewIfNeeded();
    for (const action of ["Blacklist", "Complete", "Playing Next"]) {
      const button = card(page).getByRole("button", { name: action, exact: true });
      await expect(button).toBeVisible();
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  }
  await page.screenshot({ path: "/tmp/library-mobile.png" });
});

test("guest Playing Next replaces with one choice and supports Undo", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vault-cookie-consent", "disabled"));
  await page.route("**/api/app-data", route => route.fulfill({ json: { session: { ...session, logged_in: false, account_type: "guest" } } }));
  await page.route("**/guest-catalogue", route => route.fulfill({ json: { games: games.slice(0, 8) } }));
  await page.goto("/library", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tab", { name: "Active 8", exact: true })).toBeVisible();
  for (let id = 0; id < 3; id++) await card(page, id).getByRole("button", { name: "Playing Next", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Active 5", exact: true })).toBeVisible();
  await card(page, 3).getByRole("button", { name: "Playing Next", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Replace Library Game 000", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card(page, 3)).toHaveCount(0);
  await expect(card(page, 0)).toBeVisible();
  await undo(page).click();
  await expect(card(page, 0)).toHaveCount(0);
  await expect(card(page, 3)).toBeVisible();
});

test("toolbar selection is explicit; Sort and Filters apply keyboard choices immediately", async ({ page }) => {
  await fixture(page);
  await expect(page.getByText("A few games in the preview")).toHaveCount(0);
  await expect(card(page).getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await card(page).getByRole("button", { name: "Select Library Game 000", exact: true }).click();
  await expect(card(page).getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(card(page).getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Sort: Playtime", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Sort: Title", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Reverse current sort order" }).click();
  await expect(cards(page).first()).toHaveAttribute("data-game-id", "library-129");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const filters = page.getByRole("group", { name: "Library filters", exact: true });
  await filters.getByRole("button", { name: "In progress", exact: true }).click();
  await expect(cards(page)).toHaveCount(0);
  await expect(filters.getByText("1 active filter", { exact: true })).toBeVisible();
  await filters.getByRole("button", { name: "Clear all", exact: true }).click();
  await filters.getByRole("checkbox", { name: "Adventure", exact: true }).check();
  await expect(filters.getByText("1 selected", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/library-filters.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /Filters/ })).toBeFocused();
  await page.getByRole("textbox", { name: "Search games" }).fill("Game 000");
  await expect(cards(page)).toHaveCount(1);
  await card(page).getByRole("button", { name: "Details for Library Game 000", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Game details", { exact: true })).toBeVisible();
  await expect(dialog.getByText("0 collections", { exact: true })).toBeVisible();
  const steam = dialog.getByRole("link", { name: "Play on Steam", exact: true });
  await expect(steam).toHaveAttribute("href", "steam://run/620");
  await expect(steam).not.toHaveAttribute("target", "_blank");
  await expect(dialog.locator("textarea")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/library-details.png", animations: "disabled" });
});

test.describe("mobile details Steam action", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test("normal details keeps the Steam store fallback on touch devices", async ({ page }) => {
    await fixture(page);
    await card(page).getByRole("button", { name: "Details for Library Game 000", exact: true }).click();
    const steam = page.getByRole("dialog").getByRole("link", { name: "View on Steam", exact: true });
    await expect(steam).toHaveAttribute("href", "https://store.steampowered.com/app/620/");
    await expect(steam).toHaveAttribute("target", "_blank");
  });
});

test.describe("genre row pointer interaction", () => {
  test.use({ hasTouch: true });
  for (const mobile of [false, true]) {
    test(`genre labels and indicators toggle without dismissing Filters on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
      await fixture(page);
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      const trigger = page.getByRole("button", { name: "Filters", exact: true });
      const panel = page.getByRole("group", { name: "Library filters", exact: true });
      await trigger.click();
      const genre = panel.getByText("Adventure", { exact: true });
      if (mobile) await genre.tap();
      else await genre.click();
      await expect(panel).toBeVisible();
      const checkbox = panel.getByRole("checkbox", { name: "Adventure", exact: true });
      await expect(checkbox).toBeChecked();
      const indicator = panel.locator("label").filter({ hasText: "Adventure" }).locator('span[aria-hidden="true"]');
      if (mobile) await indicator.tap();
      else await indicator.click();
      await expect(checkbox).not.toBeChecked();
      await expect(panel).toBeVisible();
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).toBeChecked();
      await page.keyboard.press("Tab");
      await expect(panel).toBeHidden();
      await page.getByRole("button", { name: /Filters/ }).click();
      await page.getByRole("textbox", { name: "Search games" }).click();
      await expect(panel).toBeHidden();
    });
  }
});

test("adding to Playing Next preserves the current Library scroll position", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("vault-cookie-consent", "disabled"); localStorage.setItem("vault-analytics-notice-seen", "1"); });
  await page.route("**/api/app-data", route => route.fulfill({ json: { session: { ...session, logged_in: false, account_type: "guest" } } }));
  await page.route("**/guest-catalogue", route => route.fulfill({ json: { games } }));
  await page.goto("/library", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("tab", { name: "Active 130", exact: true })).toBeVisible();
  await card(page, 30).getByRole("button", { name: "Playing Next", exact: true }).scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    // Capture at the actual click, after Playwright's automatic scrolling.
    document.addEventListener("click", () => {
      document.documentElement.dataset.pinClickScrollY = String(scrollY);
    }, { capture: true, once: true });
  });
  await card(page, 30).getByRole("button", { name: "Playing Next", exact: true }).click();
  await expect(card(page, 30)).toHaveCount(0);
  const before = await page.evaluate(() => Number(document.documentElement.dataset.pinClickScrollY));
  expect(Math.abs(await page.evaluate(() => scrollY) - before)).toBeLessThan(3);
});
