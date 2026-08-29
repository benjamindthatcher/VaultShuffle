import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { buildPurgeCandidates, isReviewSuperseded, type PurgeReview } from "./purge.ts";
import { describeRecency, UNKNOWN_RECENCY } from "./recency.ts";

const now = new Date("2026-08-13T14:30:00.000Z");

/** Evidence that a game genuinely has gone untouched, which is what most of
 *  these tests mean when they queue one for review. */
function playedLongAgo(days: number) {
  return describeRecency(
    {
      lastObservedPlayedAt: new Date(now.getTime() - days * 86400000).toISOString(),
      recencySource: "observed_playtime_change"
    },
    now
  );
}

function game(id: string, recency = playedLongAgo(700)): DemoGame {
  return {
    id,
    title: id,
    steamAppId: 1,
    ownership: "Owned",
    status: "In Progress",
    hoursPlayed: 1,
    completionPercent: 99,
    priority: "Medium",
    genres: ["Action"],
    recency,
    description: "",
    artworkUrl: "",
    bannerUrl: "",
    lastPlayedLabel: "Not played recently",
    addedLabel: "",
    collectionIds: [],
    sessionFit: ["short"],
    moodTags: ["chill"]
  };
}

function review(gameId: string, action: PurgeReview["action"], reviewedAt: string): PurgeReview {
  return { id: `${gameId}-${action}`, gameId, action, reviewedAt };
}

test("a just-committed non-keep decision leaves a stale Purge queue immediately", () => {
  const candidates = buildPurgeCandidates({
    games: [game("once-human"), game("rust")],
    pinnedIds: [],
    currentPickId: null,
    snoozedIds: [],
    reviews: [review("once-human", "sleep", "2026-08-13T14:29:00.000Z")],
    now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["rust"]);
});

test("the short stale-data guard expires without replacing normal status checks", () => {
  const candidates = buildPurgeCandidates({
    games: [game("once-human")],
    pinnedIds: [],
    currentPickId: null,
    snoozedIds: [],
    reviews: [review("once-human", "sleep", "2026-08-13T14:20:00.000Z")],
    now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["once-human"]);
});

test("a decision still reflected by the game is standing", () => {
  assert.equal(isReviewSuperseded("sleep", "Slept"), false);
  assert.equal(isReviewSuperseded("complete", "Completed"), false);
  assert.equal(isReviewSuperseded("keep", "In Progress"), false);
  assert.equal(isReviewSuperseded("pin", "Not Started"), false);
});

test("a decision reversed elsewhere is superseded", () => {
  // The reported case: slept in Purge, later woken from the Library, so the
  // page was still claiming "Put to sleep" next to an Active badge.
  assert.equal(isReviewSuperseded("sleep", "In Progress"), true);
  assert.equal(isReviewSuperseded("sleep", "Not Started"), true);
  assert.equal(isReviewSuperseded("complete", "In Progress"), true);
  assert.equal(isReviewSuperseded("keep", "Slept"), true);
  assert.equal(isReviewSuperseded("pin", "Completed"), true);
});

test("a played game with no recency evidence is not queued as abandoned", () => {
  // The bug: a missing last-played date scored as infinitely old, so every game
  // Steam declined to date went to the top of the review queue described as
  // "untouched for 9 years". Steam withholds that date from most accounts.
  const candidates = buildPurgeCandidates({
    games: [game("undecember", UNKNOWN_RECENCY)],
    pinnedIds: [],
    currentPickId: null,
    snoozedIds: [],
    reviews: [],
    now
  });

  assert.deepEqual(candidates, []);
});

test("a never-opened game still qualifies without any recency evidence", () => {
  // Nought hours is nought hours. That is a fact about playtime, not recency.
  const neverOpened = { ...game("fresh", UNKNOWN_RECENCY), hoursPlayed: 0, status: "Not Started" as const };
  const candidates = buildPurgeCandidates({
    games: [neverOpened],
    pinnedIds: [],
    currentPickId: null,
    snoozedIds: [],
    reviews: [],
    now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["fresh"]);
  assert.match(candidates[0].reason, /^Never opened\./);
});

test("unknown recency does not make Purge surer about letting a game go", () => {
  const withEvidence = buildPurgeCandidates({
    games: [{ ...game("known", playedLongAgo(800)), hoursPlayed: 0 }],
    pinnedIds: [], currentPickId: null, snoozedIds: [], reviews: [], now
  });
  const withoutEvidence = buildPurgeCandidates({
    games: [{ ...game("unknown", UNKNOWN_RECENCY), hoursPlayed: 0 }],
    pinnedIds: [], currentPickId: null, snoozedIds: [], reviews: [], now
  });

  assert.ok(withEvidence[0].confidence > withoutEvidence[0].confidence);
});

test("a game we have watched go quiet is still reviewable, and says so precisely", () => {
  const candidates = buildPurgeCandidates({
    games: [game("dormant", playedLongAgo(400))],
    pinnedIds: [], currentPickId: null, snoozedIds: [], reviews: [], now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["dormant"]);
  assert.match(candidates[0].reason, /untouched for/);
  assert.doesNotMatch(candidates[0].reason, /about/);
});

test("a game flagged by hand joins the queue even with no evidence against it", () => {
  const flagged = { ...game("flagged", UNKNOWN_RECENCY), hoursPlayed: 12, reviewRequested: true };
  const candidates = buildPurgeCandidates({
    games: [flagged], pinnedIds: [], currentPickId: null, snoozedIds: [], reviews: [], now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["flagged"]);
  assert.match(candidates[0].reason, /You flagged this one for review/);
});

test("a keep holds for a season, then the game comes round again", () => {
  const kept = game("kept");

  const stillHeld = buildPurgeCandidates({
    games: [kept], pinnedIds: [], currentPickId: null, snoozedIds: [],
    // 60 days before "now".
    reviews: [review("kept", "keep", "2026-06-14T14:00:00.000Z")],
    now
  });
  assert.deepEqual(stillHeld, [], "a decision two months old should still stand");

  const backAround = buildPurgeCandidates({
    games: [kept], pinnedIds: [], currentPickId: null, snoozedIds: [],
    // 120 days before "now".
    reviews: [review("kept", "keep", "2026-04-15T14:00:00.000Z")],
    now
  });
  assert.deepEqual(backAround.map(({ game }) => game.id), ["kept"], "four months on it is worth asking again");
});

test("a game waiting on a completion answer is still an active game", () => {
  // Games the completion sweep was about to ask about used to be held out of
  // this queue so the two could not ask about the same game. But "did you finish
  // this" and "should this stay in the draw pool" are different questions with
  // different answers, and a long-idle game past its campaign is a fair subject
  // for both.
  const pastItsCampaign = {
    ...game("finished-looking"),
    hoursPlayed: 40,
    duration: { mainStoryMinutes: 30 * 60 }
  } as DemoGame;

  const candidates = buildPurgeCandidates({
    games: [pastItsCampaign], pinnedIds: [], currentPickId: null, snoozedIds: [], reviews: [], now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["finished-looking"]);
});

test("flagging overrides the keep cooldown, which is the only reason to flag", () => {
  // This used to assert the opposite, and the opposite made the button useless:
  // a keep suppresses a game for 90 days, and the games offered for flagging
  // are exactly the ones that have been kept. Flagging them did nothing.
  //
  // The cooldown is a rule about the queue's own judgement - do not nag about
  // something just decided. A flag is the player overruling that by hand.
  const flagged = { ...game("flagged", UNKNOWN_RECENCY), hoursPlayed: 12, reviewRequested: true };
  const candidates = buildPurgeCandidates({
    games: [flagged],
    pinnedIds: [], currentPickId: null, snoozedIds: [],
    reviews: [review("flagged", "keep", "2026-08-13T14:00:00.000Z")],
    now
  });

  assert.deepEqual(candidates.map(({ game }) => game.id), ["flagged"]);
});

test("flagging does not override a live commitment", () => {
  // A pin, a snooze or the current pick are things you are actively doing, not
  // judgements the queue is suppressing, so a flag does not pull them back in.
  const flagged = { ...game("flagged", UNKNOWN_RECENCY), hoursPlayed: 12, reviewRequested: true };

  assert.deepEqual(buildPurgeCandidates({
    games: [flagged], pinnedIds: ["flagged"], currentPickId: null, snoozedIds: [], reviews: [], now
  }), []);
  assert.deepEqual(buildPurgeCandidates({
    games: [flagged], pinnedIds: [], currentPickId: null, snoozedIds: ["flagged"], reviews: [], now
  }), []);
});
