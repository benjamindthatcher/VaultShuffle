import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { mergePinnedPlaytime } from "./pinned-playtime-view.ts";
import { describeRecency, UNKNOWN_RECENCY } from "./recency.ts";

const NOW = new Date("2026-08-31T12:00:00Z");

function game(overrides: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "pinned-game",
    title: "Pinned game",
    steamAppId: 10,
    ownership: "Owned",
    status: "In Progress",
    hoursPlayed: 5,
    completionPercent: 25,
    priority: "High",
    genres: ["Action"],
    description: "The current catalogue description",
    notes: "Keep my notes",
    artworkUrl: "/art.png",
    bannerUrl: "/banner.png",
    lastPlayedAt: null,
    lastPlayedLabel: "",
    recency: UNKNOWN_RECENCY,
    addedLabel: "Added recently",
    collectionIds: ["my-collection"],
    sessionFit: ["evening", "weekend"],
    moodTags: ["intense"],
    duration: { mainStoryMinutes: 1_200 },
    ...overrides,
  };
}

test("pin refresh updates time-derived fields without replacing the player's game", () => {
  const current = game();
  const refreshed = game({
    title: "Stale title",
    notes: "Stale notes",
    collectionIds: [],
    priority: "Medium",
    hoursPlayed: 10,
    completionPercent: 50,
    lastPlayedAt: NOW.toISOString(),
    lastPlayedLabel: "Played today",
    recency: describeRecency({ lastObservedPlayedAt: NOW, recencySource: "steam_exact" }, NOW),
    sessionFit: ["short", "evening", "weekend"],
  });
  const before = structuredClone(current);

  const [merged] = mergePinnedPlaytime([current], [refreshed]);

  assert.equal(merged.hoursPlayed, 10);
  assert.equal(merged.completionPercent, 50);
  assert.equal(merged.lastPlayedAt, NOW.toISOString());
  assert.equal(merged.lastPlayedLabel, "Played today");
  assert.deepEqual(merged.recency, refreshed.recency);
  assert.deepEqual(merged.sessionFit, ["short", "evening", "weekend"]);
  assert.equal(merged.title, current.title);
  assert.equal(merged.notes, current.notes);
  assert.equal(merged.priority, current.priority);
  assert.strictEqual(merged.collectionIds, current.collectionIds);
  assert.deepEqual(current, before, "the previous React state must not be mutated");
});

test("pin refresh leaves unrelated rows alone and never inserts unknown games", () => {
  const current = game();
  const unrelated = game({ id: "not-refreshed" });
  const result = mergePinnedPlaytime([current, unrelated], [
    game({ hoursPlayed: 10, completionPercent: 50 }),
    game({ id: "not-in-this-library", hoursPlayed: 80 }),
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((entry) => entry.id), [current.id, unrelated.id]);
  assert.strictEqual(result[1], unrelated);
});

test("a stale lower-hour refresh cannot regress current progress or recency", () => {
  const current = game({
    hoursPlayed: 12,
    completionPercent: 60,
    lastPlayedAt: NOW.toISOString(),
    lastPlayedLabel: "Played today",
    recency: describeRecency({ lastObservedPlayedAt: NOW, recencySource: "steam_exact" }, NOW),
  });
  const [merged] = mergePinnedPlaytime([current], [game({ hoursPlayed: 5 })]);
  assert.strictEqual(merged, current);
});

test("refresh preserves completion and set-aside decisions", () => {
  const completed = game({
    status: "Completed",
    completionPercent: 100,
    completedAt: NOW.toISOString(),
    previousActiveStatus: "In Progress",
    completionSuggestionDismissedAt: NOW.toISOString(),
    completionSuggestionDismissedPlaytime: 5,
  });
  const slept = game({
    id: "slept",
    status: "Slept",
    sleptAt: NOW.toISOString(),
    previousActiveStatus: "In Progress"
  });
  const [mergedCompleted, mergedSlept] = mergePinnedPlaytime(
    [completed, slept],
    [game({ hoursPlayed: 10, completionPercent: 50 }), game({ id: "slept", hoursPlayed: 10 })]
  );

  assert.equal(mergedCompleted.status, "Completed");
  assert.equal(mergedCompleted.completionPercent, 100);
  assert.equal(mergedCompleted.completedAt, NOW.toISOString());
  assert.equal(mergedCompleted.completionSuggestionDismissedAt, NOW.toISOString());
  assert.equal(mergedCompleted.completionSuggestionDismissedPlaytime, 5);
  assert.equal(mergedSlept.status, "Slept");
  assert.equal(mergedSlept.sleptAt, NOW.toISOString());
  assert.equal(mergedSlept.previousActiveStatus, "In Progress");
});

test("a stale completed response cannot restore 100 percent after the player restores the game", () => {
  const current = game({ status: "In Progress", completedAt: null });
  const staleCompleted = game({
    status: "Completed",
    hoursPlayed: 6,
    completionPercent: 100,
    completedAt: NOW.toISOString(),
    sessionFit: ["short", "evening", "weekend"],
  });
  const [merged] = mergePinnedPlaytime([current], [staleCompleted]);

  assert.equal(merged.status, "In Progress");
  assert.equal(merged.completedAt, null);
  assert.equal(merged.hoursPlayed, 6);
  assert.equal(merged.completionPercent, 30);
  assert.deepEqual(merged.sessionFit, ["evening", "weekend"]);
});

test("without a duration estimate refresh preserves the current manual percentage", () => {
  const current = game({ duration: undefined, completionPercent: 42 });
  const stale = game({ duration: undefined, hoursPlayed: 6, completionPercent: 25 });
  const [merged] = mergePinnedPlaytime([current], [stale]);
  assert.equal(merged.hoursPlayed, 6);
  assert.equal(merged.completionPercent, 42);
});

test("refresh respects the existing non-endless classification", () => {
  const current = game({ title: "Counter-Strike", duration: { endless: false }, completionPercent: 42 });
  const stale = game({ title: "Counter-Strike", duration: { endless: false }, hoursPlayed: 6, completionPercent: 42 });
  const [merged] = mergePinnedPlaytime([current], [stale]);
  assert.equal(merged.hoursPlayed, 6);
  assert.equal(merged.completionPercent, 42);
  assert.strictEqual(merged.duration, current.duration);
});

test("a missing duration classification remains unknown rather than being forced finite", () => {
  const current = game({ title: "Counter-Strike", duration: undefined, completionPercent: 42 });
  const refreshed = game({ title: "Counter-Strike", duration: undefined, hoursPlayed: 6 });
  const [merged] = mergePinnedPlaytime([current], [refreshed]);

  assert.equal(merged.completionPercent, 99, "the existing endless fallback still applies when no classification exists");
  assert.equal(merged.duration, undefined);
});

test("stale or missing history cannot erase newer known activity", () => {
  const current = game({
    lastPlayedAt: NOW.toISOString(),
    lastPlayedLabel: "Played today",
    recency: describeRecency({ lastObservedPlayedAt: NOW, recencySource: "steam_exact" }, NOW),
  });
  const oldDate = "2026-08-10T12:00:00Z";
  const old = game({
    lastPlayedAt: oldDate,
    lastPlayedLabel: "Played 3 weeks ago",
    recency: describeRecency({ lastObservedPlayedAt: oldDate, recencySource: "steam_exact" }, NOW),
  });

  for (const refreshed of [game(), old]) {
    const [merged] = mergePinnedPlaytime([current], [refreshed]);
    assert.equal(merged.lastPlayedAt, NOW.toISOString());
    assert.equal(merged.lastPlayedLabel, "Played today");
    assert.deepEqual(merged.recency, current.recency);
  }
});
