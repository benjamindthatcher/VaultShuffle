import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { describeRecency, UNKNOWN_RECENCY } from "./recency.ts";
import { featureAvailable, steamCapabilities, NO_STEAM_CAPABILITIES } from "./steam-capabilities.ts";

const played = (hours: number, known: boolean): DemoGame => ({
  ownership: "Owned",
  hoursPlayed: hours,
  recency: known
    ? describeRecency({ lastObservedPlayedAt: new Date().toISOString(), recencySource: "observed_playtime_change" })
    : UNKNOWN_RECENCY
} as unknown as DemoGame);

test("a guest has no personal capabilities at all", () => {
  assert.deepEqual(
    steamCapabilities({ isLive: false, games: [played(10, true)], playtimeVisible: true, daysTracked: 30 }),
    NO_STEAM_CAPABILITIES
  );
});

test("a library with private playtime cannot talk about progress", () => {
  const caps = steamCapabilities({
    isLive: true, games: [played(0, false), played(0, false)], playtimeVisible: false, daysTracked: 0
  });
  assert.equal(caps.canUsePersonalLibrary, true);
  assert.equal(caps.canUseProgress, false);
  assert.equal(featureAvailable("finishSomething", caps), false);
  assert.equal(featureAvailable("quickDraw", caps), true);
});

test("a brand new account is treated like a private one, because nothing differs", () => {
  const caps = steamCapabilities({
    isLive: true, games: [played(0, false)], playtimeVisible: true, daysTracked: 0
  });
  assert.equal(caps.canUseProgress, false);
});

test("recency needs more than one game's worth of evidence", () => {
  const games = [played(5, true), played(5, false), played(5, false), played(5, false)];
  assert.equal(steamCapabilities({ isLive: true, games, playtimeVisible: true, daysTracked: 0 }).canUseRecency, false);

  const better = [played(5, true), played(5, true), played(5, true), played(5, false)];
  assert.equal(steamCapabilities({ isLive: true, games: better, playtimeVisible: true, daysTracked: 0 }).canUseRecency, true);
});

test("a tiny library is not held to the same evidence floor", () => {
  // One game with evidence out of one game is all the evidence there can be.
  const caps = steamCapabilities({ isLive: true, games: [played(5, true)], playtimeVisible: true, daysTracked: 0 });
  assert.equal(caps.canUseRecency, true);
});

test("streaks and recaps wait for a second observation", () => {
  const one = steamCapabilities({ isLive: true, games: [played(5, true)], playtimeVisible: true, daysTracked: 1 });
  assert.equal(featureAvailable("playStreak", one), false);

  const two = steamCapabilities({ isLive: true, games: [played(5, true)], playtimeVisible: true, daysTracked: 2 });
  assert.equal(featureAvailable("playStreak", two), true);
});

test("the recency shelves and Purge dormancy share one requirement", () => {
  const caps = steamCapabilities({
    isLive: true, games: [played(5, false), played(5, false), played(5, false)], playtimeVisible: true, daysTracked: 9
  });
  assert.equal(featureAvailable("recentlyPlayedShelf", caps), false);
  assert.equal(featureAvailable("fallenOffShelf", caps), false);
  assert.equal(featureAvailable("purgeDormancy", caps), false);
});
