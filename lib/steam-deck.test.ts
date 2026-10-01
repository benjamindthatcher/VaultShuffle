import assert from "node:assert/strict";
import test from "node:test";
import { steamDeckRating, shouldRefreshDeckRating } from "./steam-deck.ts";

test("Deck labels distinguish Valve Unknown from missing and invalid data", () => {
  assert.deepEqual([3, 2, 1, 0, null, undefined, 4, NaN].map(steamDeckRating).map(r => r.label),
    ["Verified", "Playable", "Unsupported", "Unknown", "Not checked", "Not checked", "Not checked", "Not checked"]);
});
test("known Deck ratings expire monthly, including unsupported and unknown verdicts", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  for (const category of [0, 1, 2, 3]) {
    assert.equal(shouldRefreshDeckRating(category, "2026-09-30T12:00:00Z", now), false);
    assert.equal(shouldRefreshDeckRating(category, "2026-09-01T12:00:00Z", now), true);
    assert.equal(shouldRefreshDeckRating(category, null, now), true);
  }
  assert.equal(shouldRefreshDeckRating(null, "2026-09-30T12:00:00Z", now), true);
  assert.equal(shouldRefreshDeckRating(3, "bad-date", now), true);
});
