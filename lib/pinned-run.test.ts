import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { buildPinnedRunSummary } from "./pinned-run.ts";
import { UNKNOWN_RECENCY } from "./recency.ts";

function game(patch: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "game-1",
    title: "Test game",
    steamAppId: 1,
    ownership: "Owned",
    status: "In Progress",
    hoursPlayed: 5,
    completionPercent: 25,
    priority: "Medium",
    genres: [],
    description: "",
    artworkUrl: "",
    bannerUrl: "",
    lastPlayedLabel: "",
    recency: UNKNOWN_RECENCY,
    addedLabel: "",
    collectionIds: [],
    sessionFit: [],
    moodTags: [],
    duration: { mainStoryMinutes: 1_200 },
    ...patch,
  };
}

test("does not mistake existing completion for progress since pinning", () => {
  const summary = buildPinnedRunSummary(game(), {
    gameId: "game-1",
    pinnedAt: "2026-08-28T12:00:00.000Z",
    hoursAtPin: 5,
  });

  assert.equal(summary.headline, "No play since pinning");
  assert.equal(summary.percent, 25);
  assert.equal(summary.beforePercent, 25);
  assert.equal(summary.earnedPercent, 0);
});

test("celebrates only the progress earned after the pin baseline", () => {
  const summary = buildPinnedRunSummary(game({ hoursPlayed: 8, completionPercent: 40 }), {
    gameId: "game-1",
    pinnedAt: null,
    hoursAtPin: 5,
  });

  assert.equal(summary.headline, "3h played since pinning");
  assert.equal(summary.beforePercent, 25);
  assert.equal(summary.earnedPercent, 15);
  assert.equal(summary.trackedHoursLabel, "3h since pinning");
});

test("never attributes progress when the pin baseline is missing", () => {
  const summary = buildPinnedRunSummary(game(), {
    gameId: "game-1",
    pinnedAt: null,
    hoursAtPin: null,
  });

  assert.equal(summary.headline, "Pinned and ready");
  assert.match(summary.message, /next playtime check/i);
  assert.equal(summary.earnedPercent, null);
  assert.equal(summary.trackedHours, null);
});

test("omits percentage and remaining-time claims for endless games", () => {
  const summary = buildPinnedRunSummary(game({ duration: { endless: true }, completionPercent: 70 }), {
    gameId: "game-1",
    pinnedAt: null,
    hoursAtPin: 4,
  });

  assert.equal(summary.percent, null);
  assert.equal(summary.remainingLabel, null);
});
