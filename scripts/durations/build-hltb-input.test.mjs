import assert from "node:assert/strict";
import test from "node:test";
import { buildHltbInput } from "./build-hltb-input.mjs";

test("Steam catalogue input needs no other duration provider and keeps previously matched games", () => {
  const games = [
    { steam_appid: 20, name: "  Another   Game  ", status: "matched" },
    { steam_appid: 10, name: "First" },
    { steam_appid: 20, name: "Another Game" },
    { steam_appid: 0, name: "Invalid" },
    { steam_appid: 4_294_967_296, name: "Out of range" },
    { steam_appid: 30, name: " " },
    null,
  ];
  const expected = [{ steam_appid: 10, name: "First" }, { steam_appid: 20, name: "Another Game" }];
  assert.deepEqual(buildHltbInput(games), expected);
  assert.deepEqual(buildHltbInput({ games }), expected);
});

test("provider reports cannot silently masquerade as a Steam catalogue", () => {
  assert.throws(() => buildHltbInput({ results: [] }), /Steam catalogue/);
  assert.throws(() => buildHltbInput(null), /Steam catalogue/);
});
