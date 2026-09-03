import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { completionMilestone, pinInstrument, pinProgressBar } from "./completion-celebration.ts";

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

test("finishing a game we never had a length for still gets a full bar", () => {
  // HLTB has never timed plenty of games. Reading completionPercent alone meant
  // one of those lost its dial at the moment it had the most to show, which is
  // what "it is at 100% so it shows nothing" looked like from the outside.
  const bar = pinProgressBar(
    game({ status: "Completed", hoursPlayed: 40, completionPercent: 0 }),
    { gameId: "g", pinnedAt: null, hoursAtPin: 10 }
  );

  assert.deepEqual(bar, { percent: 100, atPin: null });
});

test("a finished game reads 100% whatever its stored percentage says", () => {
  const bar = pinProgressBar(
    game({ status: "Completed", hoursPlayed: 12, completionPercent: 30, duration: { mainStoryMinutes: 40 * 60 } }),
    undefined
  );

  assert.equal(bar?.percent, 100);
});

test("an endless pin measures the run instead of losing its dial", () => {
  // No credits to reach, so no honest percentage - but the hours are measured,
  // and so is the share of them that arrived after the pin.
  const instrument = pinInstrument(
    game({ hoursPlayed: 200, completionPercent: 99, duration: { mainStoryMinutes: 40 * 60, endless: true } }),
    { gameId: "g", pinnedAt: null, hoursAtPin: 150 }
  );

  assert.deepEqual(instrument, { kind: "run", percent: 100, atPin: 75 });
});

test("a game nobody has estimated falls back to the run as well", () => {
  const instrument = pinInstrument(game({ hoursPlayed: 10 }), { gameId: "g", pinnedAt: null, hoursAtPin: 4 });

  assert.deepEqual(instrument, { kind: "run", percent: 100, atPin: 40 });
});

test("a run nobody has started is empty rather than dividing by zero", () => {
  const instrument = pinInstrument(
    game({ hoursPlayed: 0, duration: { mainStoryMinutes: 40 * 60, endless: true } }),
    { gameId: "g", pinnedAt: null, hoursAtPin: 0 }
  );

  assert.deepEqual(instrument, { kind: "run", percent: 0, atPin: null });
});

test("a measurable story still wins over the run", () => {
  const instrument = pinInstrument(
    game({ hoursPlayed: 20, completionPercent: 50, duration: { mainStoryMinutes: 40 * 60 } }),
    { gameId: "g", pinnedAt: null, hoursAtPin: 10 }
  );

  assert.deepEqual(instrument, { kind: "story", percent: 50, atPin: 25 });
});

test("a pinned family game gets a dial that measures nothing, not one reading zero", () => {
  // Regression guard for an interaction, not a single function: pinProgressBar
  // correctly refuses a shared game, and pinInstrument used to fall through to
  // the run split - which reads hoursPlayed, also 0 on a family row. The lie
  // moved from one dial to the other rather than going away.
  const shared = { ...game(), accessSource: "family" as const, hoursPlayed: 0, completionPercent: 0 };
  const instrument = pinInstrument(shared, { gameId: shared.id, pinnedAt: null, hoursAtPin: 0 });
  assert.equal(instrument.kind, "shared");
  assert.equal(instrument.atPin, null);
});

test("a shared game marked complete still gets its story dial", () => {
  const done = { ...game(), accessSource: "family" as const, status: "Completed" as const, hoursPlayed: 0 };
  const instrument = pinInstrument(done, { gameId: done.id, pinnedAt: null, hoursAtPin: 0 });
  assert.equal(instrument.kind, "story");
  assert.equal(instrument.percent, 100);
});

test("an owned endless game still gets the run dial", () => {
  const endless = { ...game(), duration: { endless: true }, hoursPlayed: 40 };
  assert.equal(pinInstrument(endless, { gameId: endless.id, pinnedAt: null, hoursAtPin: 10 }).kind, "run");
});
