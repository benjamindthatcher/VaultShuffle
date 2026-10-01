import test from "node:test";
import assert from "node:assert/strict";
import { selectWishlistCatalogue, hasWishlistBudgetHint, type WishlistDiscoveryRow } from "./wishlist-catalogue.ts";
const row = (id: number, patch: Partial<WishlistDiscoveryRow> = {}): WishlistDiscoveryRow => ({ steam_appid: id, name: `Game ${id}`, header_url: "art", genres: ["Adventure"], tags: { Adventure: 100 }, main_story_minutes: 480, duration_kind: "finite", review_positive: 950, review_total: 1000, ...patch });

test("wishlist selection adds short and budget depth beyond popular discovery while excluding quarantined and weak metadata", () => {
  const popular = Array.from({ length: 1300 }, (_, i) => row(i + 1, { main_story_minutes: 3000 }));
  const short = Array.from({ length: 800 }, (_, i) => row(i + 2000, { genres: ["Puzzle"], tags: { Puzzle: 100 } }));
  const budget = Array.from({ length: 800 }, (_, i) => row(i + 3000, { price_currency: "USD", price_final: 999 }));
  const result = selectWishlistCatalogue({ discovery: [...popular, row(9000, { genres: ["Unknown"] }), row(9001, { tags: {} })], short: [...short, row(9002, { duration_kind: "endless" })], acclaimed: [popular[0], row(9003, { review_positive: 200 })], budget }, new Set([1300, 2799, 3799]));
  assert.ok(result.length > 2800);
  assert.equal(new Set(result.map(game => game.steam_appid)).size, result.length);
  assert.ok(result.filter(game => game.genres?.includes("Puzzle")).length >= 790);
  assert.ok(result.filter(hasWishlistBudgetHint).length >= 790);
  for (const id of [1300, 2799, 3799, 9000, 9001, 9002, 9003]) assert.ok(!result.some(game => game.steam_appid === id));
  assert.equal(hasWishlistBudgetHint(row(20, { price_currency: "GBP", price_final: 999 })), false, "only use the source USD snapshot as a hint");
});
