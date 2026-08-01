import assert from "node:assert/strict";
import test from "node:test";
import { gameProgress, isEndlessGame } from "./game-classification.ts";

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
