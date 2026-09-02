import assert from "node:assert/strict";
import test from "node:test";
import { MAX_POPULARITY_POINTS, MAX_VERDICT_PENALTY, MAX_VERDICT_POINTS, hoursFor, popularityPoints, verdictBaseline, verdictFor, verdictPoints } from "./game-verdict.ts";

const BASELINE = 0.6;

test("a game nobody has met is judged on its own merits alone", () => {
  // The normal case, and permanently so: a game released tomorrow has no
  // verdict, and every game in the catalogue starts here.
  assert.equal(verdictPoints(undefined, BASELINE), 0);
  assert.equal(verdictPoints(null, BASELINE), 0);
  assert.equal(verdictPoints([0, 0], BASELINE), 0);
  assert.equal(verdictFor(null, 400), null);
  assert.equal(verdictFor({}, 400), null);
});

test("a game everyone set aside is pushed down hard", () => {
  // Resident Evil Resistance: 13 of 13 people slept it. No tag model can see
  // that, because it shares its tags with games worth playing.
  const unanimouslyRejected = verdictPoints([0, 40], BASELINE);
  assert.ok(unanimouslyRejected < -5, `expected a real penalty, got ${unanimouslyRejected}`);
  assert.ok(unanimouslyRejected >= -MAX_VERDICT_PENALTY);
});

test("evidence has to accumulate before it overrides the game itself", () => {
  // Two people are not a verdict. Fifty are. The gap between those is the whole
  // reason this is shrunk rather than taken at face value.
  const thin = verdictPoints([0, 2], BASELINE);
  const solid = verdictPoints([0, 60], BASELINE);

  assert.ok(thin < 0, "even thin evidence leans");
  assert.ok(solid < thin, "more evidence should move it further");
  assert.ok(Math.abs(thin) < Math.abs(solid) / 3, "two observations must stay close to the prior");
});

test("praise is capped tighter than condemnation", () => {
  // That people finished a game is not a reason to put it ahead of one that
  // actually suits the evening. That everyone abandoned it is a reason not to
  // offer it at all.
  const loved = verdictPoints([60, 60], BASELINE);
  const hated = verdictPoints([0, 60], BASELINE);

  assert.ok(loved > 0 && loved <= MAX_VERDICT_POINTS);
  assert.ok(hated >= -MAX_VERDICT_PENALTY);
  assert.ok(Math.abs(hated) > loved, "a rejected game moves further than a loved one");
});

test("the baseline is the average of what we have, not a guess", () => {
  assert.equal(verdictBaseline({ a: [5, 10], b: [5, 10] }), 0.5);
  assert.equal(verdictBaseline({ a: [9, 10], b: [1, 10] }), 0.5);
  // Nothing to average, and rows that say nothing, fall back to even odds
  // rather than skewing the reference every game is measured against.
  assert.equal(verdictBaseline({}), 0.5);
  assert.equal(verdictBaseline({ a: [0, 0] }), 0.5);
});

test("a game at the population average is left where it is", () => {
  // The term only says "unlike other games". A game exactly like them should not
  // be moved in either direction, however much evidence there is.
  const average = verdictPoints([60, 100], 0.6);
  assert.ok(Math.abs(average) < 0.01, `expected no push, got ${average}`);
});

test("popularity keeps climbing where the rate flattens out", () => {
  // The whole reason this term exists. The verdict beside it is a rate, capped
  // at 1, so on live data a 50,000 hour game and a 5,000 hour game both landed
  // at about 1.12x the odds. Hours are absolute and have to keep going.
  const at5k = popularityPoints(5_000);
  const at50k = popularityPoints(50_000);
  assert.ok(at50k > at5k * 1.5, `50k must clearly beat 5k, got ${at5k} vs ${at50k}`);
  assert.equal(at50k, MAX_POPULARITY_POINTS);
});

test("a few hundred hours is not a verdict", () => {
  // Across every player, a few hundred hours is a handful of people. Below the
  // floor a game is not pushed at all - it is left to its own merits.
  assert.equal(popularityPoints(500), 0);
  assert.equal(popularityPoints(120), 0);
  assert.equal(popularityPoints(0), 0);
  assert.equal(popularityPoints(undefined), 0);
  assert.equal(popularityPoints(null), 0);
  // Nonsense must not become a boost.
  assert.equal(popularityPoints(Number.NaN), 0);
  assert.equal(popularityPoints(-5_000), 0);
});

test("popularity rises with each tenfold increase and then stops", () => {
  const points = [1_000, 5_000, 20_000, 50_000].map(popularityPoints);
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(points[index] > points[index - 1], `expected ${points[index]} > ${points[index - 1]}`);
  }
  // Past the ceiling it is already pushing as hard as it can, so a runaway
  // outlier cannot drown out everything else in a library.
  assert.equal(popularityPoints(500_000), MAX_POPULARITY_POINTS);
  assert.equal(popularityPoints(5_000_000), MAX_POPULARITY_POINTS);
});

test("hours are read from the verdict a game carries, or default to none", () => {
  assert.equal(hoursFor({ "440": [10, 20, 9_000] }, 440), 9_000);
  // A verdict written before hours existed must read as no claim, not as zero
  // hours being meaningful.
  assert.equal(hoursFor({ "440": [10, 20] }, 440), 0);
  assert.equal(hoursFor({}, 440), 0);
  assert.equal(hoursFor(null, 440), 0);
  assert.equal(hoursFor({ "440": [10, 20, 9_000] }, null), 0);
});
