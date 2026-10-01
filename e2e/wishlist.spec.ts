import { expect, test } from "@playwright/test";
import { decodeCatalogue, encodeCatalogue } from "../lib/catalogue-wire";
import type { WishlistGame } from "../lib/wishlist";

// UI flows use deterministic provider details; the public catalogue itself is
// read from the selected runtime and checked separately against real V2 data.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/wishlist/details?*", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { games: (params.get("ids") ?? "").split(",").filter(Boolean).map(Number).map(appId => ({
      appId, description: "A Steam store adventure.", storeStatus: "available",
      price: { current: "£8.99", discount: 0, country: params.get("country") ?? "GB", currency: "GBP", amountMinor: 899 },
    })) } });
  });
});

test("wishlist saves persist, shape suggestions, and can be removed", async ({ page }) => {
  await page.goto("/wishlist");
  const suggestions = page.getByRole("region", { name: "Worth a spot on your wishlist" });
  await expect(suggestions.locator("article")).toHaveCount(9, { timeout: 30000 });
  const title = await suggestions.getByRole("heading", { level: 3 }).first().innerText();
  const beforeIds = await suggestions.locator("article").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-appid")));
  await page.getByRole("button", { name: `Add ${title} to wishlist`, exact: true }).scrollIntoViewIfNeeded();
  // Let Playwright finish bringing the click target clear of fixed notices
  // before measuring application-induced scrolling.
  await page.getByRole("button", { name: `Add ${title} to wishlist`, exact: true }).click({ trial: true });
  // html uses smooth scrolling. Explicitly finish setup scrolling rather than
  // measuring its final animation frame as movement caused by saving.
  await page.getByRole("button", { name: `Add ${title} to wishlist`, exact: true }).evaluate(node => node.scrollIntoView({ behavior: "instant", block: "center" }));
  const beforeScroll = await page.evaluate(() => scrollY);
  await page.getByRole("button", { name: `Add ${title} to wishlist`, exact: true }).click();
  const saved = page.getByRole("region", { name: "Your wishlist 1", exact: true });
  await expect(saved.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(suggestions.getByRole("button", { name: `Remove ${title} from wishlist`, exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await suggestions.locator("article").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-appid")))).toEqual(beforeIds);
  expect(Math.abs(await page.evaluate(() => scrollY) - beforeScroll)).toBeLessThanOrEqual(1);
  await page.reload();
  await expect(saved.getByRole("button", { name: `Remove ${title} from wishlist`, exact: true })).toBeEnabled();
  await saved.getByRole("button", { name: `Remove ${title} from wishlist`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your wishlist 0", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Make room for your next favourite.", exact: true })).toBeVisible();
});

test("Steam search saves a real result, filters update and import explains profile connection", async ({ page }) => {
  await page.goto("/wishlist");
  await page.getByRole("searchbox", { name: "Search the Steam store" }).fill("Balatro");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const results = page.getByRole("region", { name: "Results for “Balatro”" });
  await expect(results.getByRole("heading", { name: "Balatro", exact: true })).toBeVisible({ timeout: 30000 });
  await results.getByRole("button", { name: "Add Balatro to wishlist", exact: true }).click();
  await expect(results.getByRole("button", { name: "Remove Balatro from wishlist", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close results", exact: true }).click();
  await expect(results).toHaveCount(0);
  await page.getByRole("button", { name: "Short & sweet", exact: true }).click();
  await expect(page.getByRole("button", { name: "Short & sweet", exact: true })).toHaveAttribute("aria-pressed", "true");
  const suggestions = page.getByRole("region", { name: "Worth a spot on your wishlist" });
  await expect(suggestions.locator("article")).toHaveCount(9, { timeout: 20000 });
  for (const text of await suggestions.locator("article").allTextContents()) expect(text).toMatch(/~(?:[1-9]|10)h story/);
  await expect(page.getByRole("button", { name: "Budget picks", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import Steam wishlist", exact: true }).click();
  await expect(page.getByRole("link", { name: "Connect Steam profile" })).toBeVisible();
});

test("Budget picks uses verified regional prices and shuffles in place", async ({ page }) => {
  const games = Array.from({ length: 72 }, (_, i) => ({ appId: i + 1, title: `Discovery ${i + 1}world`, image: "", genres: ["Adventure"], tags: { Adventure: 100 }, positive: 940, reviews: 1000 }));
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: encodeCatalogue(games) }));
  await page.route("**/api/wishlist/details?*", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { games: params.get("ids")!.split(",").map(Number).map((appId) => ({ appId, description: "A compact adventure.", storeStatus: "available", price: { current: appId % 3 === 0 ? "£14.99" : "£8.99", discount: 0, country: "GB", currency: "GBP", amountMinor: appId % 3 === 0 ? 1499 : 899 } })) } });
  });
  await page.goto("/wishlist");
  await page.getByRole("button", { name: "Budget picks", exact: true }).click();
  const cards = page.getByRole("region", { name: "Worth a spot on your wishlist" }).locator("article");
  await expect(cards).toHaveCount(9, { timeout: 20000 });
  await expect(cards.first().getByLabel("Steam price")).toContainText("£8.99");
  const firstIds = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-appid")));
  const shuffle = page.getByRole("button", { name: "Refresh picks", exact: true }).last();
  await shuffle.scrollIntoViewIfNeeded();
  const beforeScroll = await page.evaluate(() => scrollY);
  await shuffle.click();
  const secondIds = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-appid")));
  expect(secondIds.every((id) => !firstIds.includes(id))).toBe(true);
  expect(Math.abs(await page.evaluate(() => scrollY) - beforeScroll)).toBeLessThanOrEqual(1);
  await expect(page.getByText(/Selection \d/)).toHaveCount(0);
  await expect(page.getByText("How these picks work")).toHaveCount(0);
  await expect(cards.first().getByRole("link", { name: "View on Steam" })).toBeVisible();
  expect(await cards.first().locator("a").count()).toBe(1);
});

test("legacy route and navigation reach Wishlist, including on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/wishlist");
  const content = page.locator('main > [data-vault-controls="standard"]');
  await expect(content).toBeVisible();
  const wishlistBounds = await content.boundingBox();
  const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
  for (const destination of ["Library", "Dashboard", "Collections"]) {
    await navigation.getByRole("link", { name: destination, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${destination.toLowerCase()}$`));
    await expect(content).toBeVisible();
    const bounds = await content.boundingBox();
    expect(wishlistBounds?.width).toBe(bounds?.width);
    expect(wishlistBounds?.x).toBe(bounds?.x);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/play-next");
  await expect(page).toHaveURL(/\/wishlist$/);
  await expect(page).toHaveTitle("Wishlist | VaultShuffle");
  await expect(page.getByRole("complementary", { name: "Wishlist guest preview" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Dashboard", exact: true }).click();
  await page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "Wishlist", exact: true }).click();
  await expect(page).toHaveURL(/\/wishlist$/);
});

test("reshuffles prepare unique batches and keep every card locked while details load", async ({ page }) => {
  await page.route("**/wishlist-catalogue*", async (route) => {
    const response = await route.fetch();
    const games = decodeCatalogue<WishlistGame>(await response.json());
    await route.fulfill({ json: encodeCatalogue(games.map(game => ({ ...game, title: `${game.title}: A deliberately long adventure title that exceeds two lines and needs truncation` }))) });
  });
  await page.route("**/api/wishlist/details?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: { games: params.get("ids")!.split(",").map(Number).map((appId) => ({ appId, title: "A deliberately long game title that takes more than two lines and must be clipped consistently", description: "A very long Steam description. ".repeat(40), storeStatus: "available", price: { current: "£19.99", original: "£39.99", discount: 50, country: "GB" } })) } });
  });
  await page.goto("/wishlist");
  const region = page.getByRole("region", { name: "Worth a spot on your wishlist" });
  const cards = region.locator("article");
  await expect(cards).toHaveCount(9, { timeout: 20000 });
  await expect(cards.first().getByLabel("Steam price")).toContainText("£19.99");
  const sizes = () => cards.evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  const initial = await sizes();
  expect(new Set(initial.map((size) => size.height)).size).toBe(1);
  const positions = await cards.evaluateAll((nodes) => nodes.map((node) => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })));
  expect(new Set(positions.map((position) => position.x)).size).toBe(3);
  expect(new Set(positions.map((position) => position.y)).size).toBe(3);
  const seen = new Set<string>();
  for (let batch = 0; batch < 4; batch++) {
    const ids = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-appid")!));
    expect(ids.every((id) => !seen.has(id))).toBe(true);
    ids.forEach((id) => seen.add(id));
    expect(await sizes()).toEqual(initial);
    const before = ids[0];
    await page.getByRole("button", { name: "Refresh picks", exact: true }).last().click();
    await expect(cards.first()).not.toHaveAttribute("data-appid", before);
  }
  await page.getByRole("button", { name: "Find your first game", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search the Steam store" })).toBeFocused();
  expect(await page.getByRole("searchbox").evaluate((node) => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; })).toBe(true);
});

test("connected preview excludes the complete library and import failures preserve saved entries", async ({ page }) => {
  const session = { logged_in: true, account_type: "manual", identity_verified: false, user_id: "wishlist-test", steam_id: "76561198000000000", display_name: "Wishlist tester", steam_display_name: "Wishlist tester", avatar_url: "", has_steam_key: false };
  const catalogue = Array.from({ length: 48 }, (_, i) => ({ appId: i + 1, title: `Adventure ${String.fromCharCode(65 + i)}world`, image: "", genres: ["Adventure"], tags: { Adventure: 100 }, minutes: 240, positive: 900, reviews: 1000 }));
  const owned = catalogue.slice(0, 3).map((game, i) => ({
    id: `owned-${i}`, user_id: session.user_id, title: game.title, steam_appid: String(game.appId),
    genre: "Adventure", ownership: i === 1 ? "Family Shared" : "Owned", access_source: i === 1 ? "family" : "owned", store: "Steam",
    status: i === 2 ? "Blacklisted" : "Completed", hours_played: 40, rating: 0, completion_percentage: 100,
    priority: "Medium", notes: "", date_added: null, last_played_at: null,
  }));
  let imported = false;
  let failImport = false;
  await page.addInitScript(() => localStorage.setItem("vault-cookie-consent", "disabled"));
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games: catalogue } }));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/app-data") return route.fulfill({ json: { session, games: owned, collections: [], memberships: [], vaultState: { pinnedIds: [], pins: [], snoozedIds: [], currentPickId: null } } });
    if (path === "/api/session") return route.fulfill({ json: session });
    if (path === "/api/wishlist") return route.fulfill({ json: { games: imported ? [catalogue[3]] : [], appIds: imported ? [4] : [], total: imported ? 1 : 0 } });
    if (path === "/api/wishlist/import") {
      if (failImport) return route.fulfill({ status: 422, json: { error: "Steam cannot share this wishlist. Check your privacy settings." } });
      imported = true;
      return route.fulfill({ json: { imported: 1 } });
    }
    if (path === "/api/wishlist/details") return route.fulfill({ json: { games: [] } });
    return route.fulfill({ json: { members: [], draws: [], progress: { status: "idle" } } });
  });
  await page.goto("/wishlist");
  const cards = page.getByRole("region", { name: "Worth a spot on your wishlist" }).locator("article");
  await expect(cards).toHaveCount(9, { timeout: 20000 });
  await expect(page.getByRole("complementary", { name: "Wishlist guest preview" })).toHaveCount(0);
  for (let batch = 0; batch < 3; batch++) {
    expect(await cards.evaluateAll(nodes => nodes.every(node => !["1", "2", "3"].includes(node.getAttribute("data-appid")!)))).toBe(true);
    await page.getByRole("button", { name: "Refresh picks" }).last().click();
  }
  await page.getByRole("button", { name: "Import Steam wishlist", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open Steam privacy settings" })).toBeVisible();
  await page.getByRole("button", { name: "Import now", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your wishlist 1", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Read 1 Steam wishlist entry" }).first()).toBeVisible();
  failImport = true;
  await page.getByRole("button", { name: "Import now", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Steam cannot share this wishlist" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your wishlist 1", exact: true })).toBeVisible();
});

test("region menu stays anchored and saved cards match the three-column recommendations", async ({ page }) => {
  const games = Array.from({ length: 27 }, (_, index) => ({ appId: index + 1, title: `Wishlist ${String.fromCharCode(65 + index)}world`, genres: ["Adventure"], image: "", endless: true, reviews: 1000, positive: 950 }));
  await page.addInitScript(() => localStorage.setItem("vault-cookie-consent", "disabled"));
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games } }));
  await page.route("**/api/wishlist/details?*", route => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: { games: params.get("ids")!.split(",").map(Number).map(appId => ({ appId, storeStatus: "available", description: "Explore a world filled with secrets and characters. ".repeat(10) })) } });
  });
  await page.goto("/wishlist");
  const recommendations = page.getByRole("region", { name: "Worth a spot on your wishlist" });
  await expect(recommendations.locator("article")).toHaveCount(9);
  await expect(page.getByLabel("Recommendation style").locator("svg")).toHaveCount(0);
  await expect(recommendations.getByText("Endless", { exact: true })).toHaveCount(9);
  await expect(recommendations.getByText("Open-ended", { exact: true })).toHaveCount(0);
  for (let index = 0; index < 3; index++) await recommendations.getByRole("button", { name: /^Add .* to wishlist$/ }).first().click();
  const saved = page.getByRole("region", { name: "Your wishlist 3", exact: true });
  await expect(saved.locator("article")).toHaveCount(3);
  const recommendationSizes = await recommendations.locator("article").evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
  const savedSizes = await saved.locator("article").evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top })));
  expect(new Set(savedSizes.map(size => size.top)).size).toBe(1);
  savedSizes.forEach((size, index) => {
    expect(size.width).toBeCloseTo(recommendationSizes[index].width, 1);
    expect(size.height).toBeCloseTo(recommendationSizes[index].height, 1);
  });
  const paragraphs = recommendations.locator("article").first().locator("p");
  for (const index of [1]) {
    const lines = await paragraphs.nth(index).evaluate(node => node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight));
    expect(lines).toBe(3);
  }
  const trigger = page.getByRole("button", { name: /^Steam store region:/ });
  const menu = page.getByRole("listbox", { name: "Store region", exact: true });
  await trigger.click();
  await expect(menu).toBeVisible();
  const anchor = await trigger.boundingBox();
  const bounds = await page.locator('[class*="regionPopover"]').boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
  expect(bounds!.x + bounds!.width).toBeCloseTo(anchor!.x + anchor!.width, 0);
  await menu.press("ArrowDown");
  await menu.press("Enter");
  await expect(trigger).toHaveAccessibleName("Steam store region: United States / Global");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  const mobile = await menu.boundingBox();
  expect(mobile!.x).toBeGreaterThanOrEqual(0);
  expect(mobile!.x + mobile!.width).toBeLessThanOrEqual(390);
  await page.getByRole("searchbox", { name: "Search the Steam store" }).click({ position: { x: 4, y: 20 } });
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Budget picks renders before background prices finish and reuses fresh prices on return", async ({ page }) => {
  const games = Array.from({ length: 96 }, (_, i) => ({ appId: i + 1, title: `Budget ${i + 1}world`, image: "", genres: ["Adventure"], tags: { Adventure: 100 }, positive: 940, reviews: 1000 }));
  let budgetRequests = 0;
  let backgroundBlocked = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games } }));
  await page.route("**/api/wishlist/details?*", async route => {
    const params = new URL(route.request().url()).searchParams;
    const ids = params.get("ids")!.split(",").map(Number);
    const isBudget = ids.length === 4;
    if (isBudget && ++budgetRequests === 4) { backgroundBlocked = true; await gate; }
    await route.fulfill({ json: { games: ids.map(appId => ({ appId, description: "An affordable adventure.", storeStatus: "available", detailsExpiresAt: new Date(Date.now() + 3600000).toISOString(), ...(isBudget ? { price: { current: "£8.99", discount: 0, country: "GB", currency: "GBP", amountMinor: 899 } } : {}) })) } });
  });
  await page.goto("/wishlist");
  const recommendations = page.getByRole("region", { name: "Worth a spot on your wishlist" });
  const cards = recommendations.locator("article");
  await expect(cards).toHaveCount(9, { timeout: 20000 });
  await expect(cards.first().getByLabel("Steam price")).toContainText("Check price");
  await page.getByRole("button", { name: "Budget picks", exact: true }).click();
  try {
    await expect(cards).toHaveCount(9, { timeout: 20000 });
    await expect.poll(() => backgroundBlocked).toBe(true);
    await expect(cards.first().getByLabel("Steam price")).toContainText("£8.99");
    const ids = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-appid")));
    await cards.first().getByRole("button", { name: /^Add/ }).click();
    release();
    await expect.poll(() => budgetRequests).toBeGreaterThanOrEqual(7);
    expect(await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-appid")))).toEqual(ids);
    await page.getByRole("button", { name: "For you", exact: true }).click();
    await page.getByRole("button", { name: "Budget picks", exact: true }).click();
    await expect(cards).toHaveCount(9, { timeout: 20000 });
    await expect(cards.first().getByLabel("Steam price")).toContainText("£8.99");
    const before = await cards.first().getAttribute("data-appid");
    const refresh = recommendations.getByRole("button", { name: "Refresh picks", exact: true }).first();
    await refresh.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => scrollY);
    await refresh.click();
    await expect(cards.first()).not.toHaveAttribute("data-appid", before!);
    expect(await page.evaluate(() => scrollY)).toBe(scroll);
  } finally { release(); }
});

test("Wishlist opens the Library-style popup on click and keeps descriptions out of cards", async ({ page }) => {
  const games = Array.from({ length: 27 }, (_, i) => ({ appId: i + 1, title: `Preview ${i + 1}world`, image: "", genres: ["Adventure"], positive: 940, reviews: 1000 }));
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games } }));
  await page.route("**/api/wishlist/details?*", route => route.fulfill({ json: { games: new URL(route.request().url()).searchParams.get("ids")!.split(",").map(Number).map(appId => ({ appId, description: "Full popup description. ".repeat(8), storeStatus: "available" })) } }));
  await page.goto("/wishlist");
  const region = page.getByRole("region", { name: "Worth a spot on your wishlist" });
  const first = region.locator("article").first();
  await expect(region.locator("article")).toHaveCount(9);
  const title = await first.getByRole("heading").innerText();
  const before = await first.boundingBox();
  await expect(first.getByText(/Full popup description/)).toHaveCount(0);
  await first.hover();
  await page.waitForTimeout(500);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const trigger = first.getByRole("button", { name: `Details for ${title}`, exact: true });
  await trigger.click();
  const popup = page.getByRole("dialog", { name: title, exact: true });
  await expect(popup).toBeVisible();
  await expect(popup).toHaveAttribute("data-variant", "library");
  await expect(popup).toHaveAttribute("aria-modal", "true");
  await expect(popup.getByText(/Full popup description/)).toBeVisible();
  await expect(popup.getByRole("link", { name: "View on Steam", exact: true })).toHaveAttribute("href", /store.steampowered.com\/app\//);
  await expect(popup.getByRole("button", { name: /Blacklist|Complete|Save for later/ })).toHaveCount(0);
  const scroll = await page.evaluate(() => scrollY);
  await popup.getByRole("button", { name: `Add ${title} to wishlist`, exact: true }).click();
  await expect(popup.getByRole("button", { name: `Remove ${title} from wishlist`, exact: true })).toBeVisible();
  expect((await first.boundingBox())?.height).toBe(before?.height);
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(popup).toBeVisible();
  const close = popup.getByRole("button", { name: "Close game details", exact: true });
  await expect(close).toBeFocused();
  await close.press("Shift+Tab");
  await expect(popup.getByRole("button", { name: `Remove ${title} from wishlist`, exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await close.click();
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(popup).toBeVisible();
  const bounds = await popup.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.height).toBeLessThanOrEqual(812);
  await page.mouse.click(2, 2);
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Wishlist and Library render the same details layout", async ({ page }) => {
  const layout = async () => page.getByRole("dialog").evaluate(dialog => {
    const hero = dialog.children[1]; // The sticky close control precedes the artwork.
    const body = dialog.lastElementChild!;
    const image = hero.querySelector("img")!;
    return {
      dialogClass: dialog.className,
      width: dialog.getBoundingClientRect().width,
      heroClass: hero.className,
      heroHeight: hero.getBoundingClientRect().height,
      imageFit: getComputedStyle(image).objectFit,
      bodyClass: body.className,
      padding: getComputedStyle(body).padding,
      gap: getComputedStyle(body).gap,
      titleSize: getComputedStyle(dialog.querySelector("h2")!).fontSize,
      // Description, Steam, local actions, stats, genres: no extra Wishlist block.
      structure: Array.from(body.children).map(child => child.tagName),
    };
  });
  await page.goto("/library");
  const libraryTrigger = page.getByRole("button", { name: /^Details for / }).first();
  await libraryTrigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const library = await layout();
  await page.keyboard.press("Escape");
  await expect(libraryTrigger).toBeFocused();
  await page.goto("/wishlist");
  await page.getByRole("button", { name: /^Details for / }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await layout()).toEqual(library);
  await page.setViewportSize({ width: 390, height: 844 });
  const wishlistMobile = await layout();
  await page.keyboard.press("Escape");
  await page.goto("/library");
  await page.getByRole("button", { name: /^Details for / }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await layout()).toEqual(wishlistMobile);
});

test("Steam pricing markets are searchable, keyboard accessible and keep regional USD prices separate", async ({ page }) => {
  const games = Array.from({ length: 40 }, (_, i) => ({ appId: i + 1, title: `Regional ${i + 1}world`, image: "", genres: ["Adventure"], tags: { Adventure: 100 }, positive: 940, reviews: 1000 }));
  const countries: string[] = [];
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games } }));
  await page.route("**/api/wishlist/details?*", route => {
    const params = new URL(route.request().url()).searchParams;
    const country = params.get("country")!;
    countries.push(country);
    const price = country === "JP" ? { current: "¥1,500", currency: "JPY", amountMinor: 150000 }
      : country === "TR" ? { current: "$9.99", currency: "USD", amountMinor: 999 }
      : { current: "£8.99", currency: "GBP", amountMinor: 899 };
    return route.fulfill({ json: { games: params.get("ids")!.split(",").map(Number).map(appId => ({ appId, storeStatus: "available", price: { ...price, discount: 0, country } })) } });
  });
  await page.goto("/wishlist");
  const trigger = page.getByRole("button", { name: /^Steam store region:/ });
  const list = page.getByRole("listbox", { name: "Store region", exact: true });
  await trigger.click();
  await expect(list.getByRole("option")).toHaveCount(41);
  await list.press("End");
  await expect(list.getByRole("option", { name: "Vietnam", exact: true })).toBeInViewport();
  const search = page.getByRole("searchbox", { name: "Search store regions" });
  await search.fill("does not exist");
  await expect(page.getByRole("status").filter({ hasText: "No regions found." })).toBeVisible();
  await search.fill("Japan");
  await expect(list.getByRole("option")).toHaveCount(1);
  await search.press("Enter");
  await expect(trigger).toHaveAccessibleName("Steam store region: Japan");
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Budget picks", exact: true }).click();
  const cards = page.getByRole("region", { name: "Worth a spot on your wishlist" }).locator("article");
  await expect(cards).toHaveCount(9, { timeout: 20000 });
  await expect(cards.first().getByLabel("Steam price")).toContainText("¥1,500");
  expect(countries).toContain("JP");
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await search.fill("TR");
  await list.getByRole("option", { name: "Middle East & North Africa", exact: true }).click();
  await expect(trigger).toHaveAccessibleName("Steam store region: Middle East & North Africa");
  await expect(cards).toHaveCount(9, { timeout: 20000 });
  await expect(cards.first().getByLabel("Steam price")).toContainText("$9.99");
  expect(countries).toContain("TR");
  await trigger.click();
  await search.fill("South Georgia");
  const option = list.getByRole("option", { name: "United States / Global", exact: true });
  await expect(option).toBeVisible();
  const bounds = await page.locator('[class*="regionPopover"]').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/vault-wishlist-regions-mobile.png" });
  await search.press("Escape");
  await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await search.fill("JP");
  await list.getByRole("option", { name: "Japan", exact: true }).hover();
  await page.screenshot({ path: "/tmp/vault-wishlist-regions-desktop.png" });
});

test("store region survives refresh and navigation, ignores invalid values and tolerates blocked storage", async ({ page }) => {
  const key = "vault-wishlist-store-region-v1";
  const games = Array.from({ length: 20 }, (_, i) => ({ appId: i + 1, title: `Remembered ${i + 1}world`, image: "", genres: ["Adventure"], positive: 940, reviews: 1000 }));
  const requestedCountries: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games } }));
  await page.route("**/api/wishlist/details?*", route => {
    const params = new URL(route.request().url()).searchParams;
    const country = params.get("country")!;
    requestedCountries.push(country);
    return route.fulfill({ json: { games: params.get("ids")!.split(",").map(Number).map(appId => ({ appId, storeStatus: "available", price: { current: country === "JP" ? "¥1,500" : "8.99", currency: country === "JP" ? "JPY" : "EUR", amountMinor: country === "JP" ? 150000 : 899, discount: 0, country } })) } });
  });
  const trigger = page.getByRole("button", { name: /^Steam store region:/ });
  async function choose(name: string) {
    await trigger.click();
    await page.getByRole("searchbox", { name: "Search store regions" }).fill(name);
    await page.getByRole("option", { name, exact: true }).click();
    await expect(trigger).toHaveAccessibleName(`Steam store region: ${name}`);
  }
  await page.goto("/wishlist");
  await choose("Japan");
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe("JP");
  await page.reload();
  await expect(trigger).toHaveAccessibleName("Steam store region: Japan");
  const cards = page.getByRole("region", { name: "Worth a spot on your wishlist" }).locator("article");
  await expect(cards.first().getByLabel("Steam price")).toContainText("¥1,500");
  expect(requestedCountries).toContain("JP");
  const navigation = page.getByRole("navigation", { name: "Primary", exact: true });
  await navigation.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/\/library$/);
  await navigation.getByRole("link", { name: "Wishlist", exact: true }).click();
  await expect(trigger).toHaveAccessibleName("Steam store region: Japan");
  await choose("Brazil");
  await page.reload();
  await expect(trigger).toHaveAccessibleName("Steam store region: Brazil");
  // Old exact-country preferences migrate into the new pricing market.
  await page.evaluate(key => localStorage.setItem(key, "DE"), key);
  await page.reload();
  await expect(trigger).toHaveAccessibleName("Steam store region: Europe");
  await page.evaluate(key => localStorage.setItem(key, "ZZ"), key);
  await page.reload();
  await expect(trigger).toHaveAccessibleName("Steam store region: United Kingdom");
  // Block only preference writes so the existing guest wishlist remains usable.
  await page.evaluate(key => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Storage blocked", "SecurityError");
      return write.call(this, name, value);
    };
  }, key);
  await choose("Europe");
  await expect(cards).toHaveCount(9, { timeout: 20000 });
  expect(pageErrors).toEqual([]);
});

test("For you uses the connected player's played interests and remembers served picks across visits", async ({ page }) => {
  const session = { logged_in: true, account_type: "manual", identity_verified: false, user_id: "personal-wishlist-test", steam_id: "76561198000000000", display_name: "Taste tester", avatar_url: "", has_steam_key: false };
  const tastes = ["Strategy", "Puzzle", "Horror", "Platformer", "Roguelike", "Simulation"];
  const games = tastes.flatMap((tag, group) => Array.from({ length: 60 }, (_, i) => ({ appId: group * 1000 + i + 1, title: `${tag} ${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}world`, genres: [tag], tags: { [tag]: 100 }, image: "", positive: 9400, reviews: 10000 })));
  const owned = tastes.map((tag, i) => ({ id: `owned-${i}`, user_id: session.user_id, title: `Finished ${tag}`, steam_appid: String(i + 20000), genre: tag, steam_tags: { [tag]: 100 }, ownership: "Owned", access_source: "owned", store: "Steam", status: "Completed", hours_played: 20, rating: 0, completion_percentage: 100, priority: "Medium", notes: "", date_added: null, last_played_at: null }));
  const saved = [{ appId: 30000, title: "A saved shooter", genres: ["Action"], tags: { Shooter: 100 }, image: "" }];
  await page.addInitScript(() => localStorage.setItem("vault-cookie-consent", "disabled"));
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games } }));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/app-data") return route.fulfill({ json: { session, games: owned, collections: [], memberships: [], vaultState: { pinnedIds: [], pins: [], snoozedIds: [], currentPickId: null } } });
    if (path === "/api/session") return route.fulfill({ json: session });
    if (path === "/api/wishlist") return route.fulfill({ json: { games: saved, appIds: [30000], total: 1 } });
    if (path === "/api/wishlist/details") return route.fulfill({ json: { games: [] } });
    return route.fulfill({ json: { members: [], draws: [], progress: { status: "idle" } } });
  });
  await page.goto("/wishlist");
  const cards = page.getByRole("region", { name: "Worth a spot on your wishlist" }).locator("article");
  const seen = new Set<string>();
  for (let visit = 0; visit < 8; visit++) {
    await expect(cards).toHaveCount(9, { timeout: 20000 });
    const ids = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-appid")!));
    expect(ids.every(id => !seen.has(id)), `visit ${visit}: ${ids.join(",")}`).toBe(true);
    ids.forEach(id => seen.add(id));
    const texts = await cards.allTextContents();
    expect(texts.filter(text => /you finished Finished/.test(text)).length).toBeGreaterThanOrEqual(6);
    expect(new Set(ids.map(id => Math.floor((Number(id) - 1) / 1000))).size).toBeGreaterThanOrEqual(5);
    if (visit % 2 === 0) await page.reload();
    else {
      const nav = page.getByRole("navigation", { name: "Primary", exact: true });
      await nav.getByRole("link", { name: "Library", exact: true }).click();
      await expect(page).toHaveURL(/\/library$/);
      await nav.getByRole("link", { name: "Wishlist", exact: true }).click();
      await expect(page).toHaveURL(/\/wishlist$/);
    }
  }
  expect(seen.size).toBe(72);
});

test("each tab offers many fresh batches without repeats or moving the page", async ({ page }) => {
  const games = Array.from({ length: 400 }, (_, i) => ({ appId: i + 1, title: `Reserve ${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}world`, image: "", genres: ["Adventure"], tags: { Adventure: 100 }, minutes: 240, positive: 940, reviews: 1000, budgetHint: true }));
  await page.addInitScript(() => localStorage.setItem("vault-cookie-consent", "disabled"));
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games } }));
  await page.route("**/api/wishlist/details?*", route => route.fulfill({ json: { games: new URL(route.request().url()).searchParams.get("ids")!.split(",").map(Number).map(appId => ({ appId, storeStatus: "available", detailsExpiresAt: new Date(Date.now() + 3600000).toISOString(), price: { current: "£8.99", currency: "GBP", amountMinor: 899, discount: 0, country: "GB" } })) } }));
  await page.goto("/wishlist");
  const recommendations = page.getByRole("region", { name: "Worth a spot on your wishlist" });
  const cards = recommendations.locator("article");
  const refresh = recommendations.getByRole("button", { name: "Refresh picks", exact: true }).first();
  for (const tab of ["For you", "Short & sweet", "Highly rated", "Budget picks"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(cards).toHaveCount(9, { timeout: 20000 });
    await expect(refresh).toBeEnabled();
    const seen = new Set<string>();
    for (let batch = 0; batch < (tab === "Budget picks" ? 12 : 25); batch++) {
      if (tab === "Budget picks") await expect(cards.first().getByLabel("Steam price")).toContainText("£8.99");
      const ids = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-appid")!));
      expect(ids.every(id => !seen.has(id))).toBe(true);
      ids.forEach(id => seen.add(id));
      if (batch === (tab === "Budget picks" ? 11 : 24)) break;
      await refresh.scrollIntoViewIfNeeded();
      await refresh.click({ trial: true });
      const scroll = await page.evaluate(() => scrollY);
      const before = ids.join(",");
      await refresh.click();
      await expect.poll(async () => (await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-appid")))).join(",")).not.toBe(before);
      await expect(refresh).toBeEnabled();
      expect(await page.evaluate(() => scrollY)).toBe(scroll);
    }
    expect(seen.size).toBeGreaterThanOrEqual(tab === "Budget picks" ? 108 : 225);
  }
});

test("cold Budget picks warms more choices and replenishes in place after eight sets", async ({ page }) => {
  const games = Array.from({ length: 200 }, (_, i) => ({ appId: i + 1, title: `Bargain ${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}world`, image: "", genres: ["Adventure"], tags: { Adventure: 100 }, positive: 940, reviews: 1000, budgetHint: true }));
  await page.addInitScript(() => localStorage.setItem("vault-cookie-consent", "disabled"));
  await page.route("**/wishlist-catalogue*", route => route.fulfill({ json: { games } }));
  await page.route("**/api/wishlist/details?*", route => route.fulfill({ json: { games: new URL(route.request().url()).searchParams.get("ids")!.split(",").map(Number).map(appId => ({ appId, storeStatus: "available", detailsExpiresAt: new Date(Date.now() + 3600000).toISOString(), price: { current: "£8.99", currency: "GBP", amountMinor: 899, discount: 0, country: "GB" } })) } }));
  await page.goto("/wishlist");
  await page.getByRole("button", { name: "Budget picks", exact: true }).click();
  const region = page.getByRole("region", { name: "Worth a spot on your wishlist" });
  const cards = region.locator("article");
  const refresh = region.getByRole("button", { name: "Refresh picks", exact: true }).last();
  const seen = new Set<string>();
  for (let batch = 0; batch < 12; batch++) {
    await expect(refresh).toBeEnabled();
    await expect(cards).toHaveCount(9, { timeout: 20000 });
    await expect(cards.first().getByLabel("Steam price")).toContainText("£8.99");
    const ids = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-appid")!));
    expect(ids.every(id => !seen.has(id))).toBe(true);
    ids.forEach(id => seen.add(id));
    if (batch === 11) break;
    await refresh.scrollIntoViewIfNeeded();
    await refresh.click({ trial: true });
    const y = await page.evaluate(() => scrollY);
    const dimensions = await cards.first().boundingBox();
    await refresh.click();
    await expect.poll(async () => (await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-appid")))).join(",")).not.toBe(ids.join(","));
    await expect(refresh).toBeEnabled();
    expect(await page.evaluate(() => scrollY)).toBe(y);
    expect((await cards.first().boundingBox())!.height).toBe(dimensions!.height);
  }
  expect(seen.size).toBe(108);
});
