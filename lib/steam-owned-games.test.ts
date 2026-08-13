import assert from "node:assert/strict";
import test from "node:test";
import {
  SteamLibraryUnavailableError,
  steamOwnedGamesFromPayload
} from "./steam-owned-games.ts";

test("converts immediately available Steam library data into base game records", () => {
  const games = steamOwnedGamesFromPayload({
    response: {
      game_count: 1,
      games: [{ appid: 3321460, name: "Crimson Desert", playtime_forever: 150, rtime_last_played: 1_700_000_000 }]
    }
  }, "13/08/2026");

  assert.equal(games.length, 1);
  assert.equal(games[0]?.title, "Crimson Desert");
  assert.equal(games[0]?.steam_appid, "3321460");
  assert.equal(games[0]?.hours_played, 2.5);
  assert.equal(games[0]?.status, "In Progress");
  assert.equal(games[0]?.genre, "Unknown");
});

test("reports an unavailable library instead of silently accepting an empty Steam response", () => {
  assert.throws(
    () => steamOwnedGamesFromPayload({ response: {} }),
    SteamLibraryUnavailableError
  );
  assert.throws(
    () => steamOwnedGamesFromPayload({ response: { game_count: 0, games: [] } }),
    SteamLibraryUnavailableError
  );
});
