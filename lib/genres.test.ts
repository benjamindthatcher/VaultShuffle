import assert from "node:assert/strict";
import test from "node:test";
import {
  splitGenres,
  steamTagGenreLabels,
  steamTagLabels,
  topLevelGenresFor
} from "./genres.ts";

test("retains the complete Steam tag set in provider weight order", () => {
  const tags = {
    Multiplayer: 91,
    RPG: 143,
    "Story Rich": 143,
    Adventure: 110
  };

  assert.deepEqual(steamTagLabels(tags), ["RPG", "Story Rich", "Adventure", "Multiplayer"]);
});

test("builds a compact presentation set without discarding source tags", () => {
  const tags = {
    "Steam Achievements": 900,
    Multiplayer: 700,
    "Full Controller Support": 650,
    "Story Rich": 500,
    RPG: 450,
    Adventure: 400
  };

  assert.deepEqual(steamTagGenreLabels(tags), ["Story Rich", "RPG", "Adventure"]);
  assert.equal(steamTagLabels(tags).length, 6);
});

test("combines exact and mapped top-level genres", () => {
  assert.deepEqual(
    topLevelGenresFor("Action / Story Rich / Racing"),
    ["Action", "Racing", "Adventure"]
  );
});

test("ignores invalid provider weights", () => {
  assert.deepEqual(steamTagLabels({ RPG: 0, Adventure: -4, Strategy: Number.NaN }), []);
});

test("deduplicates genre labels without treating casing as meaningful", () => {
  assert.deepEqual(
    steamTagLabels({ "Free To Play": 100, "Free to Play": 90, Action: 80 }),
    ["Free To Play", "Action"]
  );
  assert.deepEqual(splitGenres("Free To Play / Free to Play / Action"), ["Free To Play", "Action"]);
});
