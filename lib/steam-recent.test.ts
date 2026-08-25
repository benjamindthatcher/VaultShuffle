import assert from "node:assert/strict";
import test from "node:test";
import { recentlyPlayedAppIdsFromPayload } from "./steam-recent.ts";

test("recently played appids are read from Steam's shape", () => {
  const payload = {
    response: {
      total_count: 2,
      games: [
        { appid: 1091500, name: "Cyberpunk 2077", playtime_2weeks: 300 },
        { appid: 275850, name: "No Man's Sky", playtime_2weeks: 45 }
      ]
    }
  };
  assert.deepEqual(recentlyPlayedAppIdsFromPayload(payload).toSorted((a, b) => a - b), [275850, 1091500]);
});

test("entries with no time in the window are not evidence", () => {
  const payload = { response: { games: [{ appid: 4000, playtime_2weeks: 0 }] } };
  assert.deepEqual(recentlyPlayedAppIdsFromPayload(payload), []);
});

test("an empty or private response yields nothing rather than failing", () => {
  assert.deepEqual(recentlyPlayedAppIdsFromPayload({ response: {} }), []);
  assert.deepEqual(recentlyPlayedAppIdsFromPayload({}), []);
  assert.deepEqual(recentlyPlayedAppIdsFromPayload(null), []);
  assert.deepEqual(recentlyPlayedAppIdsFromPayload("nonsense"), []);
});

test("malformed rows are skipped without taking the batch with them", () => {
  const payload = {
    response: { games: [null, { appid: "x", playtime_2weeks: 10 }, { appid: 70, playtime_2weeks: 12 }] }
  };
  assert.deepEqual(recentlyPlayedAppIdsFromPayload(payload), [70]);
});
