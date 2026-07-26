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

test("session matching uses estimated remaining playthrough time", () => {
  const duration = { mainStoryMinutes: 600, completionistMinutes: 1_800 };

  assert.deepEqual(deriveSessionFits({ duration, completionPercent: 0, endless: false }), ["evening"]);
  assert.deepEqual(deriveSessionFits({ duration, completionPercent: 70, endless: false }), ["short"]);
});

test("endless games remain valid for every session length", () => {
  assert.deepEqual(
    deriveSessionFits({ duration: null, completionPercent: 0, endless: true }),
    ["short", "evening", "weekend"]
  );
});
