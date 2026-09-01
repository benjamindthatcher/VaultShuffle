import assert from "node:assert/strict";
import test from "node:test";
import { statesAnOpinion } from "./draw-signal-precedence.ts";

test("a bare reroll on its own is the only thing that happened", () => {
  assert.equal(statesAnOpinion(["drew_again"]), false);
});

test('"Not really" then "Draw again" is one rejection, not two', () => {
  assert.equal(statesAnOpinion(["disliked", "drew_again"]), true);
});

test('"Yes" then "Draw again" does not let the reroll contradict the answer', () => {
  assert.equal(statesAnOpinion(["liked", "drew_again"]), true);
});

test("a reroll reason still supersedes the bare reroll", () => {
  assert.equal(statesAnOpinion(["reroll_not_interested", "drew_again"]), true);
});

test("a reason that is not about genre still suppresses the bare reroll", () => {
  // "Too long" says the session estimate was wrong, not that the genre is bad.
  // It teaches nothing itself, and must not let the bare reroll teach instead.
  assert.equal(statesAnOpinion(["reroll_too_long", "drew_again"]), true);
});

test("launching, pinning, sleeping and completing all count as stated opinions", () => {
  for (const eventType of ["opened_on_steam", "pinned", "slept", "marked_completed"]) {
    assert.equal(statesAnOpinion([eventType, "drew_again"]), true, eventType);
  }
});

test("snoozing states an opinion, so the reroll after it is not a second no", () => {
  // Snoozing and then drawing again is one rejection said twice. Counted
  // separately it turned a single no into two pieces of negative evidence, the
  // same double-count "Not really" plus a reroll used to cause.
  assert.equal(statesAnOpinion(["hidden_for_session", "drew_again"]), true);
});

test("an event that says nothing about the pick does not suppress the bare reroll", () => {
  assert.equal(statesAnOpinion(["unpinned", "drew_again"]), false);
  assert.equal(statesAnOpinion(["drew_again"]), false);
});
