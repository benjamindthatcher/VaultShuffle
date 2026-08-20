import assert from "node:assert/strict";
import test from "node:test";
import { steamImportBatch, steamImportPercent } from "./steam-import-progress.ts";

test("Steam import percent reports only committed progress", () => {
  assert.equal(steamImportPercent("importing", 75, 300), 25);
  assert.equal(steamImportPercent("importing", 299, 300), 99);
  assert.equal(steamImportPercent("complete", 300, 300), 100);
  assert.equal(steamImportPercent("fetching", 0, 0), 0);
});

test("Steam imports are split into resumable bounded batches", () => {
  const games = Array.from({ length: 181 }, (_, index) => index + 1);
  assert.deepEqual(steamImportBatch(games, 0), games.slice(0, 75));
  assert.deepEqual(steamImportBatch(games, 75), games.slice(75, 150));
  assert.deepEqual(steamImportBatch(games, 150), games.slice(150));
  assert.deepEqual(steamImportBatch(games, 181), []);
});
