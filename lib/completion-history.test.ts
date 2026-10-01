import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { completionHistory, completionMetrics } from "./completion-history.ts";
const game = (patch: Partial<DemoGame>) => ({ id: "one", title: "Game", status: "Completed", hoursPlayed: 120, priceInitial: 2999, completedAt: "2026-09-24T12:00:00Z", ...patch } as DemoGame);

test("history keeps every completed game, newest first, with undated completions last", () => {
  const games = [game({ id: "old", completedAt: "2026-08-01T00:00:00Z" }), game({ id: "unknown", completedAt: null }), game({ id: "invalid", completedAt: "bad date" }), game({ id: "active", status: "In Progress" }), game({ id: "new" })];
  const copy = [...games];
  assert.deepEqual(completionHistory(games).map(g => g.id), ["new", "old", "unknown", "invalid"]);
  assert.deepEqual(games, copy);
});

test("per-hour values handle missing playtime, missing prices, free and shared games honestly", () => {
  assert.equal(completionMetrics(game({})).centsPerHour, 25);
  assert.equal(completionMetrics(game({hoursPlayed:0})).centsPerHour, null);
  assert.equal(completionMetrics(game({hoursPlayed:NaN})).centsPerHour, null);
  assert.equal(completionMetrics(game({priceInitial:null})).centsPerHour, null);
  assert.equal(completionMetrics(game({isFree:true})).centsPerHour, 0);
  assert.deepEqual(completionMetrics(game({accessSource:"family"})), {hours:null,cents:null,centsPerHour:null});
});
