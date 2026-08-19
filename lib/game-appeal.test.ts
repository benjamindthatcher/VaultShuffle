import assert from "node:assert/strict";
import test from "node:test";
import { appealDetail, appealLabel, gameAppeal, MAX_APPEAL_POINTS } from "./game-appeal.ts";

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

test("the term stays inside its bound", () => {
  for (const appeal of [of(9_800_000, 9_800_000), of(0, 5_000), of(50, 50), of(0, 0)]) {
    assert.ok(Math.abs(appeal.points) <= MAX_APPEAL_POINTS + 0.001, `${appeal.points} exceeded the bound`);
  }
});

test("a game with no reviews at all is simply neutral", () => {
  const appeal = gameAppeal({ reviewPositive: null, reviewNegative: null, reviewTotal: null });
  assert.equal(appeal.points, 0);
  assert.equal(appeal.positivity, null);
  assert.equal(appealLabel(appeal.kind), null);
});
