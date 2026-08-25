import assert from "node:assert/strict";
import test from "node:test";
import { sessionabilityScore, sessionLean, sessionabilityReason } from "./sessionability.ts";

test("a long roguelike is still a good forty minutes", () => {
  // The case the old model got backwards: fifty hours total, but a run is
  // twenty minutes and finishing one is a real ending.
  assert.equal(sessionLean(sessionabilityScore(["Roguelike", "Action", "Arcade"])), "pick-up");
});

test("a short narrative game is a poor forty minutes", () => {
  // Two hours total, but stopping halfway is the worst way to play it.
  assert.equal(sessionLean(sessionabilityScore(["Story Rich", "Narrative", "Adventure"])), "sit-down");
});

test("tags that say nothing leave the judgement neutral", () => {
  assert.equal(sessionabilityScore(["Action", "Indie", "Great Soundtrack"]), 0);
  assert.equal(sessionLean(0), "either");
  assert.equal(sessionabilityReason(0), null);
});

test("no tags at all is neutral rather than a guess", () => {
  assert.equal(sessionabilityScore([]), 0);
});

test("one clear tag is as decisive as several of the same kind", () => {
  const one = sessionabilityScore(["Roguelike"]);
  const several = sessionabilityScore(["Roguelike", "Arcade", "Fighting"]);
  assert.equal(one, several);
  assert.equal(one, 1);
});

test("a game pulling both ways lands between them", () => {
  const score = sessionabilityScore(["Roguelike", "Story Rich"]);
  assert.equal(score, 0);
  assert.equal(sessionLean(score), "either");
});

test("matching ignores case, spacing and punctuation", () => {
  assert.equal(sessionabilityScore(["TURN-BASED_STRATEGY"]), sessionabilityScore(["turn based strategy"]));
});

test("the wording never claims more than the tags support", () => {
  assert.equal(sessionabilityReason(sessionabilityScore(["Roguelike"])), "Picks up and puts down easily");
  assert.equal(sessionabilityReason(sessionabilityScore(["Grand Strategy"])), "Rewards an uninterrupted run at it");
  assert.equal(sessionabilityReason(sessionabilityScore(["Indie"])), null);
});
