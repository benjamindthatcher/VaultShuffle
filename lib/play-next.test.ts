import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame } from "./demo-data.ts";
import {
  buildPlayNext,
  editionKey,
  keepSlots,
  playNextAffinity,
  playNextTagProfile,
  seriesKey,
  tagKey
} from "./play-next.ts";
import { describeRecency, UNKNOWN_RECENCY } from "./recency.ts";

const NOW = Date.parse("2026-09-18T12:00:00Z");
const DAY = 86_400_000;

const METROIDVANIA = { Metroidvania: 1000, "Souls-like": 800, Platformer: 700, "2D": 600, Exploration: 500, Difficult: 400 };
const ROGUELITE = { "Action Roguelike": 1000, "Rogue-lite": 900, "Hack and Slash": 700, Isometric: 500, Mythology: 400 };
const FARMING = { "Farming Sim": 1000, "Life Sim": 900, Relaxing: 800, Agriculture: 700, "Pixel Graphics": 600 };
const SHOOTER = { FPS: 1000, Shooter: 900, "Fast-Paced": 800, Demons: 600, Gore: 500 };
const FILLER = { Casual: 1000, Puzzle: 700, "Hidden Object": 600 };

let nextId = 0;

function makeGame(overrides: Partial<DemoGame> & { tags?: Record<string, number> } = {}): DemoGame {
  nextId += 1;
  const { tags, ...rest } = overrides;
  return {
    id: `game-${nextId}`,
    title: `Game ${nextId}`,
    recency: UNKNOWN_RECENCY,
    steamAppId: nextId,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    genres: ["Action"],
    description: "",
    artworkUrl: "",
    bannerUrl: "",
    lastPlayedLabel: "",
    addedLabel: "",
    collectionIds: [],
    sessionFit: ["short", "evening", "weekend"],
    moodTags: [],
    tagProfile: playNextTagProfile(tags ?? FILLER),
    playerMode: "single",
    ...rest
  };
}

/** A library with enough ordinary games that rarity means something. */
function shelf(...games: DemoGame[]) {
  const filler = Array.from({ length: 30 }, (_, index) => makeGame({ title: `Filler ${index}`, tags: FILLER }));
  return [...games, ...filler];
}

function playedRecently(days: number) {
  return describeRecency({ lastObservedPlayedAt: new Date(NOW - days * DAY).toISOString(), recencySource: "steam_exact" }, new Date(NOW));
}

test("a finished game puts forward the unplayed game most like it, and says why", () => {
  const hollow = makeGame({ title: "Hollow Knight", status: "Completed", hoursPlayed: 40, completedAt: new Date(NOW - 10 * DAY).toISOString(), tags: METROIDVANIA });
  const ori = makeGame({ title: "Ori", tags: { Metroidvania: 1000, Platformer: 900, "2D": 700, Exploration: 600, Cute: 300 } });
  const farm = makeGame({ title: "Farm Game", tags: FARMING });
  const result = buildPlayNext({ games: shelf(hollow, ori, farm), now: NOW });

  const pick = result.lanes.because.find((entry) => entry.game.id === ori.id);
  assert.ok(pick, "Ori should be suggested because of Hollow Knight");
  assert.equal(pick.seed?.id, hollow.id);
  assert.equal(pick.headline, "Because you just finished Hollow Knight");
  assert.ok(pick.tags.includes("Metroidvania"));
  assert.ok(!result.lanes.because.some((entry) => entry.game.id === farm.id), "nothing like Hollow Knight should not borrow its name");
  assert.equal(result.top[0].game.id, ori.id);
});

test("games the player has finished, set aside, snoozed or pinned are never suggested", () => {
  const seed = makeGame({ status: "Completed", hoursPlayed: 30, tags: METROIDVANIA });
  const slept = makeGame({ status: "Slept", tags: METROIDVANIA });
  const snoozed = makeGame({ tags: METROIDVANIA });
  const pinned = makeGame({ tags: METROIDVANIA });
  const open = makeGame({ tags: METROIDVANIA });
  const result = buildPlayNext({
    games: shelf(seed, slept, snoozed, pinned, open),
    pinnedIds: [pinned.id],
    snoozedIds: [snoozed.id],
    now: NOW
  });
  const suggested = new Set(Object.values(result.lanes).flat().map((pick) => pick.game.id));
  for (const excluded of [seed, slept, snoozed, pinned]) assert.ok(!suggested.has(excluded.id), `${excluded.status} game leaked`);
  assert.ok(suggested.has(open.id));
});

test("setting a game aside steers suggestions away from games like it", () => {
  const liked = [
    makeGame({ status: "Completed", hoursPlayed: 30, tags: { ...ROGUELITE, ...SHOOTER } }),
    makeGame({ hoursPlayed: 25, tags: { ...ROGUELITE, ...SHOOTER } }),
    makeGame({ hoursPlayed: 25, tags: { ...ROGUELITE, ...SHOOTER } })
  ];
  const roguelite = makeGame({ title: "Roguelite", tags: ROGUELITE });
  const shooter = makeGame({ title: "Shooter", tags: SHOOTER });

  const before = buildPlayNext({ games: shelf(...liked, roguelite, shooter), now: NOW });
  const beforeShooter = before.lanes.because.find((pick) => pick.game.id === shooter.id)?.score ?? -Infinity;

  const bounced = makeGame({ status: "Slept", hoursPlayed: 0.2, tags: SHOOTER });
  const after = buildPlayNext({ games: shelf(...liked, roguelite, shooter, bounced), now: NOW });
  const afterShooter = after.lanes.because.find((pick) => pick.game.id === shooter.id)?.score ?? -Infinity;

  assert.ok(afterShooter < beforeShooter, "a shooter set aside unplayed should cost other shooters");
  assert.equal(after.taste.setAside, 1);
  // Shooters are still what this player loves most, so the profile must not
  // also claim they avoid them - one bounce does not outvote three favourites.
  assert.ok(!after.taste.avoids.some((tag) => after.taste.likes.includes(tag)));

  const farmBounce = makeGame({ status: "Slept", hoursPlayed: 0, tags: FARMING });
  const withFarm = buildPlayNext({ games: shelf(...liked, roguelite, shooter, farmBounce), now: NOW });
  assert.ok(withFarm.taste.avoids.includes("Farming Sim"));
});

test("a game slept after many hours is treated as finished with, not disliked", () => {
  const pinned = new Set<string>();
  assert.equal(playNextAffinity(makeGame({ status: "Slept", hoursPlayed: 0.5 }), pinned, NOW).value, -1);
  assert.equal(playNextAffinity(makeGame({ status: "Slept", hoursPlayed: 5 }), pinned, NOW).value, -0.5);
  assert.equal(playNextAffinity(makeGame({ status: "Slept", hoursPlayed: 40 }), pinned, NOW).value, 0);
});

test("playtime endorses gradually, finishing endorses most, and recent play counts for more", () => {
  const pinned = new Set<string>();
  const two = playNextAffinity(makeGame({ hoursPlayed: 2 }), pinned, NOW).value;
  const ten = playNextAffinity(makeGame({ hoursPlayed: 10 }), pinned, NOW).value;
  const hundred = playNextAffinity(makeGame({ hoursPlayed: 100 }), pinned, NOW).value;
  const thousand = playNextAffinity(makeGame({ hoursPlayed: 1000 }), pinned, NOW).value;
  const finished = playNextAffinity(makeGame({ status: "Completed", hoursPlayed: 8 }), pinned, NOW).value;
  const recent = playNextAffinity(makeGame({ hoursPlayed: 10, recency: playedRecently(3) }), pinned, NOW);

  assert.ok(two > 0 && two < ten && ten < hundred);
  assert.equal(hundred, thousand, "a thousand hours should not outvote everything else");
  assert.ok(finished > hundred);
  assert.equal(recent.kind, "playing");
  assert.ok(recent.value > ten);
  assert.equal(playNextAffinity(makeGame({ hoursPlayed: 1 }), pinned, NOW).value, 0);
});

test("another release of a game already played is not new", () => {
  const remaster = makeGame({ title: "BioShock™ Remastered", hoursPlayed: 20, tags: SHOOTER });
  const original = makeGame({ title: "BioShock", tags: SHOOTER });
  const result = buildPlayNext({ games: shelf(remaster, original), now: NOW });
  assert.ok(!Object.values(result.lanes).flat().some((pick) => pick.game.id === original.id));
});

test("software is never a suggestion", () => {
  const seed = makeGame({ status: "Completed", hoursPlayed: 10, tags: { Utilities: 1000, Software: 900, "Design & Illustration": 800 } });
  const app = makeGame({ title: "Wallpaper App", tags: { Utilities: 1000, Software: 900, "Design & Illustration": 800 } });
  const listed = makeGame({ title: "Listed As Software", genres: ["Software"], tags: FILLER });
  const result = buildPlayNext({ games: shelf(seed, app, listed), now: NOW });
  const suggested = Object.values(result.lanes).flat().map((pick) => pick.game.id);
  assert.ok(!suggested.includes(app.id));
  assert.ok(!suggested.includes(listed.id));
});

test("nearly there stops where the completion sweep takes over, unless the player said not yet", () => {
  const duration = { mainStoryMinutes: 20 * 60 };
  const halfway = makeGame({ title: "Halfway", status: "In Progress", hoursPlayed: 12, completionPercent: 60, duration });
  const past = makeGame({ title: "Past", status: "In Progress", hoursPlayed: 18, completionPercent: 90, duration });
  const notYet = makeGame({ title: "Not Yet", status: "In Progress", hoursPlayed: 18, completionPercent: 90, duration, completionSuggestionDismissedAt: new Date(NOW - DAY).toISOString() });
  const endless = makeGame({ title: "Endless", status: "In Progress", hoursPlayed: 12, completionPercent: 60, duration: { ...duration, endless: true } });

  const finish = buildPlayNext({ games: shelf(halfway, past, notYet, endless), now: NOW }).lanes.finish.map((pick) => pick.game.id);
  assert.ok(finish.includes(halfway.id));
  assert.ok(!finish.includes(past.id), "past three quarters it is a completion question");
  assert.ok(finish.includes(notYet.id), "after 'not yet' it is genuinely nearly finished");
  assert.ok(!finish.includes(endless.id));
});

test("a competitive game's listed length does not make it a quick win", () => {
  const duration = { mainStoryMinutes: 120 };
  const story = makeGame({ title: "Short Story", duration, reviewPositive: 900, reviewTotal: 1000 });
  const deathmatch = makeGame({ title: "Deathmatch", duration, playerMode: "multi", reviewPositive: 900, reviewTotal: 1000 });
  const quick = buildPlayNext({ games: shelf(story, deathmatch), now: NOW }).lanes.quick.map((pick) => pick.game.id);
  assert.ok(quick.includes(story.id));
  assert.ok(!quick.includes(deathmatch.id));
});

test("the dashboard handful spreads across lanes and never repeats a game or a series", () => {
  const seeds = [
    makeGame({ title: "Hades", status: "Completed", hoursPlayed: 60, tags: ROGUELITE }),
    makeGame({ title: "Hollow Knight", status: "Completed", hoursPlayed: 40, tags: METROIDVANIA }),
    makeGame({ title: "Stardew Valley", hoursPlayed: 80, tags: FARMING })
  ];
  const sequelA = makeGame({ title: "Hades II", tags: ROGUELITE });
  const sequelB = makeGame({ title: "Hades: Extra", tags: ROGUELITE });
  const ori = makeGame({ title: "Ori", tags: METROIDVANIA });
  const nearly = makeGame({ title: "Nearly", status: "In Progress", hoursPlayed: 10, completionPercent: 50, duration: { mainStoryMinutes: 20 * 60 }, tags: FARMING });
  const short = makeGame({ title: "Short", duration: { mainStoryMinutes: 180 }, tags: METROIDVANIA });
  const result = buildPlayNext({ games: shelf(...seeds, sequelA, sequelB, ori, nearly, short), now: NOW, topCount: 4 });

  assert.equal(result.top.length, 4);
  assert.equal(new Set(result.top.map((pick) => pick.game.id)).size, 4);
  assert.equal(new Set(result.top.map((pick) => seriesKey(pick.game.title))).size, 4);
  assert.ok(new Set(result.top.map((pick) => pick.lane)).size >= 3, "four picks should offer more than one kind of answer");
  const scores = result.top.map((pick) => pick.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test("a new account with nothing played still gets a sensible shelf", () => {
  const loved = makeGame({ title: "Loved", reviewPositive: 190_000, reviewTotal: 200_000, tags: SHOOTER });
  const panned = makeGame({ title: "Panned", reviewPositive: 2_000, reviewTotal: 10_000, tags: SHOOTER });
  const result = buildPlayNext({ games: shelf(loved, panned), now: NOW });
  assert.equal(result.taste.likes.length, 0);
  assert.equal(result.becauseGroups.length, 0);
  assert.ok(result.lanes.acclaimed.some((pick) => pick.game.id === loved.id));
  assert.ok(!Object.values(result.lanes).flat().some((pick) => pick.game.id === panned.id));
});

test("the same library on the same day gives the same shelf", () => {
  const games = shelf(
    makeGame({ status: "Completed", hoursPlayed: 30, tags: METROIDVANIA }),
    makeGame({ tags: METROIDVANIA }),
    makeGame({ tags: { ...METROIDVANIA, Horror: 900 } })
  );
  const first = buildPlayNext({ games, now: NOW }).top.map((pick) => pick.game.id);
  const second = buildPlayNext({ games, now: NOW + 60_000 }).top.map((pick) => pick.game.id);
  assert.deepEqual(first, second);
});

test("tags agree however each source spells them", () => {
  assert.equal(tagKey("Rogue-like"), tagKey("Roguelike"));
  assert.equal(tagKey("Souls-like"), tagKey("Soulslike"));
  assert.equal(tagKey("Point & Click"), tagKey("Point and Click".replace(" and ", " ")));
  const profile = playNextTagProfile({ Indie: 5000, Singleplayer: 4000, Metroidvania: 2000, Platformer: 1000 });
  assert.deepEqual(profile, { Metroidvania: 1, Platformer: 0.5 });
});

test("releases share an edition key and sequels share a series key", () => {
  assert.equal(editionKey("BioShock™ Remastered"), editionKey("BioShock"));
  assert.equal(editionKey("Borderlands Game of the Year Enhanced"), editionKey("Borderlands Game of the Year"));
  assert.equal(editionKey("The Elder Scrolls IV: Oblivion® Game of the Year Edition (2009)"), "the elder scrolls iv oblivion");
  assert.equal(editionKey("Disco Elysium - The Final Cut"), "disco elysium");
  assert.notEqual(editionKey("Borderlands 2"), editionKey("Borderlands"));
  assert.equal(seriesKey("Hades II"), seriesKey("Hades"));
  assert.equal(seriesKey("Borderlands 3"), seriesKey("Borderlands: The Pre-Sequel"));
  assert.notEqual(seriesKey("Portal"), seriesKey("Hades"));
  assert.equal(seriesKey("Sid Meier's Civilization® IV"), seriesKey("Civilization IV: Beyond the Sword"));
  assert.equal(seriesKey("Tom Clancy’s Rainbow Six® Siege"), "rainbow six siege");
  assert.notEqual(seriesKey("Baldur's Gate 3"), seriesKey("Garry's Mod"));
});

test("a dismissed suggestion is replaced in place and the rest stay where they were", () => {
  const pick = (id: string) => ({ game: { id } });
  const before = ["a", "b", "c", "d"];
  // "b" dismissed; the rebuilt shelf ranks the newcomer "e" first.
  const rebuilt = [pick("e"), pick("a"), pick("c"), pick("d")];
  assert.deepEqual(keepSlots(before, rebuilt).map((entry) => entry.game.id), ["a", "e", "c", "d"]);
  // Nothing before: rank order.
  assert.deepEqual(keepSlots([], rebuilt).map((entry) => entry.game.id), ["e", "a", "c", "d"]);
  // Shelf shrinks when nothing replaces the dismissed card.
  assert.deepEqual(keepSlots(before, [pick("a"), pick("c"), pick("d")]).map((entry) => entry.game.id), ["a", "c", "d"]);
});

test("quick wins are solo games with an ending, and demos are never suggested", () => {
  const duration = { mainStoryMinutes: 150 };
  const reviews = { reviewPositive: 900, reviewTotal: 1000 };
  const story = makeGame({ title: "A Short Walk", duration, ...reviews, tags: { Adventure: 1000, Exploration: 800, Cute: 500 } });
  const coop = makeGame({ title: "Two Player Puzzle", duration, ...reviews, playerMode: "coop" });
  const sandbox = makeGame({ title: "Battle Simulator", duration, ...reviews, tags: { Simulation: 1000, Sandbox: 900, Strategy: 500 } });
  const racer = makeGame({ title: "Kart Thing", duration, ...reviews, tags: { Racing: 1000, Arcade: 700, Driving: 600 } });
  const demo = makeGame({ title: "Wreckfest Sneak Peek 2.0", duration, ...reviews });
  const started = makeGame({ title: "Half Done", duration, ...reviews, hoursPlayed: 1, completionPercent: 40, tags: { Adventure: 1000 } });

  const result = buildPlayNext({ games: shelf(story, coop, sandbox, racer, demo, started), now: NOW });
  const quick = result.lanes.quick.map((pick) => pick.game.id);
  assert.ok(quick.includes(story.id));
  for (const excluded of [coop, sandbox, racer]) assert.ok(!quick.includes(excluded.id), `${excluded.title} is not a quick win`);
  assert.ok(!Object.values(result.lanes).flat().some((pick) => pick.game.id === demo.id), "a demo is never a suggestion");
  assert.match(result.lanes.quick.find((pick) => pick.game.id === started.id)?.detail ?? "", /left/);
});
