import assert from "node:assert/strict";
import test from "node:test";
import { selectGuestPool, guestQualityRank, GUEST_NICHES } from "./guest-pool.ts";

function game(id: number, tags: string[], rank: number | null = null, reviews = 100) {
  return {
    steam_appid: id,
    genres: [],
    tags: Object.fromEntries(tags.map((tag) => [tag, 100])),
    popularity_rank: rank,
    review_total: reviews
  };
}

test("a niche with one game is represented before a huge niche gets a second", () => {
  const candidates = [
    ...Array.from({ length: 50 }, (_, i) => game(100 + i, ["Action"], i + 1)),
    game(999, ["Farming Sim"], 5000)
  ];

  const pool = selectGuestPool(candidates, 3);
  assert.ok(pool.some((g) => g.steam_appid === 999), "the only farming sim must be in a pool of three");
});

test("every niche present in the data appears in a large enough pool", () => {
  const niches = ["Action", "Puzzle", "Rhythm", "Farming Sim", "Grand Strategy"];
  const candidates = niches.flatMap((niche, index) =>
    Array.from({ length: 20 }, (_, i) => game(index * 100 + i, [niche], index * 100 + i + 1))
  );

  const pool = selectGuestPool(candidates, 10, niches);
  const covered = new Set(pool.flatMap((g) => Object.keys(g.tags ?? {})));
  assert.deepEqual([...covered].sort(), [...niches].sort());
});

test("a game is never selected twice even when it matches several niches", () => {
  const candidates = [game(1, ["Action", "RPG", "Roguelike", "Co-op"], 1), game(2, ["Puzzle"], 2)];
  const pool = selectGuestPool(candidates, 10);
  assert.equal(pool.length, 2);
  assert.equal(new Set(pool.map((g) => g.steam_appid)).size, 2);
});

test("games matching no listed niche still fill the pool rather than leaving it short", () => {
  const candidates = Array.from({ length: 5 }, (_, i) => game(i + 1, ["Something Obscure"], i + 1));
  assert.equal(selectGuestPool(candidates, 5).length, 5);
});

test("asking for more than exists returns everything, without duplicates", () => {
  const candidates = [game(1, ["Action"], 1), game(2, ["Puzzle"], 2)];
  const pool = selectGuestPool(candidates, 1000);
  assert.equal(pool.length, 2);
});

test("a ranked game always outranks an unranked one", () => {
  assert.ok(guestQualityRank(game(1, [], 9000)) < guestQualityRank(game(2, [], null, 500000)));
});

test("with no rank, more reviews wins", () => {
  assert.ok(guestQualityRank(game(1, [], null, 5000)) < guestQualityRank(game(2, [], null, 50)));
});

test("selection is deterministic, so the guest pool does not churn between requests", () => {
  const candidates = Array.from({ length: 200 }, (_, i) =>
    game(i, [GUEST_NICHES[i % GUEST_NICHES.length]], null, 1000 - i));
  const a = selectGuestPool(candidates, 40).map((g) => g.steam_appid);
  const b = selectGuestPool([...candidates].reverse(), 40).map((g) => g.steam_appid);
  assert.deepEqual(a, b);
});
