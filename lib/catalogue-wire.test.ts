import assert from "node:assert/strict";
import test from "node:test";
import { decodeCatalogue, encodeCatalogue } from "./catalogue-wire.ts";
import { recommendWishlist, type WishlistGame } from "./wishlist.ts";

const games: WishlistGame[] = Array.from({ length: 1000 }, (_, i) => ({
  appId: 10000 + i, title: `Example game ${i}`, image: `https://example.invalid/${i}.jpg`,
  genres: i % 2 ? ["Strategy", "RPG"] : ["Adventure"],
  tags: { "Singleplayer": 1, "Story Rich": 0.321234567890123, [i % 2 ? "Strategy" : "Adventure"]: 0.5 },
  minutes: i % 5 ? 120 + i : null, endless: i % 5 === 0,
  positive: 500 + i, reviews: 550 + i, source: "local", budgetHint: i % 2 === 0,
}));

test("catalogue transport preserves every game, tag weight, order, null and optional field", () => {
  const input = [...games, { ...games[0], appId: 9, tags: undefined, minutes: 0, description: "Unicode: 🎮 日本語", price: { current: "£0", discount: 0, country: "GB" } }];
  const before = JSON.parse(JSON.stringify(input));
  const wire = JSON.parse(JSON.stringify(encodeCatalogue(input)));
  assert.deepEqual(decodeCatalogue(wire), before);
  assert.deepEqual(input[0], games[0]);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(before).length * 0.65);
});

test("decoded catalogue produces identical complete recommendation decks in every mode", () => {
  const restored = decodeCatalogue<WishlistGame>(JSON.parse(JSON.stringify(encodeCatalogue(games))));
  for (const mode of ["for-you", "short", "cheap", "acclaimed"] as const) {
    assert.deepEqual(recommendWishlist(restored, [], [], mode, 314159), recommendWishlist(games, [], [], mode, 314159));
  }
});

test("guest defaults and label maps round trip without lending shared mutable tag maps", () => {
  const input = [
    { id: "guest-1", user_id: "", status: "Not Started", notes: "", steam_tags: { "Action": 21, "RPG": 9 }, steam_categories: ["Single-player"], platform_mac: false, release_date: null },
    { id: "guest-2", user_id: "", status: "Not Started", notes: "", steam_tags: { "RPG": 19 }, steam_categories: null, platform_mac: true, release_date: "2025" },
  ];
  assert.deepEqual(decodeCatalogue(encodeCatalogue(input)), input);
  const equalMaps = [{ tags: { Action: 1 } }, { tags: { Action: 1 } }];
  const result = decodeCatalogue<typeof equalMaps[number]>(encodeCatalogue(equalMaps));
  assert.deepEqual(result, equalMaps);
  result[0].tags.Action = 2;
  assert.equal(result[1].tags.Action, 1);
});

test("old payloads and empty pools remain compatible; malformed compact payloads fail cleanly", () => {
  assert.equal(decodeCatalogue({ games }), games);
  assert.deepEqual(decodeCatalogue(encodeCatalogue([])), []);
  assert.throws(() => decodeCatalogue({}), /Unknown catalogue/);
  const invalid = encodeCatalogue(games);
  invalid.rows[0].pop();
  assert.throws(() => decodeCatalogue(invalid), /Invalid catalogue row/);
});
