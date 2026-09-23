import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, count = 0) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text()); });
  const games = ["Hades", "Balatro", "Portal 2", "Celeste", "Hollow Knight", "Outer Wilds"].map((title, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`, user_id: "test-user", title,
    genre: "Adventure", store: "Steam", ownership: "Owned", status: "Not Started",
    hours_played: 2, completion_percentage: 10, rating: 0, priority: "Medium", date_added: null,
    last_played_at: null, notes: "", steam_appid: String([1145360, 2379780, 620, 504230, 367520, 753640][index]), main_story_minutes: 1200,
    duration_kind: "finite", steam_tags: {}, platform_windows: true,
  }));
  let pins = games.slice(0, count).map(game => ({ gameId: game.id, pinnedAt: "2026-09-01T00:00:00Z", hoursAtPin: 1 }));
  let currentPickId: string | null = null;
  let fail = false;
  const actions: Array<Record<string, unknown>> = [];
  const state = () => ({ pinnedIds: pins.map(pin => pin.gameId), pins, snoozedIds: [], currentPickId });
  const session = { logged_in: true, account_type: "steam", identity_verified: true, user_id: "test-user", steam_id: "test-steam", display_name: "Test player", has_steam_key: false };
  await page.addInitScript(() => {
    localStorage.setItem("vault-cookie-consent", "disabled");
    // Exercise the actual click handlers, without handing test clicks to Steam.
    document.addEventListener("click", event => {
      const link = (event.target as Element)?.closest('a[href^="steam://"]');
      if (link) event.preventDefault();
    });
  });
  await page.route("**/_vercel/**", route => route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === "/api/app-data") return json({ session, games, collections: [], memberships: [], vaultState: state() });
    if (path === "/api/session") return json(session);
    if (path === "/api/steam/owned-games") return json({ progress: { status: "complete", percent: 100, total: games.length, imported: games.length } });
    if (path === "/api/vault/state") {
      const body = route.request().postDataJSON();
      actions.push(body);
      if (fail) return route.fulfill({ status: 503, json: { error: "Test save failure" } });
      if (body.action === "unpinned") pins = pins.filter(pin => pin.gameId !== body.game_id);
      if (body.action === "pinned" && !pins.some(pin => pin.gameId === body.game_id)) {
        const pin = { gameId: body.game_id, pinnedAt: new Date().toISOString(), hoursAtPin: 2 };
        const replaceIndex = pins.findIndex(pin => pin.gameId === body.context?.replace_game_id);
        if (pins.length < 3) pins.push(pin);
        else if (replaceIndex >= 0) pins[replaceIndex] = pin;
      }
      return json(state());
    }
    if (path === "/api/vault/history" && route.request().method() === "POST") {
      const body = route.request().postDataJSON(); currentPickId = body.game_id;
      return json({ state: state(), draw: { id: crypto.randomUUID(), drawnAt: new Date().toISOString(), steamAppId: body.steam_app_id, session: body.session, mood: body.mood, goal: body.goal, selectedGenres: [], events: [] } });
    }
    if (path === "/api/vault/history/events") {
      const body = route.request().postDataJSON();
      return json({ event: { id: crypto.randomUUID(), drawId: body.draw_id, eventType: body.event_type, createdAt: new Date().toISOString() } });
    }
    return json({ members: [], draws: [] });
  });
  return { errors, actions, pins: () => structuredClone(pins), fail: () => { fail = true; } };
}

async function draw(page: Page) {
  await page.goto("/vault");
  await page.getByRole("button", { name: /just pick something/i }).click();
  const result = page.locator('[class*="resultCard"]');
  await expect(result.getByRole("heading", { level: 2 })).toBeVisible();
  await chooseUnsaved(page);
  return result;
}

async function chooseUnsaved(page: Page) {
  const result = page.locator('[class*="resultCard"]');
  for (let attempt = 0; attempt < 6 && await result.getByRole("status").count(); attempt += 1) {
    const previous = await result.getByRole("heading", { level: 2 }).innerText();
    await drawAnother(page);
    await expect(result.getByRole("heading", { level: 2 })).not.toHaveText(previous);
  }
  await expect(result.getByRole("button", { name: /Save for later/ })).toBeVisible();
}

async function drawAnother(page: Page) {
  const mobileAction = page.getByRole("button", { name: /^Pick another/ });
  if (await mobileAction.isVisible()) await mobileAction.click();
  else await page.getByRole("button", { name: /just pick something/i }).click();
}

test("saving, repeat launch, replacement and removal preserve the three-game commitment flow", async ({ page }) => {
  const fixture = await setup(page, 2);
  const result = await draw(page);
  const title = await result.getByRole("heading", { level: 2 }).innerText();
  await expect(result.getByText("Good pick?")).toHaveCount(0);
  await result.getByRole("button", { name: /Save for later/ }).click();
  await expect(result.getByRole("status")).toContainText("Playing Next");
  await expect.poll(() => fixture.pins().length).toBe(3);
  const baseline = fixture.pins();
  await result.getByRole("link", { name: /Play now/ }).click();
  expect(fixture.pins()).toEqual(baseline);
  expect(fixture.actions.filter(action => action.action === "pinned")).toHaveLength(1);
  await drawAnother(page);
  await expect(result.getByRole("heading", { level: 2 })).not.toHaveText(title);
  await chooseUnsaved(page);
  await result.getByRole("button", { name: /Save for later/ }).click();
  const dialog = page.getByRole("dialog", { name: /Manage Playing Next/ });
  await expect(dialog).toContainText("Playing Next is full");
  await dialog.getByRole("button", { name: "Replace Hades", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.pins()).toHaveLength(3);
  const shelf = page.getByRole("region", { name: "Playing Next", exact: true });
  await expect(shelf.getByRole("button", { name: "Remove Hades from Playing Next", exact: true })).toHaveCount(0);
  await shelf.getByRole("button", { name: "Remove Balatro from Playing Next", exact: true }).click();
  await expect(shelf).toContainText("2 of 3");
  await expect(shelf.getByRole("link", { name: "Find another game" })).toHaveAttribute("href", "/vault");
  const card = shelf.locator("li").first();
  const gap = await card.evaluate(element => {
    const pane = element.querySelector('button[class*="card"]')!.getBoundingClientRect();
    const steam = element.querySelector("a")!.getBoundingClientRect();
    return steam.top - pane.bottom;
  });
  expect(Math.abs(gap)).toBeLessThan(1);
  await shelf.screenshot({ path: "/tmp/playing-next-desktop.png" });
  expect(fixture.errors).toEqual([]);
});

test("Play now launches with a full shelf and offers an optional replacement", async ({ page }) => {
  const fixture = await setup(page, 3);
  const result = await draw(page);
  const play = result.getByRole("link", { name: /Play now/ });
  await expect(play).toHaveAttribute("href", /^steam:\/\/run\//);
  await play.click();
  await expect(page.getByRole("dialog")).toContainText("Playing Next is full");
  await page.getByRole("button", { name: "Not this time", exact: true }).click();
  expect(fixture.actions).toHaveLength(0);
  expect(fixture.pins()).toHaveLength(3);
  expect(fixture.errors).toEqual([]);
});

test("a failed save restores state and never leaves a false saved confirmation", async ({ page }) => {
  const fixture = await setup(page);
  const result = await draw(page);
  fixture.fail();
  await result.getByRole("button", { name: /Save for later/ }).click();
  await expect(page.getByText("Could not save to Playing Next. Please try again.")).toBeVisible();
  await expect(result.getByRole("button", { name: /Save for later/ })).toBeVisible();
  expect(fixture.pins()).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});

test("mobile empty dashboard leads to Vault and uses the Steam store fallback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page);
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => query === "(pointer: fine)" ? { ...original(query), matches: false } : original(query);
  });
  await page.goto("/dashboard");
  await expect(page).toHaveTitle(/VaultShuffle/);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toHaveCount(1);
  await page.getByRole("link", { name: "Find your first game" }).click();
  await expect(page).toHaveURL(/\/vault$/);
  await page.getByRole("button", { name: /just pick something/i }).click();
  const result = page.locator('[class*="resultCard"]');
  await expect(result.getByRole("link", { name: /View on Steam/ })).toHaveAttribute("href", /^https:\/\/store.steampowered.com/);
  await expect(result.getByRole("link", { name: /View on Steam/ })).toHaveAttribute("target", "_blank");
  await result.getByRole("button", { name: /Save for later/ }).click();
  await expect(result.getByRole("status")).toContainText("Playing Next");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await result.screenshot({ path: "/tmp/playing-next-mobile.png" });
  expect(fixture.errors).toEqual([]);
});
