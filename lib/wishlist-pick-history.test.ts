import test from "node:test";
import assert from "node:assert/strict";
import { readWishlistPickHistory, rememberWishlistPicks, wishlistHistoryStorageKey } from "./wishlist-pick-history.ts";

test("only served picks persist, independently by tab/market and account", () => {
  const history = readWishlistPickHistory(null);
  rememberWishlistPicks(history, "for-you:GB", [1, 2, 3]);
  const raw = rememberWishlistPicks(history, "cheap:JP", [4, 5]);
  const restored = readWishlistPickHistory(raw);
  assert.deepEqual([...restored.get("for-you:GB")!], [1, 2, 3]);
  assert.deepEqual([...restored.get("cheap:JP")!], [4, 5]);
  assert.notEqual(wishlistHistoryStorageKey("guest"), wishlistHistoryStorageKey("steam:123"));
});

test("history is bounded and corrupted browser data cannot hide arbitrary games", () => {
  for (const raw of ["bad", "{}", "null"]) assert.equal(readWishlistPickHistory(raw).size, 0);
  const restored = readWishlistPickHistory(JSON.stringify([["for-you:GB", [1, -1, "2", null, 2]], ["bad", [3]]]));
  assert.deepEqual([...restored.get("for-you:GB")!], [1, 2]);
  const raw = rememberWishlistPicks(restored, "for-you:GB", Array.from({ length: 6100 }, (_, i) => i + 1));
  const seen = readWishlistPickHistory(raw).get("for-you:GB")!;
  assert.equal(seen.size, 6000);
  assert.ok(!seen.has(1));
  assert.ok(seen.has(6100));
});
