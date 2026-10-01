import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniqueCohort,
  parseSteamSpyPage,
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

test("AppIDs must be positive uint32 integers", () => {
  assert.equal(validSteamAppId(1), 1);
  assert.equal(validSteamAppId(4_294_967_295), 4_294_967_295);
  assert.equal(validSteamAppId(0), null);
  assert.equal(validSteamAppId(4_294_967_296), null);
  assert.equal(validSteamAppId("1.5"), null);
  assert.throws(() => assertUniqueCohort([{ steam_appid: 1, name: "A" }, { steam_appid: 1, name: "B" }], 2, "test"));
});
