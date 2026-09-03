import assert from "node:assert/strict";
import test from "node:test";
import type { DemoGame, VaultSessionId } from "./demo-data.ts";
import {
  MAX_VAULT_DECK_SIZE,
  buildVaultDeck,
  buildVaultMatchExplanation,
  buildVaultPool,
  drawQuickVaultGame,
  vaultFinalists,
  drawVaultGame,
  getVaultEligibility,
  scoreVaultGame,
  vaultMatchLabel,
  MAX_MATCH_INSIGHTS
} from "./vault.ts";
import { deriveSessionFits } from "./vault-matching.ts";
import { UNKNOWN_RECENCY } from "./recency.ts";

function makeGame(overrides: Partial<DemoGame> = {}): DemoGame {
  return {
    id: "game-1",
    title: "Test Game",
    recency: UNKNOWN_RECENCY,
    steamAppId: 1,
    ownership: "Owned",
    status: "Not Started",
    hoursPlayed: 0,
    completionPercent: 0,
    priority: "Medium",
    genres: ["Action"],
    description: "Test game",
    artworkUrl: "",
    bannerUrl: "",
    lastPlayedLabel: "Never",
    addedLabel: "Added today",
    collectionIds: [],
    sessionFit: ["short"],
    moodTags: ["intense"],
    moodScores: { "brain-off": 0, chill: 0, intense: 7 },
    duration: {
      mainStoryMinutes: 180,
      mainExtrasMinutes: 180,
      completionistMinutes: 180
    },
    ...overrides
  };
}

test("awards a perfect match for exact session, mood, goal and genre alignment", () => {
  const result = scoreVaultGame(makeGame(), "short", "intense", "new", ["action"]);
  assert.equal(result.score, 100);
  assert.equal(vaultMatchLabel(result.score), "Perfect match");
  assert.deepEqual(result.reasons, ["Ideal short session length", "Perfect Intense match", "Unplayed", "Action"]);
});

test("Surprise Me widens the pool without diluting the selected fit score", () => {
  const result = scoreVaultGame(makeGame(), "short", "intense", "surprise", []);
  assert.equal(result.score, 100);
  assert.deepEqual(result.reasons, ["Ideal short session length", "Perfect Intense match", "Wildcard"]);
});

test("uses stable match brackets including Perfect", () => {
  assert.equal(vaultMatchLabel(94), "Perfect match");
  assert.equal(vaultMatchLabel(85), "Excellent match");
  assert.equal(vaultMatchLabel(70), "Strong match");
  assert.equal(vaultMatchLabel(55), "Good match");
  assert.equal(vaultMatchLabel(40), "Eligible pick");
});

test("Finish Something excludes endless games", () => {
  const endless = makeGame({
    status: "In Progress",
    hoursPlayed: 20,
    completionPercent: 99,
    duration: { endless: true },
    sessionFit: ["short", "evening", "weekend"]
  });

  const pool = buildVaultPool({
    games: [endless],
    session: null,
    mood: null,
    goal: "finish",
    selectedCollectionId: "all",
    selectedGenres: [],
    snoozedIds: new Set()
  });

  assert.equal(pool.length, 0);
});

test("collection draws ignore session, mood, goal and genre filters", () => {
  const collectionGames = [
    makeGame({
      id: "collection-action",
      title: "Collection Action",
      collectionIds: ["collection-1"]
    }),
    makeGame({
      id: "collection-strategy",
      title: "Collection Strategy",
      collectionIds: ["collection-1"],
      genres: ["Strategy"],
      sessionFit: ["weekend"],
      moodTags: ["chill"],
      moodScores: { "brain-off": 0, chill: 7, intense: 0 },
      hoursPlayed: 12,
      status: "In Progress"
    }),
    makeGame({ id: "outside", title: "Outside", collectionIds: [] })
  ];

  const pool = buildVaultPool({
    games: collectionGames,
    session: "short",
    mood: "intense",
    goal: "new",
    selectedCollectionId: "collection-1",
    selectedGenres: ["Action"],
    snoozedIds: new Set()
  });

  assert.deepEqual(pool.map((entry) => entry.game.id), ["collection-action", "collection-strategy"]);
  assert.ok(pool.every((entry) => entry.score === 0));
});

test("caps the deck and rotates a rerolled game behind replacements", () => {
  const pool = Array.from({ length: MAX_VAULT_DECK_SIZE + 8 }, (_, index) => ({
    game: makeGame({ id: `game-${index}`, title: `Game ${String(index).padStart(2, "0")}` }),
    score: 100 - index,
    preferencePoints: 0,
    appealPoints: 0,
    reasons: []
  }));

  const initial = buildVaultDeck(pool);
  const rotated = buildVaultDeck(pool, ["game-0"]);

  assert.equal(initial.length, MAX_VAULT_DECK_SIZE);
  assert.equal(rotated.length, MAX_VAULT_DECK_SIZE);
  assert.equal(initial[0].game.id, "game-0");
  assert.ok(!rotated.some((entry) => entry.game.id === "game-0"));
  assert.ok(rotated.some((entry) => entry.game.id === `game-${MAX_VAULT_DECK_SIZE}`));
});

test("rerolling keeps feeding fresh games into the deck", () => {
  // The deck is a window on the pool, not the pool. Rerolling has to push the
  // game you rejected behind everything else, or the window never moves and the
  // same 64 come round again while a few hundred eligible games never get a
  // turn.
  const pool = Array.from({ length: MAX_VAULT_DECK_SIZE * 3 }, (_, index) => ({
    game: makeGame({ id: `game-${index}`, title: `Game ${String(index).padStart(3, "0")}` }),
    score: 1000 - index,
    preferencePoints: 0,
    appealPoints: 0,
    reasons: []
  }));

  const rejected: string[] = [];
  const seen = new Set<string>();
  const draws = MAX_VAULT_DECK_SIZE + 40;

  for (let draw = 0; draw < draws; draw += 1) {
    const top = buildVaultDeck(pool, rejected)[0].game.id;
    seen.add(top);
    rejected.push(top);
  }

  assert.equal(seen.size, draws, "a reroll should never resurface a game already rejected");
  assert.ok(seen.has(`game-${MAX_VAULT_DECK_SIZE + 10}`), "games from beyond the first deck should get a turn");
});

test("quick draw can reach every game in the pool, not just the top slice", () => {
  const pool = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => ({
    game: { ...makeGame(), id, title: id },
    score: 0,
    reasons: []
  })) as unknown as Parameters<typeof drawQuickVaultGame>[0];

  const reached = new Set<string>();
  for (let index = 0; index < pool.length; index += 1) {
    const picked = drawQuickVaultGame(pool, null, () => index / pool.length);
    if (picked) reached.add(picked.id);
  }

  assert.equal(reached.size, pool.length);
});

test("quick draw does not repeat the previous winner", () => {
  const pool = ["a", "b"].map((id) => ({
    game: { ...makeGame(), id, title: id },
    score: 0,
    reasons: []
  })) as unknown as Parameters<typeof drawQuickVaultGame>[0];

  assert.equal(drawQuickVaultGame(pool, "a", () => 0)?.id, "b");
});

test("reasons describe the game, not just the options the player picked", () => {
  const weakMoodMatch = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: 3 } };
  const strong = scoreVaultGame(makeGame(), "short", "intense", "surprise", []);
  const weak = scoreVaultGame(weakMoodMatch, "short", "intense", "surprise", []);

  assert.notDeepEqual(strong.reasons, weak.reasons);
  assert.ok(strong.reasons.includes("Perfect Intense match"));
  assert.ok(weak.reasons.includes("Solid Intense match"));
});

test("a dormant game says so, and a recently played one does not", () => {
  const now = Date.UTC(2026, 7, 18);
  const day = 86_400_000;

  const dormant = scoreVaultGame(
    { ...makeGame(), lastPlayedAt: new Date(now - 200 * day).toISOString() },
    "short", "intense", "surprise", [], now
  );
  const recent = scoreVaultGame(
    { ...makeGame(), lastPlayedAt: new Date(now - 3 * day).toISOString() },
    "short", "intense", "surprise", [], now
  );

  assert.ok(dormant.reasons.includes("Not played in 7 months"));
  assert.ok(!recent.reasons.some((reason) => reason.startsWith("Not played")));
});

test("a learned preference changes the odds but never the candidate set", () => {
  // The regression this guards: the pool is sorted then truncated twice, so a
  // preference folded into `score` would make disfavoured games undrawable
  // instead of merely less likely.
  const pool = Array.from({ length: 40 }, (_, index) => ({
    game: makeGame({ id: `game-${index}`, title: `Game ${String(index).padStart(2, "0")}` }),
    score: 100 - index,
    // The last game in the deck is heavily disfavoured.
    preferencePoints: index === 31 ? -8 : 0,
    appealPoints: 0,
    reasons: []
  }));

  const deck = buildVaultDeck(pool);
  assert.ok(deck.some((entry) => entry.game.id === "game-31"), "ranking must ignore preference");

  const always = () => 0.999999;
  const withPreference = drawVaultGame(deck, null, always, true);
  const without = drawVaultGame(deck, null, always, false);

  // Both arms draw from the same finalists; only the weighting differs.
  assert.ok(withPreference && without);
});

test("the preference term shifts selection odds in the arm that uses it", () => {
  const pool = [
    { game: makeGame({ id: "liked", title: "Liked" }), score: 80, preferencePoints: 8, appealPoints: 0, reasons: [] },
    { game: makeGame({ id: "disliked", title: "Disliked" }), score: 80, preferencePoints: -8, appealPoints: 0, reasons: [] }
  ];

  // Chosen to sit between the two arms' cutoffs: with equal weights the draw
  // falls past the favoured game, and the tilt is what pulls it back.
  const rng = () => 0.6;
  assert.equal(drawVaultGame(pool, null, rng, false)?.id, "disliked");
  assert.equal(drawVaultGame(pool, null, rng, true)?.id, "liked");
});

test("mood ranks a clash last instead of removing it", () => {
  // Only the goal removes games. Mood is a preference, so a survival horror asked
  // for on a Chill night sinks to the bottom rather than ceasing to exist.
  const neutral = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: 0 } };
  const clash = { ...makeGame(), id: "clash", title: "Clash", moodScores: { "brain-off": 0, chill: -6, intense: 6 } };
  const pool = buildVaultPool({
    games: [neutral, clash],
    session: null, mood: "chill", goal: null,
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });

  assert.equal(pool.length, 2, "mood must not remove anything");
  assert.deepEqual(pool.map((entry) => entry.game.id), ["game-1", "clash"]);
});

test("a session mismatch is ranked down, not filtered out", () => {
  const long = { ...makeGame(), id: "long", title: "Long", duration: { mainStoryMinutes: 6_000 }, sessionFit: ["weekend"] as VaultSessionId[] };
  const brief = { ...makeGame(), duration: { mainStoryMinutes: 120 }, sessionFit: ["short", "evening", "weekend"] as VaultSessionId[] };
  const pool = buildVaultPool({
    games: [long, brief],
    session: "short", mood: null, goal: null,
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });

  assert.equal(pool.length, 2, "session must not remove anything");
  assert.equal(pool[0].game.id, "game-1", "the game that actually fits should lead");
});

test("only the goal removes games from the pool", () => {
  const played = { ...makeGame(), id: "played", title: "Played", status: "In Progress" as const, hoursPlayed: 40 };
  const fresh = { ...makeGame(), status: "Not Started" as const, hoursPlayed: 0 };
  const pool = buildVaultPool({
    games: [played, fresh],
    session: "short", mood: "chill", goal: "new",
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });

  assert.deepEqual(pool.map((entry) => entry.game.id), ["game-1"]);
});

test("a game with no mood signal is never stranded", () => {
  // 33 games in a real library matched no mood at all and so could never be
  // drawn, because a mood is always chosen.
  const blank = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: 0 } };
  for (const mood of ["brain-off", "chill", "intense"] as const) {
    const pool = buildVaultPool({
      games: [blank], session: null, mood, goal: null,
      selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
    });
    assert.equal(pool.length, 1, `${mood} stranded a game with no signal`);
  }
});

test("mood separates games far more than it used to", () => {
  const built = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: 8 } };
  const tolerable = { ...makeGame(), moodScores: { "brain-off": 0, chill: 0, intense: -2 } };
  const strong = scoreVaultGame(built, null, "intense", null, []);
  const weak = scoreVaultGame(tolerable, null, "intense", null, []);

  // Previously the whole range was 21-30 of 30, so mood barely moved a score.
  assert.ok(strong.score - weak.score >= 50, `mood spread was only ${strong.score - weak.score}`);
});

test("a weekend prefers a long game over a short one", () => {
  // Short games are eligible for a weekend now, so scoring has to be what keeps
  // the session meaningful.
  const short = { ...makeGame(), duration: { mainStoryMinutes: 120 }, sessionFit: ["short", "evening", "weekend"] as const };
  const long = { ...makeGame(), duration: { mainStoryMinutes: 3_600 }, sessionFit: ["weekend"] as const };
  const shortScore = scoreVaultGame({ ...short, sessionFit: [...short.sessionFit] }, "weekend", null, null, []);
  const longScore = scoreVaultGame({ ...long, sessionFit: [...long.sessionFit] }, "weekend", null, null, []);

  assert.ok(longScore.score > shortScore.score, "a weekend draw should still favour something meaty");
});

test("the finish goal explains progress instead of contradicting the estimate", () => {
  // The reported confusion: "1h left" sat beside "17h estimated" and read as a
  // bug, when the real story was that the player is nearly at the credits.
  const nearlyDone = { ...makeGame(), duration: { mainStoryMinutes: 1_020 }, completionPercent: 94, hoursPlayed: 16 };
  const pool = buildVaultPool({
    games: [nearlyDone], session: "short", mood: null, goal: "finish",
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({
    entry: pool[0], pool, session: "short", mood: null, goal: "finish"
  });
  const goal = explanation.insights.find((insight) => insight.kind === "goal");

  assert.ok(goal, "a finish draw should explain how close the ending is");
  assert.match(goal.detail, /94%/);
  assert.match(goal.detail, /17h/);
});

test("filtering by genre is credited as a reason", () => {
  // The picker hands back the label it shows - "Action" - while a game's genres
  // are normalised to "action" on the way in. The explanation compared the two
  // raw, so it never matched and the reason never once appeared for anybody.
  const game = { ...makeGame(), genres: ["Action", "Adventure"] };
  const pool = buildVaultPool({
    games: [game], session: "short", mood: null, goal: null,
    selectedCollectionId: null, selectedGenres: ["Action"], snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({
    entry: pool[0], pool, session: "short", mood: null, goal: null, selectedGenres: ["Action"]
  });
  const genre = explanation.insights.find((insight) => insight.kind === "genre");

  assert.ok(genre, "a genre the player filtered for should be credited");
  assert.match(genre.headline, /Action/);
  assert.equal(genre.strength, "perfect");
});

test("a partial genre match is credited as partial", () => {
  const game = { ...makeGame(), genres: ["Action", "Simulation"] };
  const selected = ["Action", "Racing"];
  const pool = buildVaultPool({
    games: [game], session: "short", mood: null, goal: null,
    selectedCollectionId: null, selectedGenres: selected, snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({
    entry: pool[0], pool, session: "short", mood: null, goal: null, selectedGenres: selected
  });
  const genre = explanation.insights.find((insight) => insight.kind === "genre");

  assert.ok(genre);
  assert.equal(genre.strength, "strong");
  assert.match(genre.detail, /1 of the 2/);
});

test("the strongest reasons are read first, and survive the trim", () => {
  // Build order used to decide both the reading order and what got cut, so a
  // weak session fit could lead the grid and a perfect reason could be dropped
  // to keep a merely good one pushed before it.
  const game = {
    ...makeGame(),
    genres: ["Action", "Adventure"],
    duration: { mainStoryMinutes: 60 * 60 },
    hoursPlayed: 0
  };
  const selected = ["Action", "Adventure"];
  const pool = buildVaultPool({
    games: [game], session: "short", mood: "intense", goal: "new",
    selectedCollectionId: null, selectedGenres: selected, snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({
    entry: pool[0], pool, session: "short", mood: "intense", goal: "new", selectedGenres: selected
  });

  const ranks = explanation.insights.map((insight) =>
    insight.strength === "perfect" ? 2 : insight.strength === "strong" ? 1 : 0);
  const sorted = [...ranks].sort((a, b) => b - a);
  assert.deepEqual(ranks, sorted, "reasons should be read strongest first");

  // A 60h game against a short session is the weakest thing here, so it must not
  // be leading, and the perfect genre match must not have been trimmed away.
  assert.notEqual(explanation.insights[0]?.kind, "session");
  assert.ok(explanation.insights.some((insight) => insight.kind === "genre"));
});

test("an explanation claims nothing the draw did not use", () => {
  // Quick Draw and Collection Draw ignore session, mood and goal, so crediting
  // them would be inventing reasoning.
  const pool = buildVaultPool({
    games: [makeGame()], session: null, mood: null, goal: null,
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({
    entry: pool[0], pool, session: null, mood: null, goal: null
  });

  for (const kind of ["session", "mood", "goal", "genre"]) {
    assert.ok(!explanation.insights.some((insight) => insight.kind === kind), `${kind} was asserted without being used`);
  }
});

test("every explanation line carries the evidence behind it", () => {
  const pool = buildVaultPool({
    games: [{ ...makeGame(), completionPercent: 40, hoursPlayed: 5 }],
    session: "short", mood: "intense", goal: "finish",
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({
    entry: pool[0], pool, session: "short", mood: "intense", goal: "finish"
  });

  assert.ok(explanation.insights.length >= 2, "a guided draw should give a real case, not one line");
  // Six or four where the evidence allows, and never trimmed below four - a
  // full row is worth having, a lost reason is not worth paying for it.
  assert.ok(explanation.insights.length <= MAX_MATCH_INSIGHTS);
  assert.ok(explanation.insights.length >= 2);
  for (const insight of explanation.insights) {
    assert.ok(insight.headline.length > 0 && insight.detail.length > 0, "an insight without a detail is just a label again");
    assert.notEqual(insight.headline, insight.detail);
  }
});

test("rank is not spent on a tile, since the header already carries it", () => {
  const pool = buildVaultPool({
    games: [{ ...makeGame(), completionPercent: 40, hoursPlayed: 5 }, makeGame({ id: "other" })],
    session: "short", mood: "intense", goal: "finish",
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({
    entry: pool[0], pool, session: "short", mood: "intense", goal: "finish"
  });

  assert.ok(!explanation.insights.some((insight) => insight.kind === "selection"));
  // Still reported, just in the header rather than as a tile.
  assert.ok(explanation.rank >= 1);
  assert.ok(explanation.poolSize >= 1);
});

test("the lens starts at the whole library and names what was actioned away", () => {
  // Opening on the already-filtered count meant the funnel began part-way through
  // its own story: the completing and sleeping the player had done was invisible.
  const games = [
    ...Array.from({ length: 228 }, (_, i) => makeGame({ id: `a${i}` })),
    ...Array.from({ length: 2 }, (_, i) => makeGame({ id: `c${i}`, status: "Completed" })),
    ...Array.from({ length: 4 }, (_, i) => makeGame({ id: `s${i}`, status: "Slept" }))
  ];

  const { stages } = getVaultEligibility({
    games, session: null, mood: null, goal: null,
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });

  assert.equal(stages[0].id, "library");
  assert.equal(stages[0].count, 234, "the funnel should open on the real library size");
  assert.equal(stages[1].id, "active");
  assert.equal(stages[1].count, 228);
  assert.equal(stages[1].detail, "2 completed · 4 asleep");
});

test("a library with nothing actioned does not show an empty removal step", () => {
  const games = [makeGame({ id: "a" }), makeGame({ id: "b" })];
  const { stages } = getVaultEligibility({
    games, session: null, mood: null, goal: null,
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });

  assert.equal(stages[0].id, "library");
  assert.ok(!stages.some((stage) => stage.id === "active"), "nothing was removed, so nothing to explain");
});

test("finalists keep every game tied at the cut, not the alphabetically early ones", () => {
  // Thirty-five games all scoring 87: a fixed twenty-game slice admitted the first
  // twenty by title and excluded fifteen equally good matches.
  const pool = Array.from({ length: 35 }, (_, index) => ({
    game: { ...makeGame(), id: `tied-${index}`, title: `Game ${String(index).padStart(2, "0")}` },
    score: 87,
    appealPoints: 0,
    preferencePoints: 0,
    reasons: []
  })) as unknown as Parameters<typeof vaultFinalists>[0];

  assert.equal(vaultFinalists(pool).length, 35);
});

test("a guided draw chooses between ten, not sixty", () => {
  // The window had no upper bound, so on a large library the median draw was
  // choosing between 23 games and the 90th percentile between 64. Nothing can be
  // consistently offered out of a field that size.
  const pool = Array.from({ length: 60 }, (_, index) => ({
    game: { ...makeGame(), id: `g-${index}`, title: `Game ${String(index).padStart(2, "0")}` },
    score: 90 - index * 0.1,
    appealPoints: 0,
    preferencePoints: 0,
    reasons: []
  })) as unknown as Parameters<typeof vaultFinalists>[0];

  assert.equal(vaultFinalists(pool).length, 10);
});

test("among equal fits the better game takes the slot, not the earlier title", () => {
  // Fit is coarse and ties are routine, so the tiebreak decides most shortlists.
  // It used to be alphabetical, which is how a sixty-game field ended up sorted
  // by name. Appeal carries the population's verdict and how played a game is.
  const pool = Array.from({ length: 30 }, (_, index) => ({
    game: { ...makeGame(), id: `g-${index}`, title: `Game ${String(index).padStart(2, "0")}` },
    score: 87,
    // The alphabetically last games are the well-regarded ones.
    appealPoints: index,
    preferencePoints: 0,
    reasons: []
  })) as unknown as Parameters<typeof vaultFinalists>[0];

  const finalists = vaultFinalists([...pool].sort((left, right) =>
    right.score - left.score
    || right.appealPoints - left.appealPoints
    || left.game.title.localeCompare(right.game.title)));

  assert.equal(finalists.length, 10);
  // The best-regarded ten, not Game 00 through Game 09.
  assert.equal(finalists[0].game.id, "g-29");
  assert.ok(finalists.every((entry) => entry.appealPoints >= 20));
});

test("finalists still exclude a genuinely worse fit", () => {
  const pool = [
    ...Array.from({ length: 6 }, (_, index) => ({
      game: { ...makeGame(), id: `strong-${index}`, title: `Strong ${index}` },
      score: 90, appealPoints: 0, preferencePoints: 0, reasons: []
    })),
    ...Array.from({ length: 6 }, (_, index) => ({
      game: { ...makeGame(), id: `weak-${index}`, title: `Weak ${index}` },
      score: 20, appealPoints: 0, preferencePoints: 0, reasons: []
    }))
  ] as unknown as Parameters<typeof vaultFinalists>[0];

  const finalists = vaultFinalists(pool);
  assert.equal(finalists.length, 6);
  assert.ok(finalists.every((entry) => entry.game.id.startsWith("strong")));
});

test("an all-tied pool makes every game a finalist, which is what a collection draw is", () => {
  // Collection Draw drops session, mood and goal, so every game scores zero.
  const pool = Array.from({ length: 100 }, (_, index) => ({
    game: { ...makeGame(), id: `c-${index}`, title: `Collection ${String(index).padStart(3, "0")}` },
    score: 0, appealPoints: 0, preferencePoints: 0, reasons: []
  })) as unknown as Parameters<typeof vaultFinalists>[0];

  assert.equal(vaultFinalists(pool).length, 100);
});

test("a long roguelike is offered for a short session, and a short story game is not", () => {
  // Session used to be answered purely from remaining length, so a fifty-hour
  // roguelike was barred from a short evening and a two-hour narrative game was
  // its best suggestion. Both are backwards.
  const roguelike = deriveSessionFits({
    duration: { mainStoryMinutes: 50 * 60 },
    completionPercent: 0,
    endless: false,
    sessionability: 1
  });
  const narrative = deriveSessionFits({
    duration: { mainStoryMinutes: 2 * 60 },
    completionPercent: 0,
    endless: false,
    sessionability: -1
  });

  assert.ok(roguelike.includes("short"));
  assert.ok(!narrative.includes("short"));
  assert.ok(narrative.includes("evening"));
});

test("a game whose tags say nothing keeps the length-based answer", () => {
  const unopinionated = deriveSessionFits({
    duration: { mainStoryMinutes: 4 * 60 },
    completionPercent: 0,
    endless: false,
    sessionability: 0
  });
  assert.deepEqual(unopinionated, ["short", "evening", "weekend"]);
});

test("shaping reorders within a session but cannot outrank the term", () => {
  const base = { duration: { mainStoryMinutes: 5 * 60 }, completionPercent: 0 };
  const pickUp = scoreVaultGame(
    makeGame({ ...base, sessionability: 1, sessionFit: ["short", "evening", "weekend"] } as Partial<DemoGame>),
    "short", null, null, [], Date.now()
  );
  const sitDown = scoreVaultGame(
    makeGame({ ...base, sessionability: -1, sessionFit: ["short", "evening", "weekend"] } as Partial<DemoGame>),
    "short", null, null, [], Date.now()
  );

  assert.ok(pickUp.score > sitDown.score, "a pick-up-and-play game should win a short session");
  assert.ok(pickUp.score <= 100);
});

test("no draw shows more than the two rows the card reserves", () => {
  const pool = buildVaultPool({
    games: [{ ...makeGame(), completionPercent: 40, hoursPlayed: 5 }],
    session: "short", mood: "intense", goal: "finish",
    selectedCollectionId: null, selectedGenres: ["action"], snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({
    entry: pool[0], pool, session: "short", mood: "intense", goal: "finish", selectedGenres: ["action"]
  });

  assert.ok(explanation.insights.length <= MAX_MATCH_INSIGHTS);
  assert.equal(MAX_MATCH_INSIGHTS, 4);
});

test("no term earns more than it offers, so the score never passes 100", () => {
  // An endless game in a weekend session scored 27 + 4 of a possible 30, and the
  // card read "Perfect match · 102/100".
  const endless = makeGame({
    duration: { endless: true },
    sessionability: 1,
    sessionFit: ["short", "evening", "weekend"]
  } as Partial<DemoGame>);

  for (const session of ["short", "evening", "weekend"] as const) {
    const entry = scoreVaultGame(endless, session, null, null, [], Date.now());
    assert.ok(entry.score <= 100, `${session} scored ${entry.score}`);
    assert.ok(entry.score >= 0);
  }
});

test("a family game says whose it is on every draw, whatever the goal", () => {
  // Provenance is not a goal-specific footnote. Being handed somebody else's
  // game is the most surprising thing a draw can do, and it has to survive the
  // trim to four insights however the player set the deck up.
  for (const goal of ["new", "finish", "surprise"] as const) {
    const shared = { ...makeGame(), accessSource: "family" as const, familyOwnerName: "Draygo", hoursPlayed: 0, completionPercent: 0 };
    const pool = buildVaultPool({
      games: [shared], session: null, mood: null, goal,
      selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
    });
    if (!pool.length) continue;
    const explanation = buildVaultMatchExplanation({ entry: pool[0], pool, session: null, mood: null, goal });
    const family = explanation.insights.find((insight) => insight.kind === "family");
    assert.ok(family, `no family insight for goal ${goal}`);
    assert.match(family.headline, /Draygo/);
    // Never a playtime claim, and never a second tile repeating the first.
    assert.doesNotMatch(family.detail, /never played/i);
    assert.equal(explanation.insights.filter((i) => i.headline === family.headline).length, 1);
  }
});

test("an owned game never claims to be shared", () => {
  const pool = buildVaultPool({
    games: [{ ...makeGame(), hoursPlayed: 0 }], session: null, mood: null, goal: "new",
    selectedCollectionId: null, selectedGenres: [], snoozedIds: new Set()
  });
  const explanation = buildVaultMatchExplanation({ entry: pool[0], pool, session: null, mood: null, goal: "new" });
  assert.equal(explanation.insights.some((insight) => insight.kind === "family"), false);
  assert.ok(explanation.insights.some((insight) => insight.headline === "Never played"));
});
