import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { completionCandidateValue, findCompletionCandidates } from "./completion-check.ts";

function game(overrides: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "g", title: "Game", ownership: "Owned", status: "In Progress",
    hoursPlayed: 0, completionPercent: 0, genres: [], collectionIds: [],
    sessionFit: [], moodTags: [],
    duration: { mainStoryMinutes: 600 },
    ...overrides
  } as unknown as DemoGame;
}

test("a game played past its campaign is worth asking about", () => {
  const found = findCompletionCandidates([game({ hoursPlayed: 11 })]);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /11h played against a 10h campaign/);
});

test("a game barely started is left alone", () => {
  assert.deepEqual(findCompletionCandidates([game({ hoursPlayed: 2 })]), []);
});

test("an implausible duration estimate is never used to ask", () => {
  // Euro Truck Simulator 2 is stored as a finite one-hour game. Without this the
  // app asks whether you finished it after 24 hours of driving.
  const found = findCompletionCandidates([
    game({ title: "Euro Truck Simulator 2", hoursPlayed: 24, duration: { mainStoryMinutes: 60 } } as Partial<DemoGame>)
  ]);
  assert.deepEqual(found, []);
});

test("endless games are never asked about", () => {
  const found = findCompletionCandidates([
    game({ hoursPlayed: 400, duration: { mainStoryMinutes: 600, endless: true } } as Partial<DemoGame>)
  ]);
  assert.deepEqual(found, []);
});

test("already completed or slept games are not asked about again", () => {
  const found = findCompletionCandidates([
    game({ id: "a", status: "Completed", hoursPlayed: 20 }),
    game({ id: "b", status: "Slept", hoursPlayed: 20 })
  ]);
  assert.deepEqual(found, []);
});

test("dismissing holds until another real session has gone in", () => {
  const dismissed = {
    hoursPlayed: 12,
    completionSuggestionDismissedAt: "2026-08-01T00:00:00.000Z",
    completionSuggestionDismissedPlaytime: 12
  } as Partial<DemoGame>;

  assert.deepEqual(findCompletionCandidates([game(dismissed)]), [], "should stay dismissed");
  // Six more hours is a real session, so it is fair to ask again.
  assert.equal(findCompletionCandidates([game({ ...dismissed, hoursPlayed: 18 })]).length, 1);
});

test("the most certain finishes lead the queue", () => {
  const found = findCompletionCandidates([
    // Four times the campaign: plausibly finished, but also what endless looks like.
    game({ id: "far", title: "Far", hoursPlayed: 45 }),
    game({ id: "close", title: "Close", hoursPlayed: 11 })
  ]);

  assert.deepEqual(found.map((candidate) => candidate.game.id), ["close", "far"]);
  assert.ok(found[0].confidence > found[1].confidence);
});

test("value counts the price of what is waiting, ignoring free games", () => {
  const found = findCompletionCandidates([
    game({ id: "paid", hoursPlayed: 11, priceInitial: 2999 } as Partial<DemoGame>),
    game({ id: "free", hoursPlayed: 11, isFree: true, priceInitial: 0 } as Partial<DemoGame>)
  ]);
  assert.equal(completionCandidateValue(found), 2999);
});
