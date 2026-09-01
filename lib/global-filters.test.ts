import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { UNKNOWN_RECENCY } from "./recency.ts";
import {
  DEFAULT_GLOBAL_FILTERS,
  activeGlobalFilterCount,
  matchesGlobalFilters,
  parseGlobalFilters,
  playerModesFromCategories,
  type GlobalFilters
} from "./global-filters.ts";

const now = new Date("2026-09-01T12:00:00.000Z").getTime();

function game(overrides: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "g",
    title: "g",
    steamAppId: 1,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    genres: ["Action"],
    recency: UNKNOWN_RECENCY,
    description: "",
    artworkUrl: "",
    bannerUrl: "",
    lastPlayedLabel: "",
    addedLabel: "",
    collectionIds: [],
    sessionFit: ["short"],
    moodTags: ["chill"],
    ...overrides
  };
}

function filters(overrides: Partial<GlobalFilters> = {}): GlobalFilters {
  return { ...DEFAULT_GLOBAL_FILTERS, ...overrides };
}

test("the default filters let the whole library through", () => {
  // The topmost layer must be inert until someone actually asks for something.
  const anything = game({ releaseDate: null, playerModes: [], deckCompatibility: 0 });
  assert.equal(matchesGlobalFilters(anything, DEFAULT_GLOBAL_FILTERS, now), true);
  assert.equal(activeGlobalFilterCount(DEFAULT_GLOBAL_FILTERS), 0);
});

test("player mode reads Steam's categories, not the crowd's tags", () => {
  // Counter-Strike 2 carries thirty thousand community votes for "Co-op" and is
  // not a co-op game. Categories are the field that can be trusted here.
  assert.deepEqual(playerModesFromCategories(["Single-player", "Steam Cloud"]), ["single"]);
  assert.deepEqual(playerModesFromCategories(["Online Co-op", "Multi-player"]), ["coop", "multi"]);
  assert.deepEqual(playerModesFromCategories(["Shared/Split Screen"]), ["coop"]);
  assert.deepEqual(playerModesFromCategories([]), []);
  assert.deepEqual(playerModesFromCategories(null), []);
});

test("asking for single-player leaves out a game we cannot classify", () => {
  // 9% of owned games have no categories. Offering one of those to someone who
  // asked for single-player is how a filter loses trust, so it sits out.
  const unknown = game({ playerModes: [] });
  const solo = game({ playerModes: ["single"] });
  const coopOnly = game({ playerModes: ["coop", "multi"] });

  assert.equal(matchesGlobalFilters(solo, filters({ players: "single" }), now), true);
  assert.equal(matchesGlobalFilters(coopOnly, filters({ players: "single" }), now), false);
  assert.equal(matchesGlobalFilters(unknown, filters({ players: "single" }), now), false);
  // ...but it is back the moment the question is not being asked.
  assert.equal(matchesGlobalFilters(unknown, filters({ players: "any" }), now), true);
});

test("release age splits the shelf where these libraries actually sit", () => {
  const lastYear = game({ releaseDate: "2025-10-01" });
  const fourYears = game({ releaseDate: "2022-06-01" });
  const eightYears = game({ releaseDate: "2018-06-01" });
  const ancient = game({ releaseDate: "2008-03-01" });

  assert.equal(matchesGlobalFilters(lastYear, filters({ releaseAge: "recent" }), now), true);
  assert.equal(matchesGlobalFilters(fourYears, filters({ releaseAge: "recent" }), now), false);

  assert.equal(matchesGlobalFilters(fourYears, filters({ releaseAge: "modern" }), now), true);
  assert.equal(matchesGlobalFilters(eightYears, filters({ releaseAge: "modern" }), now), false);

  // Established is the mirror of modern, so nothing falls between the two.
  assert.equal(matchesGlobalFilters(eightYears, filters({ releaseAge: "established" }), now), true);
  assert.equal(matchesGlobalFilters(fourYears, filters({ releaseAge: "established" }), now), false);

  assert.equal(matchesGlobalFilters(ancient, filters({ releaseAge: "classic" }), now), true);
  assert.equal(matchesGlobalFilters(eightYears, filters({ releaseAge: "classic" }), now), false);
});

test("an undated game is neither recent nor a classic", () => {
  const undated = game({ releaseDate: null });
  assert.equal(matchesGlobalFilters(undated, filters({ releaseAge: "recent" }), now), false);
  assert.equal(matchesGlobalFilters(undated, filters({ releaseAge: "classic" }), now), false);
  assert.equal(matchesGlobalFilters(undated, filters({ releaseAge: "any" }), now), true);

  // A date Steam gave us that does not parse must not read as "brand new".
  const nonsense = game({ releaseDate: "coming soon" });
  assert.equal(matchesGlobalFilters(nonsense, filters({ releaseAge: "recent" }), now), false);
});

test("finite means not known to be endless, so missing data is not punished", () => {
  const endless = game({ duration: { endless: true } });
  const finite = game({ duration: { endless: false } });
  const noVerdict = game({ duration: undefined });

  assert.equal(matchesGlobalFilters(endless, filters({ gameType: "endless" }), now), true);
  assert.equal(matchesGlobalFilters(finite, filters({ gameType: "endless" }), now), false);

  assert.equal(matchesGlobalFilters(finite, filters({ gameType: "finite" }), now), true);
  assert.equal(matchesGlobalFilters(endless, filters({ gameType: "finite" }), now), false);
  // Around 7% of owned games have no verdict. Hiding those would cost more than
  // letting the occasional treadmill through.
  assert.equal(matchesGlobalFilters(noVerdict, filters({ gameType: "finite" }), now), true);
});

test("a game is only called poorly reviewed once enough people have said so", () => {
  const panned = game({ reviewPositive: 30, reviewNegative: 170, reviewTotal: 200 });
  const loved = game({ reviewPositive: 180, reviewNegative: 20, reviewTotal: 200 });
  // The floor protects exactly the games this is meant to surface: a small good
  // game with a handful of reviews must not be cut on a thin ratio.
  const barelyRated = game({ reviewPositive: 1, reviewNegative: 5, reviewTotal: 6 });

  assert.equal(matchesGlobalFilters(panned, filters({ hidePoorlyReviewed: true }), now), false);
  assert.equal(matchesGlobalFilters(loved, filters({ hidePoorlyReviewed: true }), now), true);
  assert.equal(matchesGlobalFilters(barelyRated, filters({ hidePoorlyReviewed: true }), now), true);
  assert.equal(matchesGlobalFilters(panned, filters({ hidePoorlyReviewed: false }), now), true);
});

test("Deck mode wants confidence, not the benefit of the doubt", () => {
  // 3 verified, 2 playable, 1 unsupported, 0 unknown. Unknown is not offered:
  // the whole point of the mode is that the pick will actually run.
  assert.equal(matchesGlobalFilters(game({ deckCompatibility: 3 }), filters({ device: "deck" }), now), true);
  assert.equal(matchesGlobalFilters(game({ deckCompatibility: 2 }), filters({ device: "deck" }), now), true);
  assert.equal(matchesGlobalFilters(game({ deckCompatibility: 1 }), filters({ device: "deck" }), now), false);
  assert.equal(matchesGlobalFilters(game({ deckCompatibility: null }), filters({ device: "deck" }), now), false);

  const macGame = game({ platforms: { windows: true, mac: true, linux: false } });
  const windowsOnly = game({ platforms: { windows: true, mac: false, linux: false } });
  assert.equal(matchesGlobalFilters(macGame, filters({ device: "mac" }), now), true);
  assert.equal(matchesGlobalFilters(windowsOnly, filters({ device: "mac" }), now), false);
});

test("filters combine, so every one of them has to pass", () => {
  const chosen = filters({ device: "mac", players: "single", releaseAge: "modern", gameType: "finite" });
  assert.equal(activeGlobalFilterCount(chosen), 4);

  const fits = game({
    platforms: { windows: true, mac: true, linux: false },
    playerModes: ["single"],
    releaseDate: "2023-01-01",
    duration: { endless: false }
  });
  assert.equal(matchesGlobalFilters(fits, chosen, now), true);

  // One failing answer is enough, even with everything else right.
  assert.equal(matchesGlobalFilters({ ...fits, releaseDate: "2001-01-01" }, chosen, now), false);
  assert.equal(matchesGlobalFilters({ ...fits, playerModes: ["multi"] }, chosen, now), false);
});

test("a stored shape from an older release cannot empty the library", () => {
  // This comes back out of someone's browser, so it may be anything at all. A
  // value we do not recognise has to fall back to "no opinion", never to a
  // filter that hides games the player never asked to hide.
  assert.deepEqual(parseGlobalFilters(null), DEFAULT_GLOBAL_FILTERS);
  assert.deepEqual(parseGlobalFilters("not json"), DEFAULT_GLOBAL_FILTERS);
  assert.deepEqual(parseGlobalFilters("[]"), DEFAULT_GLOBAL_FILTERS);
  assert.deepEqual(parseGlobalFilters('{"device":"nintendo","players":"solo"}'), DEFAULT_GLOBAL_FILTERS);

  assert.deepEqual(
    parseGlobalFilters('{"device":"deck","players":"coop","releaseAge":"classic","gameType":"endless","hidePoorlyReviewed":true}'),
    { device: "deck", players: "coop", releaseAge: "classic", gameType: "endless", hidePoorlyReviewed: true }
  );
  // Anything short of an explicit true leaves the toggle off.
  assert.equal(parseGlobalFilters('{"hidePoorlyReviewed":"yes"}').hidePoorlyReviewed, false);
});
