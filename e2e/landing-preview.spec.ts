import { expect, test, type Page } from "@playwright/test";

async function setupPreview(page: Page, count = 3) {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() !== "GET" && /\/api\/(vault|games|library)/.test(request.url())) writes.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("vault-cookie-consent", "disabled");
    localStorage.setItem("vault-analytics-notice-seen", "1");
  });
  const games = ["Hades", "Portal 2", "Celeste"].slice(0, count).map((title, index) => ({
    id: `preview-${index}`, title, user_id: "preview", genre: "Adventure", store: "Steam",
    ownership: "Owned", status: "Not Started", hours_played: 0, completion_percentage: 0,
    rating: 0, priority: "Medium", date_added: null, last_played_at: null, notes: "",
    steam_appid: String([1145360, 620, 504230][index]), main_story_minutes: 1200,
    duration_kind: "finite", steam_tags: {}, platform_windows: true
  }));
  await page.route("**/guest-catalogue", (route) => route.fulfill({ json: { games } }));
  await page.goto("/");
  await page.locator("#how").scrollIntoViewIfNeeded();
  await expect(page.locator("#how").getByText(`Drawing from a preview library of ${count} popular Steam games.`, { exact: false })).toBeVisible();
  return { errors, writes };
}

test("landing result follows the new action hierarchy and preserves Quick Draw on reroll", async ({ page }) => {
  const fixture = await setupPreview(page);
  for (const label of ["Evening Session", "Intense", "Surprise Me"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
  }
  await page.getByRole("button", { name: "Draw from Vault", exact: true }).click();
  const result = page.locator('section[aria-label^="Your pick:"]');
  await expect(result.getByRole("button", { name: /^Reroll/ })).toBeEnabled();
  const reasons = result.getByRole("region", { name: "Why this is a good match" });
  await expect(reasons).toBeVisible();
  await expect(reasons.locator("header")).not.toContainText(/\/100|\d+(st|nd|rd|th) of/);
  expect(await reasons.locator("li").count()).toBeLessThanOrEqual(4);
  expect(await reasons.locator("li").count()).toBeGreaterThanOrEqual(1);
  await result.screenshot({ path: "/tmp/landing-vault-update-desktop.png", animations: "disabled" });
  await result.getByRole("button", { name: /^Save for later/ }).click();
  await expect(result.getByRole("status")).toContainText("Playing Next");
  await expect(result.getByRole("button", { name: /^Save for later/ })).toHaveCount(0);
  const first = await result.locator("h3").innerText();
  await result.getByRole("button", { name: /^Reroll/ }).click();
  await expect(result.locator("h3")).not.toHaveText(first);
  await expect(result.getByRole("button", { name: /^Reroll/ })).toBeEnabled();
  await page.getByRole("button", { name: "Roll the dice", exact: true }).click();
  await expect(result.getByLabel("Selected setup")).toContainText("Quick Draw");
  await expect(result.getByLabel("Selected setup")).toContainText("Not used");
  await expect(reasons).toHaveCount(0);
  const quickPick = await result.locator("h3").innerText();
  await result.getByRole("button", { name: /^Reroll/ }).click();
  await expect(result.locator("h3")).not.toHaveText(quickPick);
  await expect(result.getByLabel("Selected setup")).toContainText("Quick Draw");
  await expect(reasons).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("preview Blacklist replaces, excludes, recovers from exhaustion and restores saved state with Undo", async ({ page }) => {
  const fixture = await setupPreview(page, 2);
  await page.getByRole("button", { name: "Roll the dice", exact: true }).click();
  const result = page.locator('section[aria-label^="Your pick:"]');
  await expect(result.getByRole("button", { name: /^Blacklist/ })).toBeEnabled();
  const first = await result.locator("h3").innerText();
  await result.getByRole("button", { name: /^Blacklist/ }).click();
  await expect(result.locator("h3")).not.toHaveText(first);
  await expect(result.getByRole("button", { name: /^Reroll/ })).toBeEnabled();
  const second = await result.locator("h3").innerText();
  await result.getByRole("button", { name: /^Reroll/ }).click();
  await expect(result.getByRole("button", { name: /^Reroll/ })).toBeEnabled();
  await expect(result.locator("h3")).toHaveText(second);
  await result.getByRole("button", { name: /^Save for later/ }).click();
  await result.getByRole("button", { name: /^Blacklist/ }).click();
  await expect(result).toHaveCount(0);
  await expect(page.getByText("No more eligible games in this preview.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Roll the dice", exact: true }).click();
  await expect(result.locator("h3")).toHaveText(second);
  await expect(result.getByRole("status")).toContainText("Playing Next");
  expect(fixture.errors).toEqual([]);
  expect(fixture.writes).toEqual([]);
});

test("mobile preview keeps launch, save, reroll and blacklist within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await setupPreview(page);
  await page.getByRole("button", { name: "Roll the dice", exact: true }).click();
  const result = page.locator('section[aria-label^="Your pick:"]');
  const actions = result.getByRole("group", { name: "Preview recommendation actions" });
  await expect(actions.getByRole("button", { name: /^Reroll/ })).toBeEnabled();
  const boxes = await actions.locator(":scope > button").evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    return { x: rect.x, width: rect.width, top: rect.top, bottom: rect.bottom };
  }));
  expect(boxes).toHaveLength(4);
  for (const box of boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  for (let index = 0; index < boxes.length; index++) {
    for (let other = index + 1; other < boxes.length; other++) {
      const a = boxes[index], b = boxes[other];
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
  }
  await result.screenshot({ path: "/tmp/landing-vault-update-mobile.png", animations: "disabled" });
  await actions.getByRole("button", { name: /^Play now/ }).click();
  await expect(actions.getByRole("button", { name: /^Launching steam/ })).toHaveAttribute("aria-busy", "true");
  await expect(result.getByRole("status")).toContainText("Playing Next");
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(fixture.errors).toEqual([]);
  expect(fixture.writes).toEqual([]);
});
