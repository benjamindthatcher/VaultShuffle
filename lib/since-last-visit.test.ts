import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import type { PlaytimeSummary } from "./playtime-summary.ts";
import { buildVisitRecap, recapSentence } from "./since-last-visit.ts";

const now = new Date("2026-08-20T12:00:00.000Z");

const playtime = (gains: Array<[string, number]>): PlaytimeSummary => ({
  streakDays: 0, minutesLast7Days: 0, minutesLast30Days: 0, daysTracked: gains.length,
  dailyGains: gains.map(([day, minutes]) => ({ day, minutes }))
});

const finished = (id: string, completedAt: string) =>
  ({ id, title: id, status: "Completed", completedAt }) as unknown as DemoGame;

test("counts only what happened after the last visit", () => {
  const recap = buildVisitRecap({
    games: [finished("a", "2026-08-19T10:00:00Z"), finished("old", "2026-08-01T10:00:00Z")],
    playtime: playtime([["2026-08-20", 90], ["2026-08-19", 60], ["2026-08-15", 500]]),
    lastVisitISO: "2026-08-18T20:00:00Z",
    now
  });

  assert.ok(recap);
  assert.equal(recap.minutesPlayed, 150, "the 15th predates the visit and must not be counted");
  assert.deepEqual(recap.gamesFinished.map((game) => game.id), ["a"]);
});

test("returning the same day has nothing to report", () => {
  const recap = buildVisitRecap({
    games: [], playtime: playtime([["2026-08-20", 300]]),
    lastVisitISO: "2026-08-20T09:00:00Z", now
  });
  assert.equal(recap, null, "they have already seen whatever there was to see");
});

test("a long absence falls back to a week rather than claiming months", () => {
  const recap = buildVisitRecap({
    games: [], playtime: playtime([["2026-08-19", 120], ["2026-05-01", 9_000]]),
    lastVisitISO: "2026-04-01T09:00:00Z", now
  });

  assert.ok(recap);
  assert.equal(recap.windowed, true);
  assert.equal(recap.minutesPlayed, 120, "May's play is outside the fallback week");
});

test("a first visit with no history says nothing", () => {
  assert.equal(buildVisitRecap({ games: [], playtime: playtime([]), lastVisitISO: null, now }), null);
});

test("a trivial amount of play is not worth interrupting for", () => {
  const recap = buildVisitRecap({
    games: [], playtime: playtime([["2026-08-19", 4]]),
    lastVisitISO: "2026-08-18T09:00:00Z", now
  });
  assert.equal(recap, null);
});

test("a completion alone is worth reporting even with no playtime recorded", () => {
  const recap = buildVisitRecap({
    games: [finished("a", "2026-08-19T10:00:00Z")],
    playtime: playtime([]), lastVisitISO: "2026-08-18T09:00:00Z", now
  });
  assert.ok(recap);
  assert.equal(recapSentence(recap), "1 game finished");
});

test("the sentence reads naturally at both scales", () => {
  const short = buildVisitRecap({ games: [], playtime: playtime([["2026-08-19", 45]]), lastVisitISO: "2026-08-18T09:00:00Z", now });
  const long = buildVisitRecap({ games: [], playtime: playtime([["2026-08-19", 480]]), lastVisitISO: "2026-08-18T09:00:00Z", now });
  assert.equal(recapSentence(short!), "45 minutes played");
  assert.equal(recapSentence(long!), "8h played");
});
