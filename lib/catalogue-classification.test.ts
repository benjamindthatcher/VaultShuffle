import assert from "node:assert/strict";
import test from "node:test";
import { classifyCatalogueEntry } from "./catalogue-classification.ts";

const GAME_GENRES = ["Action", "Adventure"];

test("hides the app types Steam gets right", () => {
  for (const steamType of ["dlc", "demo", "music", "movie", "hardware"]) {
    const verdict = classifyCatalogueEntry({ title: "Something", steamType, genres: GAME_GENRES });
    assert.equal(verdict.excluded, true, `${steamType} should be excluded`);
    assert.equal(verdict.reviewRequired, false);
    assert.equal(verdict.matchedRule, `steam_type:${steamType}`);
  }
});

test("keeps the legacy games Steam still labels 'advertising'", () => {
  // 59 of the 65 AppIDs this rule had flagged were plainly games. Prey is the
  // one that gave the game away: Steam types it 'advertising' to this day.
  for (const title of ["Prey", "Rayman 2 - The Great Escape", "Darksiders II", "World in Conflict"]) {
    const verdict = classifyCatalogueEntry({ title, steamType: "advertising", genres: GAME_GENRES });
    assert.equal(verdict.excluded, false, `${title} must stay visible`);
    assert.equal(verdict.reviewRequired, false, `${title} must not nag a reviewer either`);
  }
});

test("keeps the standalone free games Steam labels 'mod'", () => {
  for (const title of ["Portal Stories: Mel", "Entropy : Zero", "NEOTOKYO°", "Half-Life 2: Update"]) {
    const verdict = classifyCatalogueEntry({ title, steamType: "mod", genres: GAME_GENRES });
    assert.equal(verdict.excluded, false, `${title} must stay visible`);
  }
});

test("hides software whose every genre is a software genre", () => {
  const wallpaperEngine = classifyCatalogueEntry({
    title: "Wallpaper Engine",
    steamType: "game",
    genres: ["Utilities", "Animation & Modeling", "Design & Illustration", "Video Production"]
  });
  assert.equal(wallpaperEngine.excluded, true);
  assert.equal(wallpaperEngine.matchedRule, "steam_genres:software_only");

  // Sold free, still software: the business-model labels rescue nothing.
  const tiltBrush = classifyCatalogueEntry({
    title: "Tilt Brush",
    steamType: "game",
    genres: ["Free To Play", "Design & Illustration"]
  });
  assert.equal(tiltBrush.excluded, true);
});

test("keeps games that merely carry a software genre alongside a game genre", () => {
  const masterOfRealms = classifyCatalogueEntry({
    title: "Master of Realms",
    steamType: "game",
    genres: ["RPG", "Strategy", "Design & Illustration", "Utilities"]
  });
  assert.equal(masterOfRealms.excluded, false);
  assert.equal(masterOfRealms.reviewRequired, true);

  // 'Casual' is a game genre, not a neutral label, so casual educational games
  // are never hidden by the software rule.
  const educationalGame = classifyCatalogueEntry({
    title: "Air Forte",
    steamType: "game",
    genres: ["Casual", "Education"]
  });
  assert.equal(educationalGame.excluded, false);
});

test("hides builds whose title names a distribution channel", () => {
  const cases: Array<[string, string]> = [
    ["Warhammer 40,000: Dawn of War III Open Beta", "release_channel:beta"],
    ["Conan Exiles - Public Beta Client", "release_channel:public_test"],
    ["Realm Royale - Test Server", "release_channel:test_environment"],
    ["Quake Champions PTS", "release_channel:pts"],
    ["Stormgate Open Beta Playtest", "release_channel:playtest"],
    ["Black Myth: Wukong Benchmark Tool", "release_channel:benchmark"],
    ["Rust - Staging Branch", "release_channel:staging"]
  ];
  for (const [title, matchedRule] of cases) {
    const verdict = classifyCatalogueEntry({ title, steamType: "game", genres: GAME_GENRES });
    assert.equal(verdict.excluded, true, `${title} should be excluded`);
    assert.equal(verdict.matchedRule, matchedRule, `${title} rule`);
  }
});

test("does not read a shipped name as a test build", () => {
  // Every one of these is a released game whose name simply contains 'beta'.
  const shipped = [
    "CUCKOLD SIMULATOR: Life as a Beta Male Cuck",
    "Skullgirls ∞Endless Beta∞",
    "Betrayer",
    "Beta Decay"
  ];
  for (const title of shipped) {
    const verdict = classifyCatalogueEntry({ title, steamType: "game", genres: GAME_GENRES });
    assert.equal(verdict.excluded, false, `${title} must not be excluded`);
  }

  // A trailing bare 'beta' is worth a look, but only a look.
  const ambiguous = classifyCatalogueEntry({
    title: "Serious Sam Fusion 2017 (beta)",
    steamType: "game",
    genres: GAME_GENRES
  });
  assert.equal(ambiguous.excluded, false);
  assert.equal(ambiguous.reviewRequired, true);
});

test("hides content that points at the app it belongs to", () => {
  // The six RACE 07 expansion SKUs are typed 'game' in Steam's PICS record and
  // still cannot launch without RACE 07; the pointer is what gives them away.
  const verdict = classifyCatalogueEntry({
    title: "GTR Evolution Expansion Pack for RACE 07",
    steamType: "game",
    fullGameAppId: 8600,
    genres: ["Racing"]
  });
  assert.equal(verdict.excluded, true);
  assert.equal(verdict.matchedRule, "steam_fullgame_pointer");
});

test("passes an ordinary game through untouched", () => {
  const verdict = classifyCatalogueEntry({
    title: "Hollow Knight",
    steamType: "game",
    genres: ["Action", "Adventure", "Indie"]
  });
  assert.deepEqual(verdict, { excluded: false, reviewRequired: false, matchedRule: null, reason: null });
});

test("hides a free prologue but not a prologue you can buy", () => {
  const freeTaster = classifyCatalogueEntry({
    title: "Stoneshard: Prologue",
    steamType: "game",
    genres: ["RPG", "Indie"],
    isFree: false,
    priceFinal: null
  });
  assert.equal(freeTaster.excluded, true);
  assert.equal(freeTaster.matchedRule, "name:free_prologue");

  for (const product of [
    { title: "KINGDOM HEARTS HD 2.8 Final Chapter Prologue", priceFinal: 5999 },
    { title: "START AGAIN: a prologue", priceFinal: 1099 }
  ]) {
    const verdict = classifyCatalogueEntry({ ...product, steamType: "game", genres: ["RPG"], isFree: false });
    assert.equal(verdict.excluded, false, `${product.title} must stay visible`);
  }
});
