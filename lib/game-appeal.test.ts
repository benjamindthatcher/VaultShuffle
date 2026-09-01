import assert from "node:assert/strict";
import test from "node:test";
import { appealDetail, appealLabel, gameAppeal, MAX_APPEAL_PENALTY, MAX_APPEAL_POINTS } from "./game-appeal.ts";

const of = (positive: number, total: number) =>
  gameAppeal({ reviewPositive: positive, reviewNegative: total - positive, reviewTotal: total });

test("a landmark game reads as a phenomenon", () => {
  // Counter-Strike 2 territory: millions of reviews, broadly liked.
  const appeal = of(1_200_000, 1_500_000);
  assert.equal(appeal.kind, "phenomenon");
  assert.ok(appeal.points > 3, `expected a real boost, got ${appeal.points}`);
});

test("adored but obscure reads as a hidden gem", () => {
  // Militia in the real library: 94% positive from 141 reviews.
  const appeal = of(133, 141);
  assert.equal(appeal.kind, "hidden-gem");
  assert.ok(appeal.points > 0);
  assert.match(String(appealDetail(appeal)), /only 141 reviews/);
});

test("a game cannot be both a phenomenon and a hidden gem", () => {
  const huge = of(900_000, 1_000_000);
  assert.equal(huge.hiddenGem, 0, "obscurity must collapse once everyone has played it");
});

test("a handful of glowing reviews is not evidence", () => {
  // Three positive reviews is 100% and means nothing.
  const appeal = of(3, 3);
  assert.equal(appeal.kind, null);
  assert.equal(appeal.points, 0);
  assert.equal(appeal.hiddenGem, 0);
});

test("a poorly reviewed game is marked down rather than quietly ranked", () => {
  const appeal = of(200, 600);
  assert.equal(appeal.kind, "divisive");
  assert.ok(appeal.points < 0, `expected a penalty, got ${appeal.points}`);
});

test("popularity only counts as hype when people liked it", () => {
  const loved = of(90_000, 100_000);
  const loathed = of(40_000, 100_000);
  assert.ok(loved.hype > loathed.hype, "being widely played is not the same as being wanted");
});

test("the term stays inside its bounds, which are not symmetric", () => {
  // Praise is capped tighter than condemnation on purpose: being adored should
  // not outrank whether a game suits the evening, while a game most players
  // disliked has no evening that saves it.
  for (const appeal of [of(9_800_000, 9_800_000), of(0, 5_000), of(50, 50), of(0, 0)]) {
    assert.ok(appeal.points <= MAX_APPEAL_POINTS + 0.001, `${appeal.points} exceeded the upper bound`);
    assert.ok(appeal.points >= -MAX_APPEAL_PENALTY - 0.001, `${appeal.points} exceeded the lower bound`);
  }
});

test("a game with no reviews at all is simply neutral", () => {
  const appeal = gameAppeal({ reviewPositive: null, reviewNegative: null, reviewTotal: null });
  assert.equal(appeal.points, 0);
  assert.equal(appeal.positivity, null);
  assert.equal(appealLabel(appeal.kind), null);
});

test("disapproval is a slope, not a cliff", () => {
  // One threshold at 55% demoted a game liked by 54% exactly as hard as one
  // liked by 15%. They are not the same game and should not draw the same.
  const at54 = gameAppeal({ reviewPositive: 1080, reviewTotal: 2000 }).points;
  const at45 = gameAppeal({ reviewPositive: 900, reviewTotal: 2000 }).points;
  const at20 = gameAppeal({ reviewPositive: 400, reviewTotal: 2000 }).points;

  assert.ok(at20 < at45, "worse reviews must demote harder");
  assert.ok(at45 < at54, "worse reviews must demote harder");
  assert.ok(at54 < 0, "a game most people did not like is still demoted");
});

test("a panned game is genuinely unlikely, not marginally so", () => {
  // The flat -3 this replaces left a widely panned game at 82% of the odds of an
  // equally fitting one, which is a rounding error rather than a demotion.
  const panned = gameAppeal({ reviewPositive: 1000, reviewTotal: 5000 });
  assert.equal(panned.points, -MAX_APPEAL_PENALTY);
  assert.equal(panned.kind, "divisive");

  // Asymmetric on purpose: being adored must not outrank whether a game suits
  // the evening, but being disliked by most players has no session that saves it.
  const adored = gameAppeal({ reviewPositive: 190000, reviewTotal: 200000 });
  assert.ok(adored.points > 0 && adored.points <= MAX_APPEAL_POINTS);
  assert.ok(Math.abs(panned.points) > adored.points);
});

test("a handful of opinions still condemns nothing", () => {
  // The floor that protects small good games: below twenty reviews no verdict is
  // claimed at all, however bad the ratio looks.
  assert.equal(gameAppeal({ reviewPositive: 3, reviewTotal: 15 }).points, 0);
  // ...and confidence ramps rather than switching on, so a thin-but-real sample
  // is demoted less than a large one saying the same thing.
  const thin = gameAppeal({ reviewPositive: 20, reviewTotal: 100 }).points;
  const solid = gameAppeal({ reviewPositive: 400, reviewTotal: 2000 }).points;
  assert.ok(thin < 0);
  assert.ok(solid < thin, "more people saying it should count for more");
});
