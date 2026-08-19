import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { completionMilestone } from "./completion-celebration.ts";

const game = (overrides: Partial<DemoGame> = {}) =>
  ({ id: "g", title: "Game", hoursPlayed: 20, ...overrides }) as unknown as DemoGame;

test("finishing something you committed to gets the biggest moment", () => {
  // The whole roll -> pin -> play -> finish loop closing.
  const milestone = completionMilestone(game(), 4, { gameId: "g", pinnedAt: null, hoursAtPin: 8 });
  assert.equal(milestone.spectacle, "big");
  assert.match(milestone.headline, /called it/);
});

test("a pin never actually played does not claim you committed to it", () => {
  const milestone = completionMilestone(game({ hoursPlayed: 8 }), 4, { gameId: "g", pinnedAt: null, hoursAtPin: 8 });
  assert.equal(milestone.spectacle, "standard");
});

test("the first completion and every tenth are milestones", () => {
  assert.equal(completionMilestone(game(), 1, undefined).spectacle, "big");
  assert.equal(completionMilestone(game(), 10, undefined).spectacle, "big");
  assert.equal(completionMilestone(game(), 3, undefined).spectacle, "standard");
});

test("it does not fire the same line every time", () => {
  // A celebration that never varies stops registering by the third game.
  const headlines = new Set([1, 3, 5, 10].map((count) => completionMilestone(game(), count, undefined).headline));
  assert.ok(headlines.size >= 3, `only ${headlines.size} distinct headlines`);
});
