import assert from "node:assert/strict";
import test from "node:test";
import {
  ANY_MOOD_CONTEXT,
  BASELINE_GENRE,
  buildGenrePreferenceIndex,
  buildGenreWeightIndex,
  genrePreferenceAdjustment,
  preferenceGenresFor,
  shrunkRate,
  VAULT_PREFERENCE_MAX_POINTS,
  type GenrePreference
} from "./genre-preferences.ts";

function context(
  preferences: Array<Partial<GenrePreference> & { genre: string }>,
  genreWeights: Map<string, number> | null = null
) {
  const index = buildGenrePreferenceIndex(preferences.map((preference) => ({
    contextMood: ANY_MOOD_CONTEXT,
    positive: 0,
    total: 0,
    ...preference
  })) as GenrePreference[]);
  return { index, genreWeights };
}

/** A user who responds well to a fifth of draws — roughly what the data shows. */
const baseline = { genre: BASELINE_GENRE, positive: 20, total: 100 };

test("no evidence leaves the rate at the prior", () => {
  assert.equal(shrunkRate(0, 0, 0.5), 0.5);
  assert.equal(shrunkRate(0, 0, 0.2), 0.2);
});

test("a genre matching the user's own base rate scores neutral, not negative", () => {
  // The whole point of centring: with a 20% baseline, a genre that also runs at
  // 20% is unremarkable and must not be penalised for it.
  const adjustment = genrePreferenceAdjustment(
    context([baseline, { genre: "rpg", positive: 4, total: 20 }]),
    ["RPG"],
    "Some RPG",
    null
  );

  assert.ok(Math.abs(adjustment.points) < 1, `expected ~0, got ${adjustment.points}`);
});

test("a genre beating the user's base rate scores positive even with no launches elsewhere", () => {
  const adjustment = genrePreferenceAdjustment(
    context([baseline, { genre: "rpg", positive: 16, total: 20 }]),
    ["RPG"],
    "Some RPG",
    null
  );

  assert.ok(adjustment.points > 0, `expected positive, got ${adjustment.points}`);
  assert.match(String(adjustment.reason), /lands well/);
});

test("a genre below the user's base rate is penalised", () => {
  const adjustment = genrePreferenceAdjustment(
    context([baseline, { genre: "strategy", positive: 0, total: 30 }]),
    ["Strategy"],
    "Some Strategy Game",
    null
  );

  assert.ok(adjustment.points < 0);
  // A negative shapes the draw but is never printed as a justification for it.
  assert.equal(adjustment.reason, null);
});

test("the term stays inside its bound in both directions", () => {
  const best = genrePreferenceAdjustment(
    context([baseline, { genre: "rpg", positive: 500, total: 500 }]), ["RPG"], "x", null);
  const worst = genrePreferenceAdjustment(
    context([baseline, { genre: "rpg", positive: 0, total: 500 }]), ["RPG"], "x", null);

  assert.ok(best.points <= VAULT_PREFERENCE_MAX_POINTS + 0.001, `${best.points}`);
  assert.ok(worst.points >= -VAULT_PREFERENCE_MAX_POINTS - 0.001, `${worst.points}`);
});

test("negatives are not dwarfed by positives when the baseline is low", () => {
  // With a 20% baseline there is four times as much room above as below, so an
  // unnormalised mapping would make a rejection barely register.
  const best = genrePreferenceAdjustment(
    context([baseline, { genre: "rpg", positive: 500, total: 500 }]), ["RPG"], "x", null);
  const worst = genrePreferenceAdjustment(
    context([baseline, { genre: "rpg", positive: 0, total: 500 }]), ["RPG"], "x", null);

  assert.ok(Math.abs(Math.abs(worst.points) - best.points) < 0.5,
    `asymmetric: +${best.points} vs ${worst.points}`);
});

test("one weak event cannot create a preference", () => {
  const adjustment = genrePreferenceAdjustment(
    context([baseline, { genre: "rpg", positive: 2, total: 2 }]),
    ["RPG"],
    "Some RPG",
    null
  );

  assert.ok(adjustment.points < VAULT_PREFERENCE_MAX_POINTS / 3,
    `one event moved the score by ${adjustment.points}`);
});

test("a thin mood row does not override a thick general one", () => {
  // The previous hard switch let this single event beat forty in the general row.
  const preferences = context([
    baseline,
    { genre: "rpg", contextMood: ANY_MOOD_CONTEXT, positive: 0, total: 40 },
    { genre: "rpg", contextMood: "intense", positive: 1, total: 1 }
  ]);

  const adjustment = genrePreferenceAdjustment(preferences, ["RPG"], "Some RPG", "intense");
  assert.ok(adjustment.points < 0, `one Intense event should not flip 40 rejections: ${adjustment.points}`);
});

test("a well-evidenced mood row does take over", () => {
  const preferences = context([
    baseline,
    { genre: "rpg", contextMood: ANY_MOOD_CONTEXT, positive: 0, total: 40 },
    { genre: "rpg", contextMood: "intense", positive: 40, total: 40 }
  ]);

  const intense = genrePreferenceAdjustment(preferences, ["RPG"], "Some RPG", "intense");
  const chill = genrePreferenceAdjustment(preferences, ["RPG"], "Some RPG", "chill");

  assert.ok(intense.points > 0, `expected the Intense evidence to win: ${intense.points}`);
  assert.ok(chill.points < 0, "an unevidenced context should fall back to the general row");
  assert.match(String(intense.reason), /when Intense/);
});

test("a multi-genre game cannot stack the bonus", () => {
  const many = genrePreferenceAdjustment(context([
    baseline,
    { genre: "rpg", positive: 40, total: 40 },
    { genre: "action", positive: 40, total: 40 },
    { genre: "adventure", positive: 40, total: 40 }
  ]), ["RPG", "Action", "Adventure"], "Big Game", null);

  const one = genrePreferenceAdjustment(
    context([baseline, { genre: "rpg", positive: 40, total: 40 }]), ["RPG"], "Small Game", null);

  assert.ok(Math.abs(many.points - one.points) < 0.001, "three matching genres must not treble the term");
});

test("a rare genre outweighs a ubiquitous one", () => {
  // Action sits on most of the library, so it discriminates almost nothing.
  const corpus = [
    ...Array.from({ length: 90 }, () => ({ genres: ["Action"], title: "Shooter" })),
    ...Array.from({ length: 10 }, () => ({ genres: ["Action", "Racing"], title: "Racer" }))
  ];
  const weights = buildGenreWeightIndex(corpus);
  assert.ok((weights.get("racing") ?? 0) > (weights.get("action") ?? 0),
    "rare genres must carry more credit than common ones");

  // A game whose rare genre is loved and whose common genre is not should still
  // come out ahead, because the rare genre is the informative one.
  const adjustment = genrePreferenceAdjustment(context([
    baseline,
    { genre: "action", positive: 0, total: 40 },
    { genre: "racing", positive: 40, total: 40 }
  ], weights), ["Action", "Racing"], "Racer", null);

  assert.ok(adjustment.points > 0, `rare genre should dominate: ${adjustment.points}`);
});

test("an empty index is inert", () => {
  const adjustment = genrePreferenceAdjustment(context([]), ["RPG"], "Some RPG", "intense");
  assert.equal(adjustment.points, 0);
  assert.equal(adjustment.reason, null);
});

test("preference keys collapse onto top-level genres", () => {
  assert.deepEqual(preferenceGenresFor(["Roguelike", "Fantasy", "Action"], "Hades"), ["action", "rpg"]);
});
