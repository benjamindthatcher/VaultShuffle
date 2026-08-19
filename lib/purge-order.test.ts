import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import { buildPurgeCandidates } from "./purge.ts";

function game(overrides: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "g", title: "Game", ownership: "Owned", status: "Not Started",
    hoursPlayed: 0, completionPercent: 0, genres: [], collectionIds: [],
    sessionFit: [], moodTags: [], lastPlayedAt: null, lastPlayedLabel: "Not played recently",
    ...overrides
  } as unknown as DemoGame;
}

const base = { pinnedIds: [], currentPickId: null, snoozedIds: [] };

test("an easy cut is offered before a beloved game", () => {
  // A queue of 223 in library order gave no sense that the next call would be any
  // easier than the last.
  const candidates = buildPurgeCandidates({
    ...base,
    games: [
      game({ id: "gem", title: "Gem", reviewPositive: 133, reviewTotal: 141 } as Partial<DemoGame>),
      game({ id: "dud", title: "Dud", reviewPositive: 200, reviewTotal: 600 } as Partial<DemoGame>)
    ]
  });

  assert.deepEqual(candidates.map((candidate) => candidate.game.id), ["dud", "gem"]);
});

test("the evidence points the right way", () => {
  const [dud] = buildPurgeCandidates({
    ...base,
    games: [game({ id: "dud", reviewPositive: 200, reviewTotal: 600 } as Partial<DemoGame>)]
  });
  const [gem] = buildPurgeCandidates({
    ...base,
    games: [game({ id: "gem", reviewPositive: 133, reviewTotal: 141 } as Partial<DemoGame>)]
  });

  assert.equal(dud.signal?.leaning, "cut");
  assert.equal(gem.signal?.leaning, "keep");
});

test("a middling game gets no signal, because a middling score helps nobody decide", () => {
  const [only] = buildPurgeCandidates({
    ...base,
    games: [game({ reviewPositive: 780, reviewTotal: 1_000 } as Partial<DemoGame>)]
  });
  assert.equal(only.signal, null);
});

test("games already queued for the completion sweep are not asked about twice", () => {
  const candidates = buildPurgeCandidates({
    ...base,
    games: [game({ id: "a" }), game({ id: "b" })],
    likelyFinishedIds: new Set(["a"])
  });
  assert.deepEqual(candidates.map((candidate) => candidate.game.id), ["b"]);
});

test("never opened is now what untouched means", () => {
  const [fresh] = buildPurgeCandidates({ ...base, games: [game({ id: "a", hoursPlayed: 0 })] });
  assert.equal(fresh.category, "untouched");
  assert.match(fresh.reason, /Never opened/);
});
