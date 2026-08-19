import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame, VaultSessionId } from "./demo-data.ts";
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

test("caps the deck and rotates a rerolled game behind replacements", () => {
  const pool = Array.from({ length: MAX_VAULT_DECK_SIZE + 8 }, (_, index) => ({
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
  assert.ok(rotated.some((entry) => entry.game.id === `game-${MAX_VAULT_DECK_SIZE}`));
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
  assert.ok(weak.reasons.includes("Solid Intense match"));
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

test("mood ranks a clash last instead of removing it", () => {
  // Only the goal removes games. Mood is a preference, so a survival horror asked
  // for on a Chill night sinks to the bottom rather than ceasing to exist.
  const neutral = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: 0 } };
  const clash = { ...makeGame(), id: "clash", title: "Clash", moodScores: { "brain-off": 0, chill: -6, intense: 6 } };
  const pool = buildVaultPool({
    games: [neutral, clash],
    session: null, mood: "chill", goal: null,
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });

  assert.equal(pool.length, 2, "mood must not remove anything");
  assert.deepEqual(pool.map((entry) => entry.game.id), ["game-1", "clash"]);
});

test("a session mismatch is ranked down, not filtered out", () => {
  const long = { ...makeGame(), id: "long", title: "Long", duration: { mainStoryMinutes: 6_000 }, sessionFit: ["weekend"] as VaultSessionId[] };
  const brief = { ...makeGame(), duration: { mainStoryMinutes: 120 }, sessionFit: ["short", "evening", "weekend"] as VaultSessionId[] };
  const pool = buildVaultPool({
    games: [long, brief],
    session: "short", mood: null, goal: null,
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });

  assert.equal(pool.length, 2, "session must not remove anything");
  assert.equal(pool[0].game.id, "game-1", "the game that actually fits should lead");
});

test("only the goal removes games from the pool", () => {
  const played = { ...makeGame(), id: "played", title: "Played", status: "In Progress" as const, hoursPlayed: 40 };
  const fresh = { ...makeGame(), status: "Not Started" as const, hoursPlayed: 0 };
  const pool = buildVaultPool({
    games: [played, fresh],
    session: "short", mood: "chill", goal: "new",
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });

  assert.deepEqual(pool.map((entry) => entry.game.id), ["game-1"]);
});

test("a game with no mood signal is never stranded", () => {
  // 33 games in a real library matched no mood at all and so could never be
  // drawn, because a mood is always chosen.
  const blank = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: 0 } };
  for (const mood of ["brain-off", "chill", "intense"] as const) {
    const pool = buildVaultPool({
      games: [blank], session: null, mood, goal: null,
      selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
    });
    assert.equal(pool.length, 1, `${mood} stranded a game with no signal`);
  }
});

test("mood separates games far more than it used to", () => {
  const built = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: 8 } };
  const tolerable = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: -2 } };
  const strong = scoreVaultGame(built, null, "intense", null, []);
  const weak = scoreVaultGame(tolerable, null, "intense", null, []);

  // Previously the whole range was 21-30 of 30, so mood barely moved a score.
  assert.ok(strong.score - weak.score >= 50, `mood spread was only ${strong.score - weak.score}`);
});

test("a weekend prefers a long game over a short one", () => {
  // Short games are eligible for a weekend now, so scoring has to be what keeps
  // the session meaningful.
  const short = { ...makeGame(), duration: { mainStoryMinutes: 120 }, sessionFit: ["short", "evening", "weekend"] as const };
  const long = { ...makeGame(), duration: { mainStoryMinutes: 3_600 }, sessionFit: ["weekend"] as const };
  const shortScore = scoreVaultGame({ ...short, sessionFit: [...short.sessionFit] }, "weekend", null, null, []);
  const longScore = scoreVaultGame({ ...long, sessionFit: [...long.sessionFit] }, "weekend", null, null, []);

  assert.ok(longScore.score > shortScore.score, "a weekend draw should still favour something meaty");
});
