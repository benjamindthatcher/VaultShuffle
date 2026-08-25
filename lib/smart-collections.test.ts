import assert from "node:assert/strict";
import test from "node:test";
import { editableSmartCollectionPreset, matchesSmartPreset } from "./smart-collections.ts";
import type { Game } from "./types.ts";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "game-1",
    user_id: "user-1",
    title: "Test Game",
    genre: "Action",
    store: "Steam",
    ownership: "Owned",
    status: "In Progress",
    rating: 0,
    hours_played: 4,
    completion_percentage: 0,
    priority: "Medium",
    date_added: null,
    last_played_at: null,
    notes: "",
    steam_appid: "1",
    main_story_minutes: null,
    main_extras_minutes: null,
    completionist_minutes: null,
    duration_kind: "unknown",
    ...overrides,
  };
}

test("nearly finished includes active finite games at 65–99% only", () => {
  const nearlyFinished = makeGame({
    hours_played: 7,
    main_story_minutes: 600,
    duration_kind: "finite",
  });

  assert.equal(matchesSmartPreset(nearlyFinished, "nearly-finished"), true);
  assert.equal(matchesSmartPreset({ ...nearlyFinished, status: "Completed" }, "nearly-finished"), false);
  assert.equal(matchesSmartPreset({ ...nearlyFinished, duration_kind: "endless" }, "nearly-finished"), false);
});

test("quick wins uses remaining time rather than total duration", () => {
  const quickWin = makeGame({
    hours_played: 6,
    main_story_minutes: 720,
    duration_kind: "finite",
  });

  assert.equal(matchesSmartPreset(quickWin, "quick-wins"), true);
  assert.equal(matchesSmartPreset({ ...quickWin, hours_played: 2 }, "quick-wins"), false);
  assert.equal(matchesSmartPreset({ ...quickWin, duration_kind: "endless" }, "quick-wins"), false);
});

test("recently played and fallen off use distinct activity windows", () => {
  const now = Date.now();
  const recent = makeGame({ last_played_at: new Date(now - 10 * 86_400_000).toISOString() });
  const fallenOff = makeGame({ last_played_at: new Date(now - 200 * 86_400_000).toISOString() });

  assert.equal(matchesSmartPreset(recent, "recently-played"), true);
  assert.equal(matchesSmartPreset(recent, "fallen-off"), false);
  assert.equal(matchesSmartPreset(fallenOff, "recently-played"), false);
  assert.equal(matchesSmartPreset(fallenOff, "fallen-off"), true);
});

test("long haul and endless rotation remain mutually exclusive", () => {
  const longHaul = makeGame({
    hours_played: 5,
    main_story_minutes: 3_600,
    duration_kind: "finite",
  });
  const endless = makeGame({
    title: "Apex Legends",
    hours_played: 0,
    duration_kind: "endless",
  });

  assert.equal(matchesSmartPreset(longHaul, "long-haul"), true);
  assert.equal(matchesSmartPreset(longHaul, "endless-rotation"), false);
  assert.equal(matchesSmartPreset(endless, "long-haul"), false);
  assert.equal(matchesSmartPreset(endless, "endless-rotation"), true);
});

test("untouched excludes archived games", () => {
  const untouched = makeGame({ status: "Not Started", hours_played: 0 });

  assert.equal(matchesSmartPreset(untouched, "untouched"), true);
  assert.equal(matchesSmartPreset({ ...untouched, status: "Slept" }, "untouched"), false);
});

test("legacy saved rules map to current editable presets", () => {
  assert.equal(editableSmartCollectionPreset("backlog"), "untouched");
  assert.equal(editableSmartCollectionPreset("in-progress"), "recently-played");
  assert.equal(editableSmartCollectionPreset("short"), "quick-wins");
  assert.equal(editableSmartCollectionPreset("must-play"), "nearly-finished");
});

test("shelves work from inferred recency, not just exact Steam timestamps", () => {
  const now = Date.now();
  const observedRecently = makeGame({
    last_played_at: null,
    recency_source: "observed_playtime_change",
    last_observed_played_at: new Date(now - 5 * 86_400_000).toISOString()
  });
  const observedLongAgo = makeGame({
    last_played_at: null,
    recency_source: "observed_playtime_change",
    last_observed_played_at: new Date(now - 300 * 86_400_000).toISOString()
  });

  assert.equal(matchesSmartPreset(observedRecently, "recently-played"), true);
  assert.equal(matchesSmartPreset(observedLongAgo, "fallen-off"), true);
});

test("a game with no recency evidence lands on neither shelf", () => {
  // It has not fallen off. We have simply never watched it.
  const unobserved = makeGame({ last_played_at: null });
  assert.equal(matchesSmartPreset(unobserved, "recently-played"), false);
  assert.equal(matchesSmartPreset(unobserved, "fallen-off"), false);
});
