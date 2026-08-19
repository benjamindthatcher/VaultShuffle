import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { buildBacklogStats, formatMoney, formatValueRate } from "./backlog-stats.ts";

function game(overrides: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "g", title: "Game", ownership: "Owned", status: "Not Started",
    hoursPlayed: 0, completionPercent: 0, genres: [], collectionIds: [],
    sessionFit: [], moodTags: [],
    ...overrides
  } as unknown as DemoGame;
}

test("value completed tracks money, not just game count", () => {
  const stats = buildBacklogStats([
    game({ id: "a", status: "Completed", priceInitial: 4000, completedAt: "2026-01-01" }),
    game({ id: "b", priceInitial: 1000 })
  ]);

  assert.equal(stats.libraryValueCents, 5000);
  assert.equal(stats.completedValueCents, 4000);
  assert.equal(stats.valueCompletedPercent, 80, "finishing the expensive one is worth more than half");
  assert.equal(stats.completedPercent, 50);
});

test("free games count as owned but add no value", () => {
  const stats = buildBacklogStats([
    game({ id: "a", isFree: true, priceInitial: 0 }),
    game({ id: "b", priceInitial: 2000 })
  ]);
  assert.equal(stats.libraryValueCents, 2000);
  assert.equal(stats.totalGames, 2);
  assert.equal(stats.pricedGames, 1, "coverage must be reported so the UI can be honest");
});

test("best value needs both a real price and real hours", () => {
  const stats = buildBacklogStats([
    // A bargain, but free — an hour in a free game is not value gained.
    game({ id: "free", isFree: true, hoursPlayed: 500 }),
    // Barely touched: not a scandal worth headlining.
    game({ id: "brief", priceInitial: 6000, hoursPlayed: 0.2 }),
    game({ id: "real", title: "Palworld", priceInitial: 3000, hoursPlayed: 300 })
  ]);

  assert.equal(stats.bestValue?.title, "Palworld");
  assert.match(formatValueRate(stats.bestValue!, "USD"), /an hour/);
});

test("never-opened value is counted separately from the whole library", () => {
  const stats = buildBacklogStats([
    game({ id: "a", priceInitial: 3000, hoursPlayed: 0 }),
    game({ id: "b", priceInitial: 2000, hoursPlayed: 12 })
  ]);
  assert.equal(stats.unplayedGames, 1);
  assert.equal(stats.unplayedValueCents, 3000);
});

test("latest completion is the most recent one, not the last in the list", () => {
  const stats = buildBacklogStats([
    game({ id: "a", title: "Older", status: "Completed", completedAt: "2026-01-01" }),
    game({ id: "b", title: "Newer", status: "Completed", completedAt: "2026-08-12" }),
    game({ id: "c", title: "Middle", status: "Completed", completedAt: "2026-04-01" })
  ]);
  assert.equal(stats.latestCompletion?.title, "Newer");
});

test("an empty library does not divide by zero", () => {
  const stats = buildBacklogStats([]);
  assert.equal(stats.completedPercent, 0);
  assert.equal(stats.valueCompletedPercent, 0);
  assert.equal(stats.bestValue, null);
});

test("USD is formatted without the graceless US$ prefix", () => {
  assert.equal(formatMoney(211_300, "USD"), "$2,113");
});
