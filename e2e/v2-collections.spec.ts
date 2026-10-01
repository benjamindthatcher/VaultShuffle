import { expect, test, type Page } from "@playwright/test";

const session = { logged_in: true, account_type: "manual", identity_verified: false, user_id: "11111111-1111-4111-8111-111111111111", steam_id: "76561198000000000", display_name: "Collections tester", steam_display_name: "", avatar_url: "", has_steam_key: false };
const product = {
  manualProgress: null, completedAt: null, previousActiveStatus: null, reviewRequestedAt: null,
  completionDismissedAt: null, completionDismissedMinutes: null, dateAdded: null,
  recencySource: null, recencyEvidenceAt: null, observedMinutes: null,
  canonicalGenres: ["Adventure"], tags: { Adventure: 9 }, categories: [],
  imageUrl: "/assets/vault/vault-stage-open.png", headerUrl: "/assets/vault/vault-stage-open.png",
  releaseDate: null, playerMode: null, platforms: { windows: null, mac: null, linux: null }, deckCompatibility: null,
  duration: { mainStoryMinutes: 300, mainExtrasMinutes: null, completionistMinutes: null, source: "hltb", sourceUpdatedAt: null, confidence: null, endless: false },
  durationKind: "finite", durationStatus: "ready", tagsStatus: "ready",
  reviews: { positive: null, negative: null, total: null }, price: { currency: null, initial: null, final: null, isFree: null },
  familyOwnerSteamId: null, familyOwnerName: null,
};
const shelfId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const createdId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function fixture(page: Page, failDetail = false) {
  const games = Array.from({ length: 200 }, (_, i) => ({ gameId: i + 1, title: `Shelf Game ${String(i + 1).padStart(3, "0")}`, appId: String(i + 620), playtimeMinutes: null, access: "owned", completed: false, blacklisted: false, lastPlayedAt: null, product }));
  let revision = 1;
  let shelves = [{ publicId: shelfId, kind: "custom", name: "My shelf", description: "A full collection", rules: null, revision: "1", updatedAt: "2026-09-30T00:00:00Z" }];
  const members = new Map([[shelfId, Array.from({ length: 130 }, (_, i) => i + 1)]]);
  const reads: URL[] = [], writes: { path: string; method: string; body: Record<string, unknown> | null }[] = [];
  const summary = (shelf: typeof shelves[number]) => ({ ...shelf, count: members.get(shelf.publicId)?.length ?? 0, preview: (members.get(shelf.publicId) ?? []).slice(0, 4).map(id => ({ gameId: id, title: games[id - 1].title, imageUrl: product.imageUrl, access: "owned" })) });
  await page.addInitScript(() => {
    localStorage.setItem("vault-cookie-consent", "disabled");
    localStorage.setItem("vault-analytics-notice-seen", "1");
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (method === "GET") reads.push(url);
    else writes.push({ path, method, body: request.postData() ? request.postDataJSON() : null });
    if (path === "/api/app-data") return route.fulfill({ json: { session, dataAuthority: "v2", bootstrap: { accountPublicId: session.user_id, libraryRevision: String(revision), stateRevision: String(revision), ownedTotal: 200, familyTotal: 0, pins: [], currentPick: null }, pinGames: [], collectionMetadata: shelves.map(summary) } });
    if (path === "/api/v2/collections") {
      if (method === "POST") {
        const input = request.postDataJSON();
        shelves = [{ publicId: createdId, kind: input.kind, name: input.name, description: input.description, rules: input.rules ?? null, revision: "1", updatedAt: "2026-09-30T01:00:00Z" }, ...shelves];
        members.set(createdId, []); revision++;
        return route.fulfill({ json: { ok: true, collectionId: createdId } });
      }
      return route.fulfill({ json: { collections: shelves.map(summary) } });
    }
    const collection = path.match(/^\/api\/v2\/collections\/([^/]+)(\/games)?$/);
    if (collection) {
      const id = collection[1], shelf = shelves.find(row => row.publicId === id)!;
      if (method === "PATCH") { Object.assign(shelf, request.postDataJSON()); revision++; return route.fulfill({ json: { ok: true, collection: summary(shelf) } }); }
      if (method === "DELETE") { shelves = shelves.filter(row => row.publicId !== id); revision++; return route.fulfill({ json: { ok: true } }); }
      if (method === "POST") {
        members.set(id, [...new Set([...(members.get(id) ?? []), ...request.postDataJSON().game_ids])]); revision++;
        return route.fulfill({ json: { ok: true } });
      }
      const ids = members.get(id) ?? [], offset = Number(url.searchParams.get("cursor") ?? 0), limit = Number(url.searchParams.get("limit") ?? 60);
      return route.fulfill({ json: { collection: summary(shelf), items: ids.slice(offset, offset + limit).map((gameId, i) => ({ gameId, appId: games[gameId - 1].appId, title: games[gameId - 1].title, position: offset + i, note: null, card: games[gameId - 1] })), nextCursor: offset + limit < ids.length ? String(offset + limit) : null, total: ids.length, libraryRevision: String(revision), stateRevision: String(revision), catalogRevision: "1" } });
    }
    if (path === "/api/v2/library") {
      const excluded = new Set(members.get(url.searchParams.get("exclude_collection") ?? "") ?? []);
      const search = url.searchParams.get("search")?.toLowerCase() ?? "";
      const candidates = games.filter(game => !excluded.has(game.gameId) && game.title.toLowerCase().includes(search));
      const offset = Number(url.searchParams.get("cursor") ?? 0), limit = Number(url.searchParams.get("limit") ?? 60);
      return route.fulfill({ json: { items: candidates.slice(offset, offset + limit), nextCursor: offset + limit < candidates.length ? String(offset + limit) : null, total: candidates.length, sectionCounts: { active: 200, completed: 0, blacklisted: 0 }, filterGenres: ["Adventure"], hasDuration: true, revision: { library: String(revision), state: String(revision), catalog: "1", features: "1" } } });
    }
    if (path.startsWith("/api/v2/library/")) {
      if (failDetail) { failDetail = false; return route.fulfill({ status: 503, json: { error: "unavailable" } }); }
      const game = games[Number(path.split("/").at(-1)) - 1];
      return route.fulfill({ json: { ...game, notes: "Private collection note", description: "Fetched only when details open" } });
    }
    if (path === "/api/session") return route.fulfill({ json: session });
    if (path === "/api/v2/steam/owned-games") return route.fulfill({ json: { progress: { status: "idle", imported: 0, total: 0, percent: 0, playHistoryMissing: false, lastError: null, startedAt: null, completedAt: null } } });
    if (path.startsWith("/api/collections") || path.startsWith("/api/games")) throw Error("Collections used a legacy data route");
    return route.fulfill({ json: {} });
  });
  await page.goto("/collections", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Showing 60 of 130", { exact: true })).toBeVisible();
  return { reads, writes };
}

for (const width of [1280, 390]) {
  test(`V2 Collections page full shelves and add from the whole library (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { reads, writes } = await fixture(page);
    await expect(page.getByRole("region", { name: "Your collections" })).toContainText("130 games");
    const shelf = page.getByRole("region", { name: "Your collections" }).getByRole("button");
    await shelf.focus();
    await expect(shelf).toBeFocused();
    await expect(shelf).toHaveAttribute("aria-pressed", "true");
    await shelf.hover();
    await page.screenshot({ path: `/private/tmp/vaultshuffle-collections-${width}.png` });
    await expect(page.getByRole("button").filter({ has: page.getByRole("heading", { name: "Shelf Game 001", exact: true }) })).toContainText("Playtime unavailable");
    await page.getByRole("button", { name: "Load more games", exact: true }).click();
    await expect(page.getByText("Showing 120 of 130", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Load more games", exact: true }).click();
    await expect(page.getByText("Showing 130 of 130", { exact: true })).toBeVisible();
    await page.getByRole("button").filter({ has: page.getByRole("heading", { name: "Shelf Game 130", exact: true }) }).click();
    await expect(page.getByRole("dialog")).toContainText("Fetched only when details open");
    await page.getByRole("dialog").getByRole("button", { name: "Close game details", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Add games", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add games to My shelf" });
    await expect(dialog.getByRole("button", { name: "Shelf Game 131", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Shelf Game 001", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Shelf Game 131", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Search your games" }).fill("Shelf Game 200");
    await dialog.getByRole("button", { name: "Shelf Game 200", exact: true }).click();
    await expect(dialog).toContainText("2 selected");
    await page.screenshot({ path: `/private/tmp/vaultshuffle-collections-picker-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole("button", { name: "Add 2 games", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Your collections" })).toContainText("132 games");
    expect(writes.filter(row => row.path.endsWith("/games"))).toEqual([{ path: `/api/v2/collections/${shelfId}/games`, method: "POST", body: { game_ids: [131, 200] } }]);
    expect(reads.filter(url => url.pathname.endsWith("/games")).every(url => Number(url.searchParams.get("limit")) <= 60)).toBe(true);
    expect(reads.filter(url => url.pathname === "/api/v2/library").every(url => url.searchParams.get("exclude_collection") === shelfId)).toBe(true);
    expect(reads.filter(url => url.pathname.startsWith("/api/v2/library/")).length).toBe(1);
  });
}

test("V2 Collections retain detail failures and use the staged create/edit/delete routes", async ({ page }) => {
  const { writes } = await fixture(page, true);
  const card = page.getByRole("button").filter({ has: page.getByRole("heading", { name: "Shelf Game 001", exact: true }) });
  await card.click();
  await expect(page.getByRole("alert").filter({ hasText: "Game details" })).toContainText("could not be loaded");
  await card.click();
  await expect(page.getByRole("dialog")).toContainText("Fetched only when details open");
  await page.getByRole("dialog").getByRole("button", { name: "Close game details", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "New collection", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("New hand-picked shelf");
  await page.getByRole("combobox", { name: "Collection type", exact: true }).selectOption("custom");
  await page.getByRole("button", { name: "Create Collection", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your collections" }).getByRole("button").filter({ has: page.getByRole("heading", { name: "New hand-picked shelf" }) })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed shelf");
  await page.getByRole("button", { name: "Save Collection", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your collections" })).toContainText("Renamed shelf");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your collections" })).not.toContainText("Renamed shelf");
  expect(writes.filter(row => row.path.startsWith("/api/v2/collections")).map(({ path, method }) => ({ path, method }))).toEqual([
    { path: "/api/v2/collections", method: "POST" },
    { path: `/api/v2/collections/${createdId}`, method: "PATCH" },
    { path: `/api/v2/collections/${createdId}`, method: "DELETE" },
  ]);
});
