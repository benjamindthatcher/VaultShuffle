import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { buildPurgeCandidates, type PurgeReview } from "./purge.ts";

const now = new Date("2026-08-13T14:30:00.000Z");

function game(id: string): DemoGame {
  return {
    id,
    title: id,
    steamAppId: 1,
    ownership: "Owned",
    status: "In Progress",
    hoursPlayed: 1,
    completionPercent: 99,
    priority: "Medium",
    genres: ["Action"],
    description: "",
    artworkUrl: "",
    bannerUrl: "",
    lastPlayedLabel: "Not played recently",
    addedLabel: "",
    collectionIds: [],
    sessionFit: ["short"],
    moodTags: ["chill"]
  };
}

function review(gameId: string, action: PurgeReview["action"], reviewedAt: string): PurgeReview {
  return { id: `${gameId}-${action}`, gameId, action, category: "untouched", reviewedAt };
}

test("a just-committed non-keep decision leaves a stale Purge queue immediately", () => {
  const candidates = buildPurgeCandidates({
    games: [game("once-human"), game("rust")],
    pinnedIds: [],
    currentPickId: null,
    snoozedIds: [],
    reviews: [review("once-human", "sleep", "2026-08-13T14:29:00.000Z")],
    now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["rust"]);
});

test("the short stale-data guard expires without replacing normal status checks", () => {
  const candidates = buildPurgeCandidates({
    games: [game("once-human")],
    pinnedIds: [],
    currentPickId: null,
    snoozedIds: [],
    reviews: [review("once-human", "sleep", "2026-08-13T14:20:00.000Z")],
    now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["once-human"]);
});
