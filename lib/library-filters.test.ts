import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { UNKNOWN_RECENCY } from "./recency.ts";
import {
  EMPTY_LIBRARY_FILTERS,
  activeFilterCount,
  availableGenres,
  matchesLibraryFilters
} from "./library-filters.ts";

function game(overrides: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "g", title: "Game", steamAppId: 1, ownership: "Owned", status: "Not Started",
    hoursPlayed: 0, completionPercent: 0, priority: "Medium", genres: ["Action"],
    recency: UNKNOWN_RECENCY, description: "", artworkUrl: "", bannerUrl: "",
    lastPlayedLabel: "", addedLabel: "", collectionIds: [], sessionFit: [], moodTags: [],
    ...overrides
  } as unknown as DemoGame;
}

const minutes = (h: number) => ({ mainStoryMinutes: h * 60, endless: false });

test("no filters match everything", () => {
  assert.equal(matchesLibraryFilters(game(), EMPTY_LIBRARY_FILTERS), true);
  assert.equal(activeFilterCount(EMPTY_LIBRARY_FILTERS), 0);
});

test("progress is judged on playtime, not the status label", () => {
  const filters = { ...EMPTY_LIBRARY_FILTERS, progress: "in-progress" as const };
  assert.equal(matchesLibraryFilters(game({ hoursPlayed: 4 }), filters), true);
  assert.equal(matchesLibraryFilters(game({ hoursPlayed: 0 }), filters), false);
});

test("length buckets do not overlap at their boundaries", () => {
  const at = (h: number, bucket: "under-10" | "10-30" | "over-30") =>
    matchesLibraryFilters(game({ duration: minutes(h) } as Partial<DemoGame>), { ...EMPTY_LIBRARY_FILTERS, length: bucket });

  // Estimates are rounded to the nearest hour upstream, so the boundaries that
  // matter are whole hours.
  assert.equal(at(9, "under-10"), true);
  assert.equal(at(10, "under-10"), false);
  assert.equal(at(10, "10-30"), true);
  assert.equal(at(30, "10-30"), true);
  assert.equal(at(31, "10-30"), false);
  assert.equal(at(31, "over-30"), true);
  assert.equal(at(9, "over-30"), false);
});

test("a game with no estimate is not guessed into a length bucket", () => {
  const noEstimate = game({ duration: undefined });
  for (const length of ["under-10", "10-30", "over-30", "endless"] as const) {
    assert.equal(matchesLibraryFilters(noEstimate, { ...EMPTY_LIBRARY_FILTERS, length }), false, length);
  }
  assert.equal(matchesLibraryFilters(noEstimate, EMPTY_LIBRARY_FILTERS), true);
});

test("endless games only match the endless bucket", () => {
  const endless = game({ duration: { endless: true } } as Partial<DemoGame>);
  assert.equal(matchesLibraryFilters(endless, { ...EMPTY_LIBRARY_FILTERS, length: "endless" }), true);
  assert.equal(matchesLibraryFilters(endless, { ...EMPTY_LIBRARY_FILTERS, length: "over-30" }), false);
});

test("picking several genres means any of them, not all", () => {
  const filters = { ...EMPTY_LIBRARY_FILTERS, genres: ["RPG", "Strategy"] };
  assert.equal(matchesLibraryFilters(game({ genres: ["Strategy"] }), filters), true);
  assert.equal(matchesLibraryFilters(game({ genres: ["Action"] }), filters), false);
});

test("genre matching ignores case", () => {
  assert.equal(matchesLibraryFilters(game({ genres: ["rpg"] }), { ...EMPTY_LIBRARY_FILTERS, genres: ["RPG"] }), true);
});

test("the badge counts decisions, not ticks", () => {
  assert.equal(activeFilterCount({ progress: "in-progress", length: "any", genres: [] }), 1);
  assert.equal(activeFilterCount({ progress: "in-progress", length: "under-10", genres: ["RPG", "Action", "Indie"] }), 3);
});

test("only genres actually in the library are offered, commonest first", () => {
  const games = [game({ genres: ["Action", "RPG"] }), game({ genres: ["Action"] }), game({ genres: ["Unknown"] })];
  assert.deepEqual(availableGenres(games), ["Action", "RPG"]);
});
