import assert from "node:assert/strict";
import test from "node:test";
import { progressLabel, isEndlessProgress, ENDLESS_PROGRESS_SYMBOL } from "./progress-display.ts";

test("an endless game shows infinity rather than a near-complete percentage", () => {
  const game = { status: "In Progress", completionPercent: 99, duration: { endless: true } };
  assert.equal(progressLabel(game), ENDLESS_PROGRESS_SYMBOL);
  assert.equal(isEndlessProgress(game), true);
});

test("an endless game can still be completed, and then reads 100%", () => {
  const game = { status: "Completed", completionPercent: 99, duration: { endless: true } };
  assert.equal(progressLabel(game), "100%");
  assert.equal(isEndlessProgress(game), false);
});

test("inferred progress is marked as an estimate", () => {
  assert.equal(progressLabel({ status: "In Progress", completionPercent: 76 }), "76% est");
});

test("a finished game states its completion rather than estimating it", () => {
  assert.equal(progressLabel({ status: "Completed", completionPercent: 100 }), "100%");
});

test("a game with no progress reads zero rather than blank", () => {
  assert.equal(progressLabel({ status: "Not Started" }), "0% est");
});
