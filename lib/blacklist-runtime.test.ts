import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { getVaultEligibility } from "./vault.ts";
import { patchGameSchema } from "./validation.ts";
import type { DemoGame } from "./demo-data.ts";
import { UNKNOWN_RECENCY } from "./recency.ts";
import { applyGamePatch, restoreActiveGame } from "./game-state.ts";

function game(status: DemoGame["status"]): DemoGame {
  return {
    id: "game", title: "Game", steamAppId: 1, ownership: "Owned", status,
    hoursPlayed: 0, completionPercent: 0, priority: "Medium", genres: ["Action"],
    description: "", artworkUrl: "", bannerUrl: "", lastPlayedLabel: "Never",
    addedLabel: "Added", collectionIds: [], sessionFit: ["short"], moodTags: ["chill"],
    recency: UNKNOWN_RECENCY,
  };
}

function eligibility(games: DemoGame[]) {
  return getVaultEligibility({
    games, session: null, mood: null, goal: null, selectedCollectionId: null,
    selectedGenres: [], snoozedIds: new Set(),
  });
}

test("blacklist is a permanent status exclusion until the user reactivates it", () => {
  const active = game("In Progress");
  const blacklisted = applyGamePatch(active, { status: "Blacklisted" });
  assert.deepEqual(eligibility([blacklisted]).games, []);

  // Advancing the actual process clock cannot restore permanent state: the
  // eligibility path has no expiry clock or blacklist timestamp to consult.
  mock.timers.enable({ apis: ["Date"], now: new Date("2030-04-01T00:00:00.000Z") });
  try {
    assert.deepEqual(eligibility([blacklisted]).games, []);
  } finally {
    mock.timers.reset();
  }

  const reactivated = restoreActiveGame(blacklisted);
  assert.equal(reactivated.status, "In Progress");
  assert.deepEqual(eligibility([reactivated]).games.map((entry) => entry.id), ["game"]);
});

test("the write payload permits Blacklisted without a blacklist date and rejects retired Sleep fields", () => {
  assert.deepEqual(patchGameSchema.parse({ status: "Blacklisted" }), { status: "Blacklisted" });
  assert.equal(patchGameSchema.safeParse({ status: "Slept", slept_at: "2030-01-01T00:00:00.000Z" }).success, false);
  assert.equal(patchGameSchema.safeParse({ status: "Blacklisted", slept_at: "2030-01-01T00:00:00.000Z" }).success, false);
  assert.equal(patchGameSchema.safeParse({ status: "Blacklisted", blacklisted_at: "2030-01-01T00:00:00.000Z" }).success, false);
});
