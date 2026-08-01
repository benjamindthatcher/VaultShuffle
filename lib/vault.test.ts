import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import {
  MAX_VAULT_DECK_SIZE,
  buildVaultDeck,
  buildVaultPool,
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
  assert.deepEqual(result.reasons, ["Short fit", "High energy", "Action", "Unplayed"]);
});

test("Surprise Me widens the pool without diluting the selected fit score", () => {
  const result = scoreVaultGame(makeGame(), "short", "intense", "surprise", []);
  assert.equal(result.score, 100);
  assert.deepEqual(result.reasons, ["Short fit", "High energy", "Wildcard"]);
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

test("keeps the deck at 32 and rotates a rerolled game behind replacements", () => {
  const pool = Array.from({ length: 40 }, (_, index) => ({
    game: makeGame({ id: `game-${index}`, title: `Game ${String(index).padStart(2, "0")}` }),
    score: 100 - index,
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
