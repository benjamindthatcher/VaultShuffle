import assert from "node:assert/strict";
import test from "node:test";
import { deriveMoodScores, deriveSessionFits, moodTagsFromScores } from "./vault-matching.ts";

test("moods overlap and are scored independently", () => {
  const scores = deriveMoodScores(["Action", "Arcade", "Shooter", "Roguelite"]);
  const tags = moodTagsFromScores(scores);

  assert.ok(tags.includes("brain-off"));
  assert.ok(tags.includes("intense"));
  assert.ok(!tags.includes("chill"));
});

test("strategy and management simulations are not automatically brain-off", () => {
  const scores = deriveMoodScores(["Simulation", "Management", "Strategy", "Turn-Based"]);

  assert.ok(scores["brain-off"] < 0);
  assert.ok(!moodTagsFromScores(scores).includes("brain-off"));
});

test("puzzle does not automatically mean chill", () => {
  const scores = deriveMoodScores(["Puzzle"]);
  assert.equal(scores.chill, 0);
  assert.ok(!moodTagsFromScores(scores).includes("chill"));
});

test("a game suits its own session and every longer one", () => {
  // Time available is a ceiling, not a target: a game short enough for an evening
  // is still a fine pick for a free weekend. Confining each game to one band hid
  // most of the library behind whichever session was chosen.
  const duration = { mainStoryMinutes: 600, completionistMinutes: 1_800 };

  assert.deepEqual(deriveSessionFits({ duration, completionPercent: 0, endless: false }), ["evening", "weekend"]);
  assert.deepEqual(
    deriveSessionFits({ duration, completionPercent: 70, endless: false }),
    ["short", "evening", "weekend"]
  );
});

test("a very long game stays out of a short session", () => {
  assert.deepEqual(
    deriveSessionFits({ duration: { mainStoryMinutes: 6_000 }, completionPercent: 0, endless: false }),
    ["weekend"]
  );
});

test("an unknown length is not treated as a long game", () => {
  // A third of a real library has no duration estimate. Defaulting those to
  // "weekend" made them undrawable in a short or evening session.
  assert.deepEqual(
    deriveSessionFits({ duration: null, completionPercent: 0, endless: false }),
    ["short", "evening", "weekend"]
  );
});

test("endless games remain valid for every session length", () => {
  assert.deepEqual(
    deriveSessionFits({ duration: null, completionPercent: 0, endless: true }),
    ["short", "evening", "weekend"]
  );
});
