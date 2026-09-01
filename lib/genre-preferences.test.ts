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
  type GenrePreference, capDecisionsPerUser } from "./genre-preferences.ts";

function toIndex(rows: Array<Partial<GenrePreference> & { genre: string }>) {
  return buildGenrePreferenceIndex(rows.map((row) => ({
    contextMood: ANY_MOOD_CONTEXT,
    positive: 0,
    total: 0,
    ...row
  })) as GenrePreference[]);
}

function context(
  preferences: Array<Partial<GenrePreference> & { genre: string }>,
  genreWeights: Map<string, number> | null = null,
  globals: Array<Partial<GenrePreference> & { genre: string }> = []
) {
  return { index: toIndex(preferences), globals: globals.length ? toIndex(globals) : null, genreWeights };
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

test("preference keys keep the specific labels as well as the coarse ones", () => {
  // Collapsing to top level was why the model could say so little: across two
  // thousand draws the whole spread between the eight buckets was seven points.
  // The tag labels are already on the game, so both levels are tallied - the
  // coarse key answers when a game's tags are unfamiliar, the sharp ones decide
  // when they are not.
  assert.deepEqual(preferenceGenresFor(["Roguelike", "Fantasy", "Action"], "Hades"), ["action", "rpg", "roguelike", "fantasy"]);
});

test("a funding model is still not a taste, however specific the keys get", () => {
  // Indie and Free to Play describe how a game was paid for, not how it plays.
  // Widening the axis must not smuggle them back in as learnable keys.
  assert.deepEqual(preferenceGenresFor(["Action", "Indie", "Shooter", "Fast-Paced"], "Doom"), ["action", "shooter", "fast-paced"]);
  assert.deepEqual(preferenceGenresFor(["Free to Play"], "x"), []);
});

test("a brand-new user inherits the population's view before earning their own", () => {
  // Cold start: no rows of their own at all.
  const population = [
    { genre: BASELINE_GENRE, positive: 20, total: 100 },
    { genre: "rpg", positive: 30, total: 60 },
    { genre: "sports", positive: 1, total: 40 }
  ];

  const loved = genrePreferenceAdjustment(context([], null, population), ["RPG"], "x", null);
  const ignored = genrePreferenceAdjustment(context([], null, population), ["Sports"], "x", null);

  assert.ok(loved.points > 0, `population favourite should start positive: ${loved.points}`);
  assert.ok(ignored.points < 0, `population reject should start negative: ${ignored.points}`);
});

test("a user's own evidence overrides what the population thinks", () => {
  const population = [
    { genre: BASELINE_GENRE, positive: 20, total: 100 },
    { genre: "rpg", positive: 60, total: 60 }
  ];
  // This user rejects RPGs regardless of what everyone else does.
  const own = [
    { genre: BASELINE_GENRE, positive: 20, total: 100 },
    { genre: "rpg", positive: 0, total: 60 }
  ];

  const adjustment = genrePreferenceAdjustment(context(own, null, population), ["RPG"], "x", null);
  assert.ok(adjustment.points < 0, `personal evidence must win: ${adjustment.points}`);
});

test("no population data leaves behaviour unchanged", () => {
  const own = [baseline, { genre: "rpg", positive: 16, total: 20 }];
  const withNone = genrePreferenceAdjustment(context(own), ["RPG"], "x", null);
  assert.ok(withNone.points > 0);
});

test("Indie is not learned as a taste for Casual games", () => {
  // Indie is a funding model. Hollow Knight being indie is no evidence that its
  // owner enjoys Casual games, but Indie maps to Casual for display.
  assert.deepEqual(preferenceGenresFor(["Indie"], "Hollow Knight"), []);
  assert.ok(!preferenceGenresFor(["Action", "Indie"], "Hollow Knight").includes("casual"));
});

test("Free to Play is not learned as a taste for Casual games", () => {
  assert.ok(!preferenceGenresFor(["Free to Play", "Action"], "Warframe").includes("casual"));
});

test("a game genuinely tagged Casual still learns as Casual", () => {
  assert.ok(preferenceGenresFor(["Casual", "Indie"], "A Short Hike").includes("casual"));
});

test("one bulk tidy-up cannot outvote the rest of the population", () => {
  // The completion sweep clears a backlog in a sitting: the median account has
  // marked 21 games, one has marked 443. Uncapped, that account carries twenty
  // ordinary ones and the taste it describes is a weekend of tidying.
  const bulk = Array.from({ length: 200 }, (_, index) => ({
    userId: "tidier",
    reviewedAt: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`
  }));
  const ordinary = [
    { userId: "someone", reviewedAt: "2026-08-30T00:00:00.000Z" },
    { userId: "someone", reviewedAt: "2026-08-31T00:00:00.000Z" }
  ];

  const capped = capDecisionsPerUser([...bulk, ...ordinary], 50);
  assert.equal(capped.filter((row) => row.userId === "tidier").length, 50);
  // An account under the cap is untouched.
  assert.equal(capped.filter((row) => row.userId === "someone").length, 2);
});

test("what survives the cap is what someone thinks now", () => {
  const decisions = [
    { userId: "u", reviewedAt: "2026-01-01T00:00:00.000Z", tag: "old" },
    { userId: "u", reviewedAt: "2026-08-01T00:00:00.000Z", tag: "recent" },
    { userId: "u", reviewedAt: "2026-04-01T00:00:00.000Z", tag: "middle" }
  ];

  assert.deepEqual(capDecisionsPerUser(decisions, 2).map((row) => row.tag), ["recent", "middle"]);
  assert.deepEqual(capDecisionsPerUser(decisions, 0), []);
  assert.equal(capDecisionsPerUser([], 50).length, 0);
});
