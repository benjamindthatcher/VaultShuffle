import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGenrePreferenceIndex,
  genrePreferenceAdjustment,
  preferenceGenresFor,
  smoothedPreference,
  VAULT_PREFERENCE_MAX_POINTS,
  type GenrePreference
} from "./genre-preferences.ts";

function index(preferences: Array<Partial<GenrePreference> & { genre: string }>) {
  return buildGenrePreferenceIndex(preferences.map((preference) => ({
    contextMood: "any",
    positive: 0,
    total: 0,
    ...preference
  })) as GenrePreference[]);
}

test("no evidence scores exactly neutral", () => {
  assert.equal(smoothedPreference(0, 0), 0.5);
});

test("a single positive event nudges rather than declares", () => {
  const adjustment = genrePreferenceAdjustment(
    index([{ genre: "rpg", positive: 2, total: 2 }]),
    ["RPG"],
    "Some RPG",
    null
  );

  // One "liked" is worth a few points, not the full weight.
  assert.ok(adjustment.points > 0, "expected a positive nudge");
  assert.ok(adjustment.points < VAULT_PREFERENCE_MAX_POINTS / 2, `one event moved the score by ${adjustment.points}`);
});

test("sustained evidence approaches but never exceeds the cap", () => {
  const adjustment = genrePreferenceAdjustment(
    index([{ genre: "rpg", positive: 200, total: 200 }]),
    ["RPG"],
    "Some RPG",
    null
  );

  assert.ok(adjustment.points > VAULT_PREFERENCE_MAX_POINTS * 0.9);
  assert.ok(adjustment.points < VAULT_PREFERENCE_MAX_POINTS);
});

test("a disliked genre subtracts and says so", () => {
  const adjustment = genrePreferenceAdjustment(
    index([{ genre: "strategy", positive: 0, total: 20 }]),
    ["Strategy"],
    "Some Strategy Game",
    null
  );

  assert.ok(adjustment.points < 0);
  assert.match(String(adjustment.reason), /rerolled/);
});

test("the mood-scoped row beats the mood-agnostic one", () => {
  const preferences = index([
    { genre: "rpg", contextMood: "any", positive: 0, total: 20 },
    { genre: "rpg", contextMood: "intense", positive: 20, total: 20 }
  ]);

  const intense = genrePreferenceAdjustment(preferences, ["RPG"], "Some RPG", "intense");
  const chill = genrePreferenceAdjustment(preferences, ["RPG"], "Some RPG", "chill");

  assert.ok(intense.points > 0, "the Intense context should win where it has evidence");
  assert.ok(chill.points < 0, "an unevidenced context should fall back to the general row");
  assert.match(String(intense.reason), /when Intense/);
});

test("a multi-genre game cannot stack the bonus", () => {
  const preferences = index([
    { genre: "rpg", positive: 40, total: 40 },
    { genre: "action", positive: 40, total: 40 },
    { genre: "adventure", positive: 40, total: 40 }
  ]);

  const many = genrePreferenceAdjustment(preferences, ["RPG", "Action", "Adventure"], "Big Game", null);
  const one = genrePreferenceAdjustment(index([{ genre: "rpg", positive: 40, total: 40 }]), ["RPG"], "Small Game", null);

  assert.ok(Math.abs(many.points - one.points) < 0.001, "three matching genres must not treble the term");
  assert.ok(many.points <= VAULT_PREFERENCE_MAX_POINTS);
});

test("an empty index is inert", () => {
  const adjustment = genrePreferenceAdjustment(index([]), ["RPG"], "Some RPG", "intense");
  assert.equal(adjustment.points, 0);
  assert.equal(adjustment.reason, null);
});

test("preference keys collapse onto top-level genres", () => {
  // Sub-tags must fold into the nine buckets that actually accumulate signal.
  assert.deepEqual(preferenceGenresFor(["Roguelike", "Fantasy", "Action"], "Hades"), ["action", "rpg"]);
});
