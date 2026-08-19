import assert from "node:assert/strict";
import test from "node:test";
import {
  gameProgress,
  hasEndlessDurationShape,
  hasStrongReplayabilitySignals,
  isEndlessGame
} from "./game-classification.ts";

test("finite progress is derived from the averaged duration rather than stale stored progress", () => {
  assert.equal(gameProgress({
    title: "The Witcher 2",
    genre: "RPG",
    hours_played: 17.5,
    completion_percentage: 94,
    status: "In Progress",
    main_story_minutes: 1_560,
    main_extras_minutes: 2_580,
    completionist_minutes: 3_600,
    duration_kind: "finite"
  }), 41);

  assert.equal(gameProgress({
    title: "Call of Duty: Modern Warfare",
    genre: "Action",
    hours_played: 10.1,
    completion_percentage: 99,
    status: "In Progress",
    main_story_minutes: 600,
    main_extras_minutes: 780,
    completionist_minutes: 960,
    duration_kind: "finite"
  }), 78);
});

test("explicit finite duration classification prevents broad title/tag fallbacks becoming endless", () => {
  const game = {
    title: "Fancy Skulls",
    genre: "Action / Indie / Free to Play / Early Access",
    hours_played: 4.5,
    duration_kind: "finite" as const,
    main_story_minutes: 240,
    main_extras_minutes: 300,
    completionist_minutes: 360
  };

  assert.equal(isEndlessGame(game), false);
  assert.equal(gameProgress(game), 90);
});

test("explicit endless classification always reports 99 percent even at zero hours", () => {
  const game = {
    title: "Apex Legends",
    genre: "Action",
    hours_played: 0,
    duration_kind: "endless" as const
  };

  assert.equal(isEndlessGame(game), true);
  assert.equal(gameProgress(game), 99);
});

test("a decisive tag only counts when it dominates the game's tags", () => {
  // Runner3 is a linear platformer carrying a minority "Massively Multiplayer"
  // vote; Valheim's survival-craft tag is its top tag.
  assert.equal(hasStrongReplayabilitySignals({
    tags: { "Platformer": 94, "Massively Multiplayer": 42 }, genres: [], categories: []
  }), false);
  assert.equal(hasStrongReplayabilitySignals({
    tags: { "Open World Survival Craft": 2379, "Survival": 2100 }, genres: [], categories: []
  }), true);
});

test("a completion time far beyond the story length reads as endless", () => {
  // Counter-Strike 2: 1h story, 186h completionist.
  assert.equal(hasEndlessDurationShape({ mainStoryMinutes: 60, completionistMinutes: 11160 }), true);
  // A normal long RPG stays finite.
  assert.equal(hasEndlessDurationShape({ mainStoryMinutes: 2400, completionistMinutes: 6000 }), false);
  assert.equal(hasEndlessDurationShape({ mainStoryMinutes: null, completionistMinutes: null }), false);
});
