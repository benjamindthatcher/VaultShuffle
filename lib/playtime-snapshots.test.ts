import assert from "node:assert/strict";
import test from "node:test";
import { summarisePlaytime, type PlaytimeSnapshot } from "./playtime-summary.ts";

const today = new Date("2026-08-20T12:00:00.000Z");

/** Newest first, as the query returns them. `gained` is minutes added that day. */
function history(...gained: number[]): PlaytimeSnapshot[] {
  // One more snapshot than gained values: a day's gain is the difference between
  // two snapshots, so N days of play need N+1 recorded totals.
  const snapshots: PlaytimeSnapshot[] = [];
  let total = 10_000;
  for (let index = 0; index <= gained.length; index += 1) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - index);
    snapshots.push({ capturedOn: date.toISOString().slice(0, 10), totalMinutes: total });
    total -= gained[index] ?? 0;
  }
  return snapshots;
}

test("a streak counts consecutive days that actually gained time", () => {
  const summary = summarisePlaytime(history(60, 30, 45, 0, 90), today);
  assert.equal(summary.streakDays, 3);
});

test("a day with no play breaks the streak", () => {
  assert.equal(summarisePlaytime(history(0, 0, 60, 60), today).streakDays, 0);
});

test("a streak survives today not having been captured yet", () => {
  // The worker runs overnight, so the newest complete day is often yesterday.
  // Treating that as a broken streak would reset everyone's every morning.
  const summary = summarisePlaytime(history(0, 45, 30, 20), today);
  assert.equal(summary.streakDays, 3);
});

test("weekly and monthly totals count what was gained, not the running total", () => {
  const summary = summarisePlaytime(history(60, 60, 60, 60, 60, 60, 60, 600), today);
  assert.equal(summary.minutesLast7Days, 420);
  assert.ok(summary.minutesLast30Days > summary.minutesLast7Days);
});

test("a single day of history claims no streak", () => {
  // One snapshot has nothing to be compared against, and a running total on its
  // own says nothing about whether anyone played.
  const summary = summarisePlaytime([{ capturedOn: "2026-08-20", totalMinutes: 5_000 }], today);
  assert.equal(summary.streakDays, 0);
  assert.equal(summary.daysTracked, 1);
});

test("playtime going backwards never becomes negative time", () => {
  // Steam privacy changes and refunds can drop the total.
  const summary = summarisePlaytime([
    { capturedOn: "2026-08-20", totalMinutes: 100 },
    { capturedOn: "2026-08-19", totalMinutes: 900 }
  ], today);
  assert.equal(summary.minutesLast7Days, 0);
  assert.equal(summary.streakDays, 0);
});
