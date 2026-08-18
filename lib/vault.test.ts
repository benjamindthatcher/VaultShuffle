import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import {
  MAX_VAULT_DECK_SIZE,
  buildVaultDeck,
  buildVaultPool,
  drawQuickVaultGame,
  drawVaultGame,
  scoreVaultGame,
  vaultMatchLabel
} from "./vault.ts";

function makeGame(overrides: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "game-1",
    title: "Test Game",
    steamAppId: 1,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    genres: ["Action"],
    description: "Test game",
    artworkUrl: "",
    bannerUrl: "",
    lastPlayedLabel: "Never",
    addedLabel: "Added today",
    collectionIds: [],
    sessionFit: ["short"],
    moodTags: ["intense"],
    moodScores: { "brain-off": 0, chill: 0, intense: 7 },
    duration: {
      mainStoryMinutes: 180,
      mainExtrasMinutes: 180,
      completionistMinutes: 180
    },
    ...overrides
  };
}

test("awards a perfect match for exact session, mood, goal and genre alignment", () => {
  const result = scoreVaultGame(makeGame(), "short", "intense", "new", ["action"]);
  assert.equal(result.score, 100);
  assert.equal(vaultMatchLabel(result.score), "Perfect match");
  assert.deepEqual(result.reasons, ["Ideal short session length", "Perfect Intense match", "Unplayed", "Action"]);
});

test("Surprise Me widens the pool without diluting the selected fit score", () => {
  const result = scoreVaultGame(makeGame(), "short", "intense", "surprise", []);
  assert.equal(result.score, 100);
  assert.deepEqual(result.reasons, ["Ideal short session length", "Perfect Intense match", "Wildcard"]);
});

test("uses stable match brackets including Perfect", () => {
  assert.equal(vaultMatchLabel(94), "Perfect match");
  assert.equal(vaultMatchLabel(85), "Excellent match");
  assert.equal(vaultMatchLabel(70), "Strong match");
  assert.equal(vaultMatchLabel(55), "Good match");
  assert.equal(vaultMatchLabel(40), "Eligible pick");
});

test("Finish Something excludes endless games", () => {
  const endless = makeGame({
    status: "In Progress",
    hoursPlayed: 20,
    completionPercent: 99,
    duration: { endless: true },
    sessionFit: ["short", "evening", "weekend"]
  });

  const pool = buildVaultPool({
    games: [endless],
    session: null,
    mood: null,
    goal: "finish",
    selectedCollectionId: "all",
    selectedGenres: [],
    snoozedIds: new Set()
  });

  assert.equal(pool.length, 0);
});

test("collection draws ignore session, mood, goal and genre filters", () => {
  const collectionGames = [
    makeGame({
      id: "collection-action",
      title: "Collection Action",
      collectionIds: ["collection-1"]
    }),
    makeGame({
      id: "collection-strategy",
      title: "Collection Strategy",
      collectionIds: ["collection-1"],
      genres: ["Strategy"],
      sessionFit: ["weekend"],
      moodTags: ["chill"],
      moodScores: { "brain-off": 0, chill: 7, intense: 0 },
      hoursPlayed: 12,
      status: "In Progress"
    }),
    makeGame({ id: "outside", title: "Outside", collectionIds: [] })
  ];

  const pool = buildVaultPool({
    games: collectionGames,
    session: "short",
    mood: "intense",
    goal: "new",
    selectedCollectionId: "collection-1",
    selectedGenres: ["Action"],
    snoozedIds: new Set()
  });

  assert.deepEqual(pool.map((entry) => entry.game.id), ["collection-action", "collection-strategy"]);
  assert.ok(pool.every((entry) => entry.score === 0));
});

test("keeps the deck at 32 and rotates a rerolled game behind replacements", () => {
  const pool = Array.from({ length: 40 }, (_, index) => ({
    game: makeGame({ id: `game-${index}`, title: `Game ${String(index).padStart(2, "0")}` }),
    score: 100 - index,
    preferencePoints: 0,
    reasons: []
  }));

  const initial = buildVaultDeck(pool);
  const rotated = buildVaultDeck(pool, ["game-0"]);

  assert.equal(initial.length, MAX_VAULT_DECK_SIZE);
  assert.equal(rotated.length, MAX_VAULT_DECK_SIZE);
  assert.equal(initial[0].game.id, "game-0");
  assert.ok(!rotated.some((entry) => entry.game.id === "game-0"));
  assert.ok(rotated.some((entry) => entry.game.id === "game-32"));
});

test("quick draw can reach every game in the pool, not just the top slice", () => {
  const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => ({
    game: { ...makeGame(), id, title: id },
    score: 0,
    reasons: []
  })) as unknown as Parameters<typeof drawQuickVaultGame>[0];

  const reached = new Set<string>();
  for (let index = 0; index < pool.length; index += 1) {
    const picked = drawQuickVaultGame(pool, null, () => index / pool.length);
    if (picked) reached.add(picked.id);
  }

  assert.equal(reached.size, pool.length);
});

test("quick draw does not repeat the previous winner", () => {
  const pool = ["a", "b"].map((id) => ({
    game: { ...makeGame(), id, title: id },
    score: 0,
    reasons: []
  })) as unknown as Parameters<typeof drawQuickVaultGame>[0];

  assert.equal(drawQuickVaultGame(pool, "a", () => 0)?.id, "b");
});

test("reasons describe the game, not just the options the player picked", () => {
  const weakMoodMatch = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: 3 } };
  const strong = scoreVaultGame(makeGame(), "short", "intense", "surprise", []);
  const weak = scoreVaultGame(weakMoodMatch, "short", "intense", "surprise", []);

  assert.notDeepEqual(strong.reasons, weak.reasons);
  assert.ok(strong.reasons.includes("Perfect Intense match"));
  assert.ok(weak.reasons.includes("Intense match"));
});

test("a dormant game says so, and a recently played one does not", () => {
  const now = Date.UTC(2026, 7, 18);
  const day = 86_400_000;

  const dormant = scoreVaultGame(
    { ...makeGame(), lastPlayedAt: new Date(now - 200 * day).toISOString() },
    "short", "intense", "surprise", [], now
  );
  const recent = scoreVaultGame(
    { ...makeGame(), lastPlayedAt: new Date(now - 3 * day).toISOString() },
    "short", "intense", "surprise", [], now
  );

  assert.ok(dormant.reasons.includes("Not played in 7 months"));
  assert.ok(!recent.reasons.some((reason) => reason.startsWith("Not played")));
});

test("a learned preference changes the odds but never the candidate set", () => {
  // The regression this guards: the pool is sorted then truncated twice, so a
  // preference folded into `score` would make disfavoured games undrawable
  // instead of merely less likely.
  const pool = Array.from({ length: 40 }, (_, index) => ({
    game: makeGame({ id: `game-${index}`, title: `Game ${String(index).padStart(2, "0")}` }),
    score: 100 - index,
    // The last game in the deck is heavily disfavoured.
    preferencePoints: index === 31 ? -8 : 0,
    reasons: []
  }));

  const deck = buildVaultDeck(pool);
  assert.ok(deck.some((entry) => entry.game.id === "game-31"), "ranking must ignore preference");

  const always = () => 0.999999;
  const withPreference = drawVaultGame(deck, null, always, true);
  const without = drawVaultGame(deck, null, always, false);

  // Both arms draw from the same finalists; only the weighting differs.
  assert.ok(withPreference && without);
});

test("the preference term shifts selection odds in the arm that uses it", () => {
  const pool = [
    { game: makeGame({ id: "liked", title: "Liked" }), score: 80, preferencePoints: 8, reasons: [] },
    { game: makeGame({ id: "disliked", title: "Disliked" }), score: 80, preferencePoints: -8, reasons: [] }
  ];

  // Chosen to sit between the two arms' cutoffs: with equal weights the draw
  // falls past the favoured game, and the tilt is what pulls it back.
  const rng = () => 0.6;
  assert.equal(drawVaultGame(pool, null, rng, false)?.id, "disliked");
  assert.equal(drawVaultGame(pool, null, rng, true)?.id, "liked");
});
