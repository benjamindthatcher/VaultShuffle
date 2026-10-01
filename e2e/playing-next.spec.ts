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
  let failBlacklist = false;
  let historyGate: Promise<void> | null = null;
  let releaseHistory: (() => void) | undefined;
  let blacklistGate: Promise<void> | null = null;
  let releaseBlacklist: (() => void) | undefined;
  const patches: Array<{ id: string; status: string }> = [];
  const actions: Array<Record<string, unknown>> = [];
  const events: Array<{ draw_id: string; event_type: string }> = [];
  const draws: Array<{ id: string; gameId: string; eligiblePoolCount: number }> = [];
  const state = () => ({ pinnedIds: pins.map(pin => pin.gameId), pins, snoozedIds: [], currentPickId });
  const session = { logged_in: true, account_type: "steam", identity_verified: true, user_id: "test-user", steam_id: "test-steam", display_name: "Test player", has_steam_key: false };
  await page.addInitScript(() => {
    localStorage.setItem("vault-cookie-consent", "disabled");
    localStorage.setItem("vault-analytics-notice-seen", "1");
    // Exercise the actual click handlers, without handing test clicks to Steam.
    document.addEventListener("click", event => {
      const link = (event.target as Element)?.closest('a[href^="steam://"], a[href^="https://store.steampowered.com/"]');
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
    if (path.startsWith("/api/games/") && route.request().method() === "PATCH") {
      const id = path.split("/").at(-1)!;
      const body = route.request().postDataJSON();
      patches.push({ id, status: body.status });
      if (body.status === "Blacklisted") {
        await blacklistGate;
        if (failBlacklist) return route.fulfill({ status: 503, json: { error: "Test blacklist failure" } });
        pins = pins.filter(pin => pin.gameId !== id);
        if (currentPickId === id) currentPickId = null;
      }
      const game = games.find(game => game.id === id)!;
      Object.assign(game, body);
      return json({ game });
    }
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
      await historyGate;
      const body = route.request().postDataJSON(); currentPickId = body.game_id;
      const id = crypto.randomUUID();
      draws.push({ id, gameId: body.game_id, eligiblePoolCount: body.eligible_pool_count });
      return json({ state: state(), draw: { id, drawnAt: new Date().toISOString(), steamAppId: body.steam_app_id, session: body.session, mood: body.mood, goal: body.goal, selectedGenres: [], events: [] } });
    }
    if (path === "/api/vault/history/events") {
      const body = route.request().postDataJSON();
      events.push(body);
      return json({ event: { id: crypto.randomUUID(), drawId: body.draw_id, eventType: body.event_type, createdAt: new Date().toISOString() } });
    }
    return json({ members: [], draws: [] });
  });
  return { errors, actions, events, draws, patches, games,
    delayHistory: () => { historyGate = new Promise<void>(resolve => { releaseHistory = resolve; }); },
    releaseHistory: () => releaseHistory?.(),
    delayBlacklist: () => { blacklistGate = new Promise<void>(resolve => { releaseBlacklist = resolve; }); },
    releaseBlacklist: () => releaseBlacklist?.(),
    failBlacklist: () => { failBlacklist = true; },
    pins: () => structuredClone(pins), fail: () => { fail = true; } };
}

async function draw(page: Page) {
  await page.goto("/vault");
  await page.getByRole("button", { name: /^Roll the dice$/i }).click();
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
  await expect(result.getByRole("button", { name: /Play later|Save for later/ })).toBeVisible();
}

async function drawAnother(page: Page) {
  const mobileAction = page.getByRole("button", { name: /^Reroll/ });
  if (await mobileAction.isVisible()) await mobileAction.click();
  else await page.getByRole("button", { name: /^Roll the dice$/i }).click();
}

test("saving, repeat launch, replacement and removal preserve the three-game commitment flow", async ({ page }) => {
  const fixture = await setup(page, 2);
  const result = await draw(page);
  const title = await result.getByRole("heading", { level: 2 }).innerText();
  await expect(result.getByText("Good pick?")).toHaveCount(0);
  await result.getByRole("button", { name: /Play later|Save for later/ }).click();
  await expect(result.getByRole("status")).toContainText("Playing Next");
  await expect.poll(() => fixture.pins().length).toBe(3);
  const acceptedDraw = fixture.draws.at(-1)!;
  await expect.poll(() => fixture.events.filter(event => event.draw_id === acceptedDraw.id).map(event => event.event_type)).toEqual(["pinned"]);
  const baseline = fixture.pins();
  await result.getByRole("link", { name: /Play now/ }).click();
  await expect.poll(() => fixture.events.filter(event => event.draw_id === acceptedDraw.id).map(event => event.event_type)).toEqual(["pinned", "opened_on_steam"]);
  expect(fixture.pins()).toEqual(baseline);
  expect(fixture.actions.filter(action => action.action === "pinned")).toHaveLength(1);
  await drawAnother(page);
  await expect(result.getByRole("heading", { level: 2 })).not.toHaveText(title);
  await chooseUnsaved(page);
  await result.getByRole("button", { name: /Play later|Save for later/ }).click();
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
  await result.getByRole("button", { name: /Play later|Save for later/ }).click();
  await expect(page.getByText("Could not save to Playing Next. Please try again.")).toBeVisible();
  await expect(result.getByRole("button", { name: /Play later|Save for later/ })).toBeVisible();
  expect(fixture.pins()).toHaveLength(0);
  expect(fixture.events).toEqual([]);
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
  await page.getByRole("button", { name: /^Roll the dice$/i }).click();
  const result = page.locator('[class*="resultCard"]');
  await expect(result.getByRole("link", { name: /View on Steam/ })).toHaveAttribute("href", /^https:\/\/store.steampowered.com/);
  await expect(result.getByRole("link", { name: /View on Steam/ })).toHaveAttribute("target", "_blank");
  await result.getByRole("button", { name: /Play later|Save for later/ }).click();
  await expect(result.getByRole("status")).toContainText("Playing Next");
  const acceptedDraw = fixture.draws.at(-1)!;
  await result.getByRole("link", { name: /View on Steam/ }).click();
  await expect.poll(() => fixture.events.filter(event => event.draw_id === acceptedDraw.id).map(event => event.event_type)).toEqual(["pinned", "play_now_intent"]);
  const reroll = page.getByRole("button", { name: /^Reroll/ });
  await reroll.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
  const beforeReroll = await page.evaluate(() => window.scrollY);
  const previousTitle = await result.getByRole("heading", { level: 2 }).innerText();
  await reroll.click();
  await expect.poll(() => fixture.events.filter(event => event.draw_id === acceptedDraw.id).map(event => event.event_type)).toEqual(["pinned", "play_now_intent", "drew_again"]);
  await expect.poll(() => fixture.draws.length).toBe(2);
  expect(fixture.draws[1].id).not.toBe(acceptedDraw.id);
  expect(fixture.draws[1].gameId).not.toBe(acceptedDraw.gameId);
  await expect(result.getByRole("heading", { level: 2 })).not.toHaveText(previousTitle);
  // Allow any reveal scroll animation to finish before checking the position.
  await page.waitForTimeout(1000);
  // Small card-layout rounding is fine; jumping back to the draw bar is not.
  expect(Math.abs(await page.evaluate(() => window.scrollY) - beforeReroll)).toBeLessThanOrEqual(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await result.screenshot({ path: "/tmp/playing-next-mobile.png" });
  expect(fixture.errors).toEqual([]);
});


test("Blacklist replaces the pick before persistence; immediate Undo restores eligibility and Playing Next", async ({ page }) => {
  const fixture = await setup(page);
  const result = await draw(page);
  await result.getByRole("button", { name: /^Save for later/ }).click();
  await expect(result.getByRole("status")).toContainText("Playing Next");
  const first = fixture.draws.at(-1)!;
  const title = await result.getByRole("heading", { level: 2 }).innerText();
  fixture.delayBlacklist();
  await result.getByRole("button", { name: /^Blacklist/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "is blacklisted" })).toBeVisible();
  await expect(result.getByRole("heading", { level: 2 })).not.toHaveText(title);
  // Neither the blacklist nor the next history write has resolved yet.
  expect(fixture.games.find(game => game.id === first.gameId)?.status).toBe("Not Started");
  expect(fixture.draws).toHaveLength(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  fixture.releaseBlacklist();
  await expect.poll(() => fixture.patches.map(patch => patch.status)).toEqual(["Blacklisted", "Not Started"]);
  await expect.poll(() => fixture.pins().some(pin => pin.gameId === first.gameId)).toBe(true);
  expect(fixture.events.filter(event => event.event_type === "drew_again")).toHaveLength(0);
  expect(fixture.draws[1].gameId).not.toBe(first.gameId);
  expect(fixture.draws[1].eligiblePoolCount).toBe(5);
  expect(fixture.errors).toEqual([]);
});

test("failed Blacklist clears Undo and reconciles the game without losing the replacement pick", async ({ page }) => {
  const fixture = await setup(page);
  const result = await draw(page);
  const first = fixture.draws.at(-1)!;
  const title = await result.getByRole("heading", { level: 2 }).innerText();
  fixture.failBlacklist();
  await result.getByRole("button", { name: /^Blacklist/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Could not blacklist" })).toContainText(`Could not blacklist ${title}`);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await expect(result.getByRole("heading", { level: 2 })).not.toHaveText(title);
  await expect.poll(() => fixture.draws.length).toBe(2);
  expect(fixture.games.find(game => game.id === first.gameId)?.status).toBe("Not Started");
  expect(fixture.events).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("rerolls remain weak rejections and cannot select a blacklisted game", async ({ page }) => {
  const fixture = await setup(page);
  const result = await draw(page);
  const first = fixture.draws.at(-1)!;
  await result.getByRole("button", { name: /^Blacklist/ }).click();
  await expect.poll(() => fixture.draws.length).toBe(2);
  for (let index = 0; index < 7; index += 1) {
    await expect(result.getByRole("button", { name: /^Reroll/ })).toBeEnabled();
    await result.getByRole("button", { name: /^Reroll/ }).click();
    await expect.poll(() => fixture.draws.length).toBe(index + 3);
  }
  expect(fixture.draws.slice(1).every(draw => draw.gameId !== first.gameId)).toBe(true);
  expect(fixture.patches).toEqual([{ id: first.gameId, status: "Blacklisted" }]);
  expect(fixture.events.filter(event => event.event_type === "drew_again")).toHaveLength(7);
  expect(fixture.errors).toEqual([]);
});

test("mobile result actions keep their intent order in a compact two-column grid", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setup(page);
  const result = await draw(page);
  const actions = result.locator('[class*="resultActions"]');
  const controls = actions.locator(':scope > *');
  await expect(controls).toHaveCount(4);
  await expect(controls.nth(0)).toContainText(/Play now|View on Steam/);
  await expect(controls.nth(1)).toContainText("Save for later");
  await expect(controls.nth(2)).toContainText("Reroll");
  await expect(controls.nth(3)).toContainText("Blacklist");
  const boxes = await controls.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { x: box.x, width: box.width, top: box.top, bottom: box.bottom };
  }));
  expect(boxes[1].top).toBe(boxes[0].top);
  expect(boxes[1].x).toBeGreaterThanOrEqual(boxes[0].x + boxes[0].width);
  expect(boxes[2].top).toBeGreaterThan(boxes[0].bottom);
  expect(boxes[3].top).toBe(boxes[2].top);
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await result.screenshot({ path: "/tmp/vault-polish-mobile.png", animations: "disabled" });
  expect(fixture.errors).toEqual([]);
});

test("guided reasons stay qualitative and Quick Draw ignores the completed setup", async ({ page }) => {
  const fixture = await setup(page);
  await page.goto("/vault");
  const sessionChoice = page.getByRole("button", { name: "Short Session", exact: true });
  await expect(sessionChoice).toBeVisible();
  expect((await sessionChoice.boundingBox())!.height).toBe(56);
  await sessionChoice.click();
  const sessionSummary = page.locator("#vault-setup-session").getByRole("button").first();
  await expect(sessionSummary).toContainText("Short Session");
  await expect(sessionSummary).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Chill", exact: true }).click();
  await page.getByRole("button", { name: "Surprise Me", exact: true }).click();
  const drawButton = page.getByRole("button", { name: "Draw from Vault", exact: true });
  await expect(page.locator("#vault-genre-toggle")).toBeFocused();
  await expect(page.locator("#vault-genre-toggle")).toHaveAttribute("aria-expanded", "true");
  await sessionSummary.click();
  await expect(sessionChoice).toBeVisible();
  await sessionSummary.click();
  await expect(sessionChoice).toBeVisible();
  await sessionChoice.click();
  await expect(sessionChoice).toHaveCount(0);
  await page.getByRole("region", { name: "Vault draw setup" }).screenshot({ path: "/tmp/vault-compact-setup.png" });
  await page.getByRole("region", { name: "Vault draw status" }).screenshot({ path: "/tmp/vault-compact-draw-controls.png" });
  await drawButton.click();
  const result = page.locator('[class*="resultCard"]');
  await expect(result.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(result).not.toContainText(/\/100|\d+(?:st|nd|rd|th) of/);
  expect(await result.getByRole("listitem").count()).toBeLessThanOrEqual(4);
  await expect(result.getByRole("button", { name: /^Reroll/ })).toBeEnabled();
  await result.screenshot({ path: "/tmp/vault-polish-desktop.png", animations: "disabled" });
  await page.getByRole("button", { name: /^Roll the dice$/i }).click();
  await expect(result.getByLabel("Selected setup")).toContainText("Quick Draw");
  await expect(result.getByLabel("Selected setup")).toContainText("Not used");
  await expect(result.getByLabel("Why this is a good match")).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});


test("slow history writes never block picks and rapid rerolls retain the original draw IDs", async ({ page }) => {
  const fixture = await setup(page);
  fixture.delayHistory();
  const result = await draw(page);
  expect(fixture.draws).toHaveLength(0);
  const first = await result.getByRole("heading", { level: 2 }).innerText();
  await result.getByRole("button", { name: /^Reroll/ }).click();
  await expect(result.getByRole("heading", { level: 2 })).not.toHaveText(first);
  expect(fixture.draws).toHaveLength(0);
  fixture.releaseHistory();
  await expect.poll(() => fixture.draws.length).toBe(2);
  await expect.poll(() => fixture.events).toEqual([{ draw_id: fixture.draws[0].id, event_type: "drew_again" }]);
  expect(fixture.errors).toEqual([]);
});


test("blacklisting the final eligible game leaves an honest empty state and can be undone", async ({ page }) => {
  const fixture = await setup(page);
  fixture.games.splice(1);
  const result = await draw(page);
  await result.getByRole("button", { name: /^Blacklist/ }).click();
  await expect(result).toHaveCount(0);
  await expect(page.getByText("No more eligible games in this draw.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Roll the dice$/i })).toBeEnabled();
  await page.getByRole("button", { name: /^Roll the dice$/i }).click();
  await expect(result.getByRole("heading", { level: 2 })).toHaveText("Hades");
  expect(fixture.errors).toEqual([]);
});


test("actions during a reroll reveal still belong to the visible pick", async ({ page }) => {
  const fixture = await setup(page);
  const result = await draw(page);
  const first = fixture.draws.at(-1)!;
  // Deliberately click within one animation frame, before the replacement reveal.
  await result.evaluate(element => {
    element.querySelector<HTMLButtonElement>('button[data-action="draw"]')!.click();
    element.querySelector<HTMLAnchorElement>('a[data-action="steam"]')!.click();
  });
  await expect.poll(() => fixture.draws.length).toBe(2);
  await expect.poll(() => fixture.events.filter(event => event.event_type === "opened_on_steam")).toEqual([
    { draw_id: first.id, event_type: "opened_on_steam" }
  ]);
  await expect.poll(() => fixture.pins().map(pin => pin.gameId)).toEqual([first.gameId]);
  expect(fixture.errors).toEqual([]);
});

for (const mobile of [false, true]) {
  test(`Vault accordion keeps a required choice open and advances to filters on ${mobile ? "mobile" : "desktop"}`, async ({ page }) => {
    const fixture = await setup(page);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/vault");
    const heading = (step: string) => page.locator(`#vault-setup-${step}`).getByRole("button").first();
    const filters = page.locator("#vault-genre-toggle");
    const openRequired = page.locator('[id^="vault-setup-"] > h2 > button[aria-expanded="true"]');
    await expect(heading("session")).toHaveAttribute("aria-expanded", "true");
    await expect(filters).toHaveAttribute("aria-expanded", "false");
    for (const [step, choice, next] of [["session", "Short Session", "mood"], ["mood", "Chill", "goal"], ["goal", "Surprise Me", null]] as const) {
      await heading(step).click();
      await expect(heading(step)).toHaveAttribute("aria-expanded", "true");
      await filters.click();
      await expect(filters).toHaveAttribute("aria-expanded", "true");
      await expect(heading(step)).toHaveAttribute("aria-expanded", "true");
      await expect(openRequired).toHaveCount(1);
      await filters.click();
      await expect(filters).toHaveAttribute("aria-expanded", "false");
      await expect(heading(step)).toHaveAttribute("aria-expanded", "true");
      await page.getByRole("button", { name: choice, exact: true }).click();
      await expect(heading(step)).toHaveAttribute("aria-expanded", "false");
      if (next) await expect(heading(next)).toHaveAttribute("aria-expanded", "true");
    }
    await expect(filters).toHaveAttribute("aria-expanded", "true");
    await expect(openRequired).toHaveCount(0);
    await filters.click();
    await expect(filters).toHaveAttribute("aria-expanded", "false");
    for (const [step, choice] of [["session", "Short Session"], ["mood", "Chill"], ["goal", "Surprise Me"]]) {
      await heading(step).click();
      await heading(step).click();
      await expect(heading(step)).toHaveAttribute("aria-expanded", "true");
      await page.getByRole("button", { name: choice, exact: true }).click();
      await expect(filters).toHaveAttribute("aria-expanded", "true");
    }
    await page.getByRole("region", { name: "Vault draw setup" }).screenshot({ path: `/tmp/vault-accordion-${mobile ? "mobile" : "desktop"}.png` });
    await page.reload();
    await expect(filters).toHaveAttribute("aria-expanded", "false");
    await expect(heading("session")).toHaveAttribute("aria-expanded", "true");
    await expect(openRequired).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Short Session", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status", { name: "Loading", exact: true })).toHaveCount(0);
    await page.getByRole("region", { name: "Vault draw setup" }).screenshot({ path: `/tmp/vault-restored-session-${mobile ? "mobile" : "desktop"}.png` });
    expect(fixture.errors).toEqual([]);
  });
}

test("Vault accordion restores the first unanswered choice", async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => sessionStorage.setItem("vault-setup", JSON.stringify({ session: "short", mood: null, goal: null })));
  await page.goto("/vault");
  await expect(page.locator("#vault-setup-session").getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#vault-setup-mood").getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#vault-genre-toggle")).toHaveAttribute("aria-expanded", "false");
});
