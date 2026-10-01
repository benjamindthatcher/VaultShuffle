import test from "node:test";
import assert from "node:assert/strict";
import { cheapWishlistBand, recommendWishlist, parseSteamWishlist, readGuestWishlist, type WishlistGame } from "./wishlist.ts";
import type { DemoGame } from "./demo-data.ts";
import { isSteamStoreCountry, steamBudgetBand, STEAM_PRICE_MARKETS, STEAM_STORE_REGIONS, steamPriceMarket, steamPriceMarketSearch } from "./steam-store-regions.ts";

const game = (appId: number, title: string, patch: Partial<WishlistGame> = {}): WishlistGame => ({ appId, title, image: "", genres: ["Adventure"], reviews: 2000, positive: 1800, ...patch });
const libraryGame = (steamAppId: number, title: string, patch: Partial<DemoGame> = {}): DemoGame => ({ steamAppId, title, status: "Not Started", genres: ["Adventure"], hoursPlayed: 0, ...patch } as DemoGame);

test("purchase recommendations exclude owned, family, saved, editions, demos and duplicates", () => {
  const pool = [game(1, "Owned"), game(2, "Family"), game(3, "Saved"), game(4, "Owned Remastered"), game(5, "Game Demo"), game(6, "New world"), game(6, "Duplicate")];
  const library = [libraryGame(1, "Owned"), libraryGame(2, "Family", { accessSource: "family" })];
  assert.deepEqual(recommendWishlist(pool, library, [pool[2]]).map((pick) => pick.game.appId), [6]);
});

test("wishlist and played-game taste outrank popularity and provide an honest reason", () => {
  const strategy = game(1, "Tactical World", { tags: { Strategy: 100, "Turn-Based": 90 } });
  const action = game(2, "Action World", { tags: { Action: 100, Shooter: 90 }, reviews: 300000, positive: 290000 });
  const seed = game(3, "My strategy pick", { tags: strategy.tags });
  const result = recommendWishlist([action, strategy], [], [seed]);
  assert.equal(result[0].game.appId, 1);
  assert.match(result[0].reason, /Shared Strategy.*My strategy pick/);
  const played = libraryGame(4, "Finished strategy", { status: "Completed", tagProfile: strategy.tags });
  assert.match(recommendWishlist([action, strategy], [played], [])[0].reason, /you finished Finished strategy/);
});

test("blacklisted games are excluded as taste seeds without exposing blacklist controls", () => {
  const played = libraryGame(4, "Blacklisted strategy", { status: "Blacklisted", hoursPlayed: 100, tagProfile: { Strategy: 100 } });
  const [pick] = recommendWishlist([game(1, "Tactical World", { tags: { Strategy: 100 } })], [played], []);
  assert.doesNotMatch(pick.reason, /you played|you finished/);
});

test("short picks require a known finite duration of ten hours or less", () => {
  const pool = [game(1, "Short", { minutes: 240 }), game(2, "Long", { minutes: 1000 }), game(3, "Endless", { minutes: 200, endless: true }), game(4, "Unknown"), game(5, "Sandbox with misleading duration", { minutes: 200, tags: { Sandbox: 100 } }), game(6, "Multiplayer rounds", { minutes: 120, tags: { Horror: 100, Multiplayer: 80 } })];
  assert.deepEqual(recommendWishlist(pool, [], [], "short").map((pick) => pick.game.appId), [1]);
});

test("budget picks require verified good reviews and prefer £10 before £20", () => {
  const priced = (id: number, pennies: number, patch: Partial<WishlistGame> = {}) => game(id, `Budget ${String.fromCharCode(64 + id)}world`, { price: { current: `£${(pennies / 100).toFixed(2)}`, amountMinor: pennies, currency: "GBP", discount: 0, country: "GB" }, ...patch });
  const pool = Array.from({ length: 10 }, (_, i) => priced(i + 1, 899));
  pool.push(priced(11, 1499), priced(12, 1999), priced(13, 2100), priced(14, 500, { reviews: 3, positive: 3 }), game(15, "Unknown price"), priced(16, 0));
  assert.equal(cheapWishlistBand(pool[0], "GB"), 1);
  assert.equal(cheapWishlistBand(pool[10], "GB"), 2);
  assert.equal(cheapWishlistBand(pool[12], "GB"), null);
  assert.equal(cheapWishlistBand(pool[13], "GB"), null);
  assert.equal(cheapWishlistBand(pool[15], "GB"), null);
  const picks = recommendWishlist(pool, [libraryGame(1, pool[0].title)], [], "cheap", 123, "GB");
  assert.equal(picks.length, 9);
  assert.ok(picks.every((pick) => pick.game.appId >= 2 && pick.game.appId <= 10));
  const fallback = recommendWishlist(pool.slice(0, 5).concat(pool.slice(10, 12)), [], [], "cheap", 123, "GB");
  assert.ok(fallback.some((pick) => pick.game.appId === 11));
  const ninthPick = recommendWishlist(pool.slice(0, 8).concat(pool[10]), [], [], "cheap", 123, "GB");
  assert.equal(ninthPick.length, 9, "eight cheaper matches still need a ninth pick from the fallback band");
});

test("regional budget picks use Steam's reported currency and hundredths, including shared USD regions", () => {
  const scenarios = [
    ["JP", "JPY", 200000], ["KR", "KRW", 1800000], ["KW", "KWD", 400],
    ["BR", "BRL", 7000], ["FR", "EUR", 1200], ["TR", "USD", 1300],
    ["AR", "USD", 1300], ["PK", "USD", 1300], ["XK", "EUR", 1200],
  ] as const;
  for (const [country, currency, limit] of scenarios) {
    const priced = (amountMinor: number) => game(7, "A good regional game", { price: { current: "Steam regional price", amountMinor, currency, discount: 0, country } });
    assert.ok(isSteamStoreCountry(country));
    assert.equal(cheapWishlistBand(priced(limit), country), 1);
    assert.equal(cheapWishlistBand(priced(limit + 1), country), 2);
    assert.equal(cheapWishlistBand(priced(limit * 2 + 1), country), null);
    assert.equal(cheapWishlistBand(priced(limit), "GB"), null, "never use another country's cached price");
  }
  assert.equal(isSteamStoreCountry("ZZ"), false);
  assert.equal(isSteamStoreCountry("jp"), false);
  assert.equal(isSteamStoreCountry(null), false);
  assert.equal(steamBudgetBand("ARS"), null, "retired currencies cannot qualify");
  assert.equal(steamBudgetBand("constructor"), null);
});

test("highly rated ignores taste and limits a franchise to two suggestions", () => {
  const pool = [game(1, "Space 1"), game(2, "Space 2"), game(3, "Space 3"), game(4, "Another world", { positive: 1990 })];
  const picks = recommendWishlist(pool, [], [], "acclaimed");
  assert.equal(picks[0].game.appId, 4);
  assert.equal(picks.filter((pick) => pick.game.title.startsWith("Space")).length, 2);
});

test("Steam imports deduplicate, accept an explicit empty list and reject unavailable or malformed responses", () => {
  assert.deepEqual(parseSteamWishlist({ response: { items: [{ appid: 1 }, { appid: 1 }, { appid: 2 }] } }), [1, 2]);
  assert.deepEqual(parseSteamWishlist({ response: { items: [] } }), []);
  for (const body of [null, {}, { response: {} }, { response: { items: null } }, { response: { items: [{ appid: -1 }] } }, { response: { items: [{ appid: "bad" }] } }]) assert.throws(() => parseSteamWishlist(body));
});

test("corrupted guest storage is recoverable and repeated IDs do not duplicate saves", () => {
  assert.deepEqual(readGuestWishlist("invalid"), []);
  assert.deepEqual(readGuestWishlist("{}"), []);
  assert.deepEqual(readGuestWishlist(JSON.stringify([game(1, "Saved"), game(1, "Duplicate"), { appId: -1 }, null])).map((g) => g.title), ["Saved"]);
});

test("personal decks use varied library seeds, limited wishlist influence and multiple unique batches", () => {
  const tags = ["Strategy", "Puzzle", "Horror", "Racing", "Platformer", "Survival", "Roguelike", "Simulation"];
  const library = tags.map((tag, i) => libraryGame(1000 + i, `Finished ${tag}`, { status: "Completed", hoursPlayed: 20, genres: [tag], tagProfile: { [tag]: 100 } }));
  const pool = tags.flatMap((tag, i) => Array.from({ length: 8 }, (_, j) => game(i * 10 + j + 1, `${tag} ${String.fromCharCode(65 + j)}world`, { genres: [tag], tags: { [tag]: 100 } })));
  const saved = [game(500, "My wishlist fixation", { tags: { Strategy: 100 } })];
  const deck = recommendWishlist(pool, library, saved, "for-you", 123);
  assert.equal(deck.length, 64);
  assert.equal(new Set(deck.map((pick) => pick.game.appId)).size, 64);
  for (let start = 0; start < 36; start += 9) {
    const batch = deck.slice(start, start + 9);
    assert.ok(batch.filter((pick) => pick.signal === "library").length >= 6);
    assert.ok(batch.filter((pick) => pick.signal === "wishlist").length <= 1);
    assert.equal(new Set(batch.map((pick) => pick.reasonKey)).size, 9);
  }
  assert.deepEqual(recommendWishlist(pool, library, saved, "for-you", 123), deck, "same deck stays stable between clicks");
  assert.notDeepEqual(recommendWishlist(pool, library, saved, "for-you", 456).slice(0, 9).map((pick) => pick.game.appId), deck.slice(0, 9).map((pick) => pick.game.appId));
});

test("all shuffle seeds exclude the entire owned library, including hidden, blacklisted and family editions", () => {
  const pool = [game(1, "Owned"), game(2, "Family"), game(3, "Blacklisted"), game(4, "Owned Remastered"), game(5, "New World")];
  const library = [libraryGame(1, "Owned"), libraryGame(2, "Family", { accessSource: "family" }), libraryGame(3, "Blacklisted", { status: "Blacklisted" })];
  for (const seed of [1, 50, 10000]) assert.deepEqual(recommendWishlist(pool, library, [], "for-you", seed).map((pick) => pick.game.appId), [5]);
});

test("larger pools supply dozens of unique batches on every tab and retain owned-game exclusion", () => {
  const letters = (i: number) => `${String.fromCharCode(97 + Math.floor(i / 676))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + i % 26)}`;
  const pool = Array.from({ length: 1000 }, (_, i) => game(i + 1, `Discovery ${letters(i)}world`, { minutes: 240, tags: { Adventure: 100 }, price: { country: "GB", currency: "GBP", amountMinor: 899, current: "£8.99", discount: 0 } }));
  const owned = pool.slice(0, 10).map(g => libraryGame(g.appId, g.title, { status: "Completed", hoursPlayed: 8 }));
  for (const mode of ["for-you", "short", "acclaimed", "cheap"] as const) {
    const deck = recommendWishlist(pool, owned, [], mode, 123);
    assert.ok(deck.length >= 400, `${mode} should have many more than twenty batches`);
    assert.equal(new Set(deck.map(pick => pick.game.appId)).size, deck.length);
    assert.ok(deck.every(pick => pick.game.appId > 10));
    assert.ok(deck.every(pick => mode !== "short" || (pick.game.minutes ?? Infinity) <= 600));
    assert.ok(deck.every(pick => mode !== "cheap" || cheapWishlistBand(pick.game, "GB") === 1));
  }
});

test("deep candidate windows continue past an exhausted franchise instead of ending the deck", () => {
  const repetitive = Array.from({ length: 600 }, (_, i) => game(i + 1, `Space Saga ${i + 1}`, { reviews: 500000, positive: 490000 }));
  const varied = Array.from({ length: 40 }, (_, i) => game(i + 1000, `Unusual ${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}world`));
  const deck = recommendWishlist([...repetitive, ...varied], [], [], "acclaimed", 123);
  assert.ok(deck.length >= 40);
  assert.ok(deck.filter(pick => pick.game.title.startsWith("Space Saga")).length <= 2);
});

test("For you preserves smaller played interests in a large library and varies genuine reasons", () => {
  const library = Array.from({ length: 150 }, (_, i) => libraryGame(i + 10000, `Finished strategy ${i}`, { status: "Completed", hoursPlayed: 200, tagProfile: { Strategy: 100 } }));
  for (const [i, tag] of ["Puzzle", "Horror", "Platformer", "Roguelike", "Simulation"].entries()) {
    library.push(libraryGame(i + 11000, `Played ${tag}`, { hoursPlayed: 8, tagProfile: { [tag]: 100 } }));
  }
  const pool = ["Strategy", "Puzzle", "Horror", "Platformer", "Roguelike", "Simulation"].flatMap((tag, i) => Array.from({ length: 40 }, (_, j) => game(i * 100 + j + 1, `${tag} ${String.fromCharCode(97 + Math.floor(j / 26))}${String.fromCharCode(97 + j % 26)}world`, { tags: { [tag]: 100 }, genres: [tag] })));
  const saved = Array.from({ length: 20 }, (_, i) => game(12000 + i, `Saved action ${i}`, { tags: { Shooter: 100 }, genres: ["Action"] }));
  for (const seed of [42, 321, 891]) {
    const deck = recommendWishlist(pool, library, saved, "for-you", seed);
    assert.equal(deck.length, 240);
    const first = deck.slice(0, 9);
    assert.ok(new Set(first.map(pick => pick.game.genres[0])).size >= 5, "one heavy genre must not erase five smaller played interests");
    assert.ok(first.filter(pick => pick.signal === "library").length >= 6);
    assert.ok(first.some(pick => /you played 8h of Played/.test(pick.reason)));
    assert.equal(new Set(first.map(pick => pick.reasonKey)).size, 9);
  }
});

test("different players receive different relevant games, rather than a popular shared shelf", () => {
  const pool = ["Strategy", "Horror"].flatMap((tag, i) => Array.from({ length: 120 }, (_, j) => game(i * 1000 + j + 1, `${tag} ${String.fromCharCode(97 + Math.floor(j / 26))}${String.fromCharCode(97 + j % 26)}realm`, { tags: { [tag]: 100 }, genres: [tag] })));
  const strategy = [libraryGame(5000, "My tactics game", { hoursPlayed: 50, tagProfile: { Strategy: 100 } })];
  const horror = [libraryGame(5001, "My horror game", { status: "Completed", hoursPlayed: 9, tagProfile: { Horror: 100 } })];
  for (const seed of [99, 567, 8765]) {
    const a = recommendWishlist(pool, strategy, [], "for-you", seed).slice(0, 9);
    const b = recommendWishlist(pool, horror, [], "for-you", seed).slice(0, 9);
    assert.ok(a.filter(pick => pick.game.genres[0] === "Strategy").length >= 7);
    assert.ok(b.filter(pick => pick.game.genres[0] === "Horror").length >= 7);
    assert.ok(!a.some(pick => b.some(other => other.game.appId === pick.game.appId)));
  }
});

test("deep scoring windows keep other played interests reachable beyond hundreds of top matches", () => {
  const letters = (i: number) => `${String.fromCharCode(97 + Math.floor(i / 676))}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + i % 26)}`;
  const tags = ["Strategy", "Puzzle", "Horror", "Platformer", "Roguelike", "Simulation"];
  const library = tags.map((tag, i) => libraryGame(20000 + i, `Played ${tag}`, { status: i === 0 ? "Completed" : "In Progress", hoursPlayed: i === 0 ? 1000 : 8, tagProfile: { [tag]: 100 } }));
  const pool = tags.flatMap((tag, group) => Array.from({ length: group === 0 ? 1000 : 80 }, (_, i) => game(group * 2000 + i + 1, `${tag} ${letters(i)}realm`, { tags: { [tag]: 100 }, genres: [tag] })));
  const deck = recommendWishlist(pool, library, [], "for-you", 321);
  for (let start = 0; start < 45; start += 9) {
    const batch = deck.slice(start, start + 9);
    assert.ok(new Set(batch.map(pick => pick.game.genres[0])).size >= 5, `batch ${start / 9} must reach interests beyond the first 512 ranked games`);
    assert.ok(batch.filter(pick => pick.signal === "library").length >= 5);
  }
});

test("pricing markets cover every currency and distinguish all four regional USD stores", () => {
  assert.equal(STEAM_PRICE_MARKETS.length, 41);
  assert.equal(new Set(STEAM_PRICE_MARKETS.map(m => m.currency)).size, 37);
  assert.ok(STEAM_PRICE_MARKETS.every(m => isSteamStoreCountry(m.code) && steamBudgetBand(m.currency)));
  assert.equal(steamPriceMarket("DE").name, "Europe");
  assert.equal(steamPriceMarket("FR").code, "FR");
  assert.equal(steamPriceMarket("AR").name, "Latin America");
  assert.equal(steamPriceMarket("TR").name, "Middle East & North Africa");
  assert.equal(steamPriceMarket("BD").name, "South Asia");
  assert.equal(steamPriceMarket("UZ").name, "CIS & neighbouring markets");
  assert.equal(steamPriceMarket("JP").currency, "JPY");
  assert.equal(steamPriceMarket("NG").code, "US");
  for (const region of STEAM_STORE_REGIONS) assert.ok(steamPriceMarketSearch(steamPriceMarket(region.code)).includes(region.name.toLowerCase()));
});
