import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { playingNextProgress } from "./playing-next-progress.ts";

const pin = { gameId: "a", hoursAtPin: 10, pinnedAt: "2026-09-19T00:00:00Z" };
const game = { id: "a", steamAppId: 620, hoursPlayed: 10.5 } as DemoGame;

test("meaningful play measures thirty minutes after choosing, not lifetime hours", () => {
  assert.equal(playingNextProgress({ ...game, hoursPlayed: 10.4 }, pin), null);
  assert.equal(playingNextProgress(game, pin)?.hours_since_choosing, 0.5);
  assert.equal(playingNextProgress({ ...game, hoursPlayed: 9 }, pin), null);
});

test("missing baselines and family-owner playtime never count as meaningful play", () => {
  assert.equal(playingNextProgress(game, { ...pin, hoursAtPin: null }), null);
  assert.equal(playingNextProgress(game, { ...pin, pinnedAt: null }), null);
  assert.equal(playingNextProgress({ ...game, accessSource: "family" }, pin), null);
});
