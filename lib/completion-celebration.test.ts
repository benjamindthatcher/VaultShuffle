import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { completionMilestone, pinProgressBar } from "./completion-celebration.ts";

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

test("the pin bar splits progress at the moment it was pinned", () => {
  // A 40h game, 10h in when pinned, 20h in now: half done, and half of that
  // half arrived after the promise was made.
  const bar = pinProgressBar(
    game({ hoursPlayed: 20, completionPercent: 50, duration: { mainStoryMinutes: 40 * 60 } }),
    { gameId: "g", pinnedAt: null, hoursAtPin: 10 }
  );

  assert.deepEqual(bar, { percent: 50, atPin: 25 });
});

test("a pin with no recorded playtime still gets a plain bar", () => {
  // Pins made before the playtime was recorded have nothing to split at, and a
  // bar of overall progress is still true.
  const bar = pinProgressBar(
    game({ hoursPlayed: 20, completionPercent: 50, duration: { mainStoryMinutes: 40 * 60 } }),
    { gameId: "g", pinnedAt: null, hoursAtPin: null }
  );

  assert.deepEqual(bar, { percent: 50, atPin: null });
});

test("an endless game gets no bar rather than an invented one", () => {
  const bar = pinProgressBar(
    game({ hoursPlayed: 300, completionPercent: 99, duration: { mainStoryMinutes: 40 * 60, endless: true } }),
    { gameId: "g", pinnedAt: null, hoursAtPin: 10 }
  );

  assert.equal(bar, null);
});

test("the pinned-at share can never exceed what has actually been played", () => {
  // Playtime can be corrected downwards by Steam, which would otherwise draw a
  // "since pinning" segment of negative width.
  const bar = pinProgressBar(
    game({ hoursPlayed: 5, completionPercent: 12, duration: { mainStoryMinutes: 40 * 60 } }),
    { gameId: "g", pinnedAt: null, hoursAtPin: 30 }
  );

  assert.ok(bar);
  assert.ok(bar.atPin !== null && bar.atPin <= bar.percent, "the split cannot sit past the fill");
});
