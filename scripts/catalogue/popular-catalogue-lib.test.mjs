import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniqueCohort,
  buildIgdbCohort,
  mergePopularCohorts,
  parseSteamSpyPage,
  resolveIgdbMetricTypes,
  validSteamAppId
} from "./popular-catalogue-lib.mjs";

test("SteamSpy parsing preserves source order instead of numeric-key order", () => {
  const raw = '{"20":{"appid":20,"name":"Second","owners":"20,000 .. 50,000"},"3":{"appid":3,"name":"First","owners":"50,000 .. 100,000"}}';
  assert.deepEqual(parseSteamSpyPage(raw, 0, 2), [
    { steam_appid: 20, name: "Second", rank: 1, owners_low: 20_000, owners_high: 50_000 },
    { steam_appid: 3, name: "First", rank: 2, owners_low: 50_000, owners_high: 100_000 }
  ]);
});

test("SteamSpy parsing skips empty-name rows while preserving their source rank", () => {
  const raw = '{"20":{"appid":20,"name":"","owners":"20,000 .. 50,000"},"3":{"appid":3,"name":"Playable","owners":"10,000 .. 20,000"}}';
  assert.deepEqual(parseSteamSpyPage(raw, 2, 2), [
    { steam_appid: 3, name: "Playable", rank: 6, owners_low: 10_000, owners_high: 20_000 }
  ]);
});

test("IGDB metrics resolve dynamically from Steam popularity types", () => {
  assert.deepEqual(resolveIgdbMetricTypes([
    { id: 5, name: "Steam 24hr Peak Players", external_popularity_source: 1 },
    { id: 8, name: "Steam Total Reviews", external_popularity_source: 1 },
    { id: 9, name: "Steam Global Top Sellers", external_popularity_source: 1 },
    { id: 99, name: "Other Total Reviews", external_popularity_source: 2 }
  ], 1), {
    steam_total_reviews: { id: 8, name: "Steam Total Reviews" },
    steam_24h_peak_players: { id: 5, name: "Steam 24hr Peak Players" },
    steam_global_top_sellers: { id: 9, name: "Steam Global Top Sellers" }
  });
});

test("IGDB fusion deduplicates multiple games and signals by Steam AppID", () => {
  const result = buildIgdbCohort({
    steam_total_reviews: [
      { game_id: 10, rank: 1, value: 100 },
      { game_id: 11, rank: 2, value: 90 }
    ],
    steam_24h_peak_players: [{ game_id: 11, rank: 1, value: 50 }],
    steam_global_top_sellers: [{ game_id: 12, rank: 1, value: 1 }]
  }, [
    { game_id: 10, steam_appid: 1000, name: "Alpha" },
    { game_id: 11, steam_appid: 1000, name: "Alpha" },
    { game_id: 12, steam_appid: 2000, name: "Beta" }
  ], 10);

  assert.equal(result.games.length, 2);
  assert.equal(result.games[0].steam_appid, 1000);
  assert.deepEqual(result.games[0].igdb_game_ids, [10, 11]);
  assert.equal(result.games[0].signals.steam_total_reviews.rank, 1);
  assert.equal(result.games[0].signals.steam_24h_peak_players.rank, 1);
});

test("cross-source merge keeps the SteamSpy name and one row per AppID", () => {
  const result = mergePopularCohorts([
    { steam_appid: 10, name: "Steam Name", rank: 1 }
  ], [
    { steam_appid: 10, name: "IGDB Name", rank: 2, signals: {} },
    { steam_appid: 20, name: "Other", rank: 1, signals: {} }
  ]);
  assert.equal(result.games.length, 2);
  assert.equal(result.games.find((game) => game.steam_appid === 10).name, "Steam Name");
  assert.equal(result.diagnostics.overlap, 1);
  assert.equal(result.diagnostics.name_conflicts.length, 1);
});

test("AppIDs must be positive uint32 integers", () => {
  assert.equal(validSteamAppId(1), 1);
  assert.equal(validSteamAppId(4_294_967_295), 4_294_967_295);
  assert.equal(validSteamAppId(0), null);
  assert.equal(validSteamAppId(4_294_967_296), null);
  assert.equal(validSteamAppId("1.5"), null);
  assert.throws(() => assertUniqueCohort([{ steam_appid: 1, name: "A" }, { steam_appid: 1, name: "B" }], 2, "test"));
});
