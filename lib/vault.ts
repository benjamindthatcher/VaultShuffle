import type { DemoGame, VaultGoalId, VaultMoodId, VaultSessionId } from "./demo-data.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";
import { buildGenreWeightIndex, genrePreferenceAdjustment, type GenrePreferenceContextData, type GenrePreferenceIndex } from "./genre-preferences.ts";
import { verdictBaseline, verdictFor, verdictPoints, type GameVerdicts } from "./game-verdict.ts";
import { moodContributors, type VaultMoodScores } from "./vault-matching.ts";
import { appealDetail, appealLabel, gameAppeal } from "./game-appeal.ts";
import { approximateAge, describeRecency, type RecencyEvidence } from "./recency.ts";
import { sessionLean, sessionabilityReason } from "./sessionability.ts";
import { canClaimNeverPlayed, playtimeIsUnknown } from "./family-sharing.ts";

export const MAX_VAULT_GENRES = 3;
/**
 * How much of the pool the deck shows and rerolls can reach.
 *
 * Not a performance limit, which is what 32 looked like. Scoring already runs
 * over the whole pool whatever this is set to — 5,000 games score in about 3ms,
 * and slicing the deck and drawing from it is around 0.003ms — while the preview
 * lazy-loads its artwork, so the cost here is DOM nodes rather than bandwidth.
 *
 * The genuine ceiling is that finalists are capped at 20 (see vaultFinalists), so
 * beyond roughly 50 a larger deck cannot change which game wins. What it does buy
 * is reroll depth: a draw never repeats until the deck is exhausted. 32 was set
 * when a typical pool was a couple of dozen games; now that only the goal filters,
 * pools run to the hundreds and 32 had quietly become the real filter.
 */
export const MAX_VAULT_DECK_SIZE = 64;
const VAULT_SELECTION_TEMPERATURE = 15;

/* `label` names the choice where nothing else does - the setup cards read
   "Short Session". `shortLabel` is for places that have already said the word,
   like the pick's summary bar, where "SESSION  Weekend Session" says it twice
   and spends the room on the repeat. */
export const vaultSessionOptions = [
  { id: "short", label: "Short Session", shortLabel: "Short", caption: "Shorter pick · up to 10h left" },
  { id: "evening", label: "Evening Session", shortLabel: "Evening", caption: "Medium pick · 10-30h left" },
  { id: "weekend", label: "Weekend Session", shortLabel: "Weekend", caption: "Long pick · 30h+ left" }
] satisfies ReadonlyArray<{ id: VaultSessionId; label: string; shortLabel: string; caption: string }>;

export const vaultMoodOptions = [
  { id: "brain-off", label: "Brain-Off", caption: "Easy to drop into and play." },
  { id: "chill", label: "Chill", caption: "Low-friction, softer energy." },
  { id: "intense", label: "Intense", caption: "Momentum, combat, or pressure." }
] satisfies ReadonlyArray<{ id: VaultMoodId; label: string; caption: string }>;

export const vaultGoalOptions = [
  { id: "new", label: "Something New", caption: "Prioritise untouched games." },
  { id: "finish", label: "Finish Something", caption: "Push progress where you already started." },
  { id: "surprise", label: "Surprise Me", caption: "Loosen the rules and mix the order." }
] satisfies ReadonlyArray<{ id: VaultGoalId; label: string; caption: string }>;

export type VaultPoolEntry = {
  game: DemoGame;
  /** Fit against what the user asked for, 0-100. Learned preference is NOT in here. */
  score: number;
  /**
   * The learned tilt, kept separate from `score` on purpose. The pool is sorted
   * and then truncated twice (deck, then finalists), so anything folded into the
   * ranking decides which games can be drawn at all rather than how likely they
   * are. This is applied at selection time instead, where it can only reweight.
   */
  preferencePoints: number;
  /**
   * How much the game stands out on its own merits — hype and hidden-gem — rather
   * than how well it fits the setup. Applied in both experiment arms, because it
   * is a property of the game and has nothing to do with learned taste.
   */
  appealPoints: number;
  reasons: string[];
};

const VAULT_SCORE_WEIGHTS = {
  session: 30,
  mood: 30,
  goal: 30,
  genres: 10
} as const;

export type VaultEligibilityStage = {
  id: "library" | "active" | "collection" | "genres" | "goal" | "snoozes" | "available" | "shortlist";
  label: string;
  count: number;
  /** What this step removed, so the funnel explains itself rather than just shrinking. */
  detail?: string;
};

export type VaultEligibility = {
  stages: VaultEligibilityStage[];
  games: DemoGame[];
};

export function isCollectionDraw(selectedCollectionId: string | null) {
  return Boolean(selectedCollectionId && selectedCollectionId !== "all");
}

export function getVaultEligibility({
  games,
  // Accepted so callers can pass one options object, but deliberately unused:
  // goal is the only input that removes games. See the note on goalMatches.
  session: _session,
  mood: _mood,
  goal,
  selectedCollectionId,
  selectedCollectionName,
  selectedGenres,
  snoozedIds
}: {
  games: DemoGame[];
  session: VaultSessionId | null;
  mood: VaultMoodId | null;
  goal: VaultGoalId | null;
  selectedCollectionId: string | null;
  selectedCollectionName?: string | null;
  selectedGenres: string[];
  snoozedIds: Set<string>;
}): VaultEligibility {
  if (selectedGenres.length > MAX_VAULT_GENRES) {
    throw new RangeError(`Select no more than ${MAX_VAULT_GENRES} genres.`);
  }

  const collectionDraw = isCollectionDraw(selectedCollectionId);
  const owned = games.filter((game) => game.ownership === "Owned");
  const completedCount = owned.filter((game) => game.status === "Completed").length;
  const sleptCount = owned.filter((game) => game.status === "Slept").length;
  const active = owned.filter((game) => game.status !== "Completed" && game.status !== "Slept");
  const inCollection = !collectionDraw
    ? active
    : active.filter((game) => game.collectionIds.includes(selectedCollectionId!));
  const canonicalSelectedGenres = collectionDraw ? [] : selectedGenres.map(canonicalGenre);
  const genreMatches = inCollection.filter((game) => matchesAnyGenre(game, canonicalSelectedGenres));

  // Goal is the only part of the setup that removes games, because it is the only
  // one that states a category rather than a preference: "Something New" means
  // unplayed, and a game with forty hours on it is not that whatever else it has
  // going for it.
  //
  // Session and mood are preferences. They decide the order, not the guest list —
  // see sessionPoints and moodPoints, which between them are worth 60 of the 100
  // points on offer, so a poor fit sinks far out of contention without ever being
  // declared ineligible.
  const goalMatches = collectionDraw ? genreMatches : genreMatches.filter((game) => goalEligible(game, goal));
  const available = goalMatches.filter((game) => !snoozedIds.has(game.id));
  // Start from the whole library and name what each step took away. Opening on
  // the already-filtered "Active" count meant the funnel began part-way through
  // its own story, and the work the player had done — completing and sleeping
  // games — was invisible.
  const stages: VaultEligibilityStage[] = [{ id: "library", label: "In Library", count: owned.length }];
  if (completedCount || sleptCount) {
    const removed = [
      completedCount ? `${completedCount} completed` : null,
      sleptCount ? `${sleptCount} asleep` : null
    ].filter(Boolean).join(" · ");
    stages.push({ id: "active", label: "Still To Play", count: active.length, detail: removed });
  }

  if (collectionDraw) {
    stages.push({ id: "collection", label: `in ${selectedCollectionName || "Collection"}`, count: inCollection.length });
  }
  if (!collectionDraw && selectedGenres.length) {
    stages.push({ id: "genres", label: "Genre Matches", count: genreMatches.length });
  }
  if (!collectionDraw && goal && goal !== "surprise") {
    stages.push({ id: "goal", label: goal === "new" ? "Unplayed Matches" : "In-progress Matches", count: goalMatches.length });
  }
  if (goalMatches.some((game) => snoozedIds.has(game.id))) {
    stages.push({ id: "snoozes", label: "After Snoozes", count: available.length });
  }
  stages.push({ id: "available", label: "Available", count: available.length });
  if (available.length > MAX_VAULT_DECK_SIZE) {
    stages.push({ id: "shortlist", label: "Best-fit Deck", count: MAX_VAULT_DECK_SIZE });
  }

  return { stages, games: available };
}

export function buildVaultPool({
  games,
  session,
  mood,
  goal,
  selectedCollectionId,
  selectedGenres,
  snoozedIds,
  genrePreferences = null,
  genrePreferenceGlobals = null,
  gameVerdicts = null
}: {
  games: DemoGame[];
  session: VaultSessionId | null;
  mood: VaultMoodId | null;
  goal: VaultGoalId | null;
  selectedCollectionId: string | null;
  selectedGenres: string[];
  snoozedIds: Set<string>;
  genrePreferences?: GenrePreferenceIndex | null;
  genrePreferenceGlobals?: GenrePreferenceIndex | null;
  /** What everyone did with each specific game. See lib/game-verdict.ts. */
  gameVerdicts?: GameVerdicts | null;
}) {
  const collectionDraw = isCollectionDraw(selectedCollectionId);
  const canonicalSelectedGenres = collectionDraw ? [] : selectedGenres.map(canonicalGenre);
  // Genre rarity is measured against this user's own library, which is the corpus
  // the draw actually chooses from.
  const preferenceContext: GenrePreferenceContextData | null = genrePreferences
    ? { index: genrePreferences, globals: genrePreferenceGlobals, genreWeights: buildGenreWeightIndex(games) }
    : null;
  // Computed once per pool rather than per game: it is the average of the same
  // table every entry is measured against.
  const verdictReference = gameVerdicts ? verdictBaseline(gameVerdicts) : 0.5;
  const eligibility = getVaultEligibility({
    games,
    session,
    mood,
    goal,
    selectedCollectionId,
    selectedGenres,
    snoozedIds
  });

  return eligibility.games
    .map((game) => scoreVaultGame(
      game,
      collectionDraw ? null : session,
      collectionDraw ? null : mood,
      collectionDraw ? null : goal,
      canonicalSelectedGenres,
      Date.now(),
      preferenceContext,
      gameVerdicts,
      verdictReference
    ))
    // Ordering is fit only. See VaultPoolEntry.preferencePoints.
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.game.title.localeCompare(right.game.title);
    });
}

export function buildVaultDeck(pool: VaultPoolEntry[], deferredGameIds: string[] = []) {
  if (!deferredGameIds.length) return pool.slice(0, MAX_VAULT_DECK_SIZE);

  const entriesById = new Map(pool.map((entry) => [entry.game.id, entry]));
  const deferredIds = new Set(deferredGameIds);
  const availableNow = pool.filter((entry) => !deferredIds.has(entry.game.id));
  const deferred = deferredGameIds
    .map((gameId) => entriesById.get(gameId))
    .filter((entry): entry is VaultPoolEntry => Boolean(entry));

  return [...availableNow, ...deferred].slice(0, MAX_VAULT_DECK_SIZE);
}

/**
 * Quick Draw deliberately ignores session, mood and goal. It is for the visitor who
 * wants a game now rather than a form, so every eligible game is equally likely:
 * with no inputs every score ties at zero, and drawVaultGame's top-slice would
 * otherwise bias the pick toward whichever titles sort first alphabetically.
 */
export function drawQuickVaultGame(
  pool: VaultPoolEntry[],
  previousWinnerId?: string | null,
  rng = Math.random
) {
  if (!pool.length) return null;
  const eligible = pool.length > 1 && previousWinnerId
    ? pool.filter((entry) => entry.game.id !== previousWinnerId)
    : pool;
  if (!eligible.length) return null;
  return eligible[Math.min(eligible.length - 1, Math.floor(rng() * eligible.length))].game;
}

/**
 * The candidate set a guided draw actually chooses between.
 *
 * Exported so the choice set can be recorded against the draw: "picked C from a
 * set that also held A and B" is a far stronger training signal than three
 * independent labels, and it can only be reconstructed later if it is captured
 * at draw time.
 */
/**
 * How far below the best fit a game can score and still be considered a genuine
 * contender. Interpretable in the same units as the 0-100 fit score.
 */
export const VAULT_FINALIST_SCORE_WINDOW = 15;

/**
 * How many finalists a draw records for history.
 *
 * The API capped this at 32 and rejected anything longer, so a draw failed
 * outright when the field kept for history would not fit - twelve people in
 * twelve hours, all with libraries big enough for dozens of games to score
 * within a point of each other. The list is a record of the draw, not the draw,
 * so it truncates now instead of failing.
 */
export const RECORDED_FINALIST_LIMIT = 128;

export function vaultFinalists(pool: VaultPoolEntry[], previousWinnerId?: string | null) {
  if (!pool.length) return [];
  const eligible = pool.length > 1 && previousWinnerId
    ? pool.filter((entry) => entry.game.id !== previousWinnerId)
    : pool;
  if (eligible.length <= 5) return eligible;

  // Everything genuinely competitive with the best fit, rather than an arbitrary
  // twenty. The pool is sorted by fit, and fit is coarse — session, mood and goal
  // each contribute a handful of discrete values and the total is rounded — so
  // ties are routine. A fixed slice cut straight through them, admitting one
  // game scoring 87 and excluding another scoring 87 purely because its title
  // sorted later, and neither appeal nor learned preference could rescue it
  // because both are applied after this cut.
  const best = eligible[0].score;
  const withinWindow = eligible.filter((entry) => entry.score >= best - VAULT_FINALIST_SCORE_WINDOW);
  let count = Math.max(withinWindow.length, Math.min(eligible.length, 3));
  // Whatever the count works out to, never split a tie at the boundary.
  const boundaryScore = eligible[count - 1].score;
  while (count < eligible.length && eligible[count].score === boundaryScore) count += 1;
  return eligible.slice(0, count);
}

/**
 * `applyPreferences` is the experiment arm. It is decided per draw rather than per
 * user: with single-digit users a between-user split has nowhere near the power to
 * resolve a difference, whereas letting every user act as their own control does.
 */
export function drawVaultGame(
  pool: VaultPoolEntry[],
  previousWinnerId?: string | null,
  rng = Math.random,
  applyPreferences = false
) {
  // Sliced on fit alone, so both arms consider exactly the same candidates and the
  // preference term can only change the odds within that set, never the set.
  const finalists = vaultFinalists(pool, previousWinnerId);
  if (!finalists.length) return null;
  const selectionScore = (entry: VaultPoolEntry) =>
    entry.score + entry.appealPoints + (applyPreferences ? entry.preferencePoints : 0);
  const maxScore = Math.max(...finalists.map(selectionScore));
  const weights = finalists.map((entry) => Math.exp((selectionScore(entry) - maxScore) / VAULT_SELECTION_TEMPERATURE));
  const weightTotal = weights.reduce((total, weight) => total + (Number.isFinite(weight) ? weight : 0), 0);

  if (!Number.isFinite(weightTotal) || weightTotal <= 0) {
    return finalists[Math.floor(rng() * finalists.length)].game;
  }

  let draw = rng() * weightTotal;

  for (let index = 0; index < finalists.length; index += 1) {
    draw -= weights[index];
    if (draw <= 0) return finalists[index].game;
  }

  return finalists[finalists.length - 1].game;
}

export function scoreVaultGame(
  game: DemoGame,
  session: VaultSessionId | null,
  mood: VaultMoodId | null,
  goal: VaultGoalId | null,
  selectedGenres: string[],
  now: number = Date.now(),
  preferenceContext: GenrePreferenceContextData | null = null,
  verdicts: GameVerdicts | null = null,
  verdictReference = 0.5
): VaultPoolEntry {
  let earnedPoints = 0;
  let availablePoints = 0;
  const reasons: string[] = [];

  if (session) {
    availablePoints += VAULT_SCORE_WEIGHTS.session;
    earnedPoints += sessionPoints(game, session);
    reasons.push(sessionReason(game, session));
    // Only said when the tags actually support it, and only when it is the
    // reason the game suits this sitting rather than a restatement of length.
    const shape = sessionabilityReason(game.sessionability ?? 0);
    if (shape && sessionShapePoints(game, session) > 0) reasons.push(shape);
  }

  if (mood) {
    const moodStrength = moodScoreFor(game.moodScores, mood, game.moodTags.includes(mood));
    availablePoints += VAULT_SCORE_WEIGHTS.mood;
    earnedPoints += moodPoints(moodStrength);
    const moodMatch = moodReason(game, mood);
    if (moodMatch) reasons.push(moodMatch);
  }

  let genreReason: string | null = null;
  if (selectedGenres.length) {
    const gameGenres = game.genres.map(canonicalGenre);
    const matches = selectedGenres.filter((genre) => gameGenres.includes(genre));
    availablePoints += VAULT_SCORE_WEIGHTS.genres;
    earnedPoints += VAULT_SCORE_WEIGHTS.genres * (matches.length / selectedGenres.length);
    if (matches.length) genreReason = matches.map(displayGenre).join(" · ");
  }

  if (goal === "new") {
    // Eligibility only, deliberately scoring nothing. goalEligible already keeps
    // this to Not Started with at most half an hour on it, and in practice all
    // but a couple of those have exactly zero hours — so every survivor scored
    // the full 30 and the term could not tell them apart. All it did was widen
    // the denominator from 60 to 90, shrinking the same session and mood gap
    // from 50 points to 33 and, through the softmax, roughly 28:1 odds to 9:1.
    // Choosing Something New made session and mood matter less, which is the
    // opposite of what picking a goal should do.
    reasons.push(canClaimNeverPlayed(game) ? "Unplayed" : "Barely sampled");
  }

  if (goal === "finish") {
    availablePoints += VAULT_SCORE_WEIGHTS.goal;
    earnedPoints += finishPoints(game);
    reasons.push(finishReason(game));
  }

  if (goal === "surprise") {
    // Surprise is deliberately neutral. It widens the pool, but must not
    // dilute a precise session, mood or genre match by consuming score.
    reasons.push("Wildcard");
  }

  const dormancy = lastPlayedReason(game, now);
  if (dormancy) reasons.push(dormancy);
  if (genreReason) reasons.push(genreReason);

  // Clamped as a backstop: no term should ever earn more than it offers, and a
  // score over 100 is a bug report the player should not have to file.
  const score = availablePoints > 0
    ? clamp(Math.round((earnedPoints / availablePoints) * 100), 0, 100)
    : 0;

  // Reported alongside the score rather than inside it. The explanation still
  // reaches the UI, so the user sees why a game was favoured even though the match
  // percentage continues to mean "how well this fits what you asked for".
  const preference = genrePreferenceAdjustment(preferenceContext, game.genres, game.title, mood);
  if (preference.reason) reasons.push(preference.reason);

  const appeal = gameAppeal(game);
  const appealName = appealLabel(appeal.kind);
  if (appealName) reasons.push(appealName);

  // Folded into appeal rather than into taste: this is what everybody did with
  // this game, not what you like, so it applies to every player and in both arms
  // of the preference experiment. Zero until a game has been met enough times to
  // have a verdict, which leaves its own merits deciding the pick.
  const verdict = verdictPoints(verdictFor(verdicts, game.steamAppId), verdictReference);

  return { game, score, preferencePoints: preference.points, appealPoints: appeal.points + verdict, reasons: reasons.slice(0, 4) };
}

export function vaultMatchLabel(score: number) {
  if (score >= 92) return "Perfect match";
  if (score >= 82) return "Excellent match";
  if (score >= 68) return "Strong match";
  if (score >= 50) return "Good match";
  return "Eligible pick";
}

function moodScoreFor(scores: VaultMoodScores | undefined, mood: VaultMoodId, tagged: boolean) {
  if (scores) return scores[mood];
  return tagged ? 4 : 0;
}

/**
 * Spans most of the available weight rather than the top third of it.
 *
 * The old range was 21-30, so the difference between a game built for the mood
 * and one merely tolerable was worth three points out of a hundred — mood was
 * doing nearly all its work as a filter and almost none as a preference. Now that
 * it barely filters, this is where it earns its place.
 */
function moodPoints(strength: number) {
  if (strength >= 7) return VAULT_SCORE_WEIGHTS.mood;
  if (strength >= 5) return 27;
  if (strength >= 3) return 23;
  if (strength >= 1) return 18;
  if (strength >= -1) return 13;
  if (strength >= -3) return 8;
  // An outright contradiction. Still drawable in principle, and in practice ranked
  // so far down that it only surfaces when there is genuinely nothing better.
  return 3;
}

function goalEligible(game: DemoGame, goal: VaultGoalId | null) {
  if (!goal || goal === "surprise") return true;
  // A family game built from a public profile has no playtime we can read, so
  // "show me something I have not played" cannot be answered for it. Same rule
  // as the players and release-age filters in lib/global-filters.ts: a question
  // of fact leaves out what it cannot answer rather than guessing, because the
  // failure here is offering someone eighty hours of Elden Ring as a fresh start.
  if (goal === "new") return game.status === "Not Started" && !playtimeIsUnknown(game) && game.hoursPlayed <= 0.5;
  if (game.duration?.endless) return false;
  return game.status === "In Progress" || (game.completionPercent > 0 && game.completionPercent < 100);
}

function matchesAnyGenre(game: DemoGame, selectedGenres: string[]) {
  if (!selectedGenres.length) return true;
  const gameGenres = game.genres.map(canonicalGenre);
  return selectedGenres.some((genre) => gameGenres.includes(genre));
}

/**
 * Now that shorter games are eligible for longer sessions, this is what keeps a
 * session meaningful: each one rewards the length that actually suits it.
 *
 * Without this a two-hour game would have scored a perfect Weekend match, because
 * the old thresholds only ever asked whether a game was short *enough*.
 */
/**
 * How much this suits the sitting the player says they have.
 *
 * Length alone answers "how big a commitment do I want", which is a different
 * question. A game whose sessions stand on their own is a good short evening at
 * any total length; one that wants an uninterrupted run is a poor one however
 * brief. Length still matters - it is most of the score - but it is no longer
 * the whole of it.
 */
function sessionPoints(game: DemoGame, session: VaultSessionId) {
  if (!game.sessionFit.includes(session)) return 0;
  const shaping = sessionShapePoints(game, session);
  // Clamped after the shaping, not before it. Clamping the base and then adding
  // meant an endless game in a weekend session scored 27 + 4 of a possible 30,
  // and a card came back reading "Perfect match - 102/100".
  if (game.duration?.endless) {
    return clamp((session === "weekend" ? 27 : 24) + shaping, 0, VAULT_SCORE_WEIGHTS.session);
  }

  // Eligible everywhere, preferred nowhere: an unknown length should neither be
  // rewarded nor punished against games whose length is actually known.
  const totalMinutes = estimatedTimeToBeatMinutes(game.duration);
  if (!totalMinutes) return clamp(20 + shaping, 0, VAULT_SCORE_WEIGHTS.session);
  const remainingHours = totalMinutes * Math.max(0.05, 1 - Math.min(99, game.completionPercent) / 100) / 60;

  const lengthPoints = (() => {
    if (session === "short") {
      if (remainingHours <= 3) return VAULT_SCORE_WEIGHTS.session;
      if (remainingHours <= 6) return 28;
      return 26;
    }
    if (session === "evening") {
      if (remainingHours >= 10 && remainingHours <= 30) return VAULT_SCORE_WEIGHTS.session;
      if (remainingHours >= 6) return 26;
      return 22;
    }
    if (remainingHours > 30) return VAULT_SCORE_WEIGHTS.session;
    if (remainingHours >= 15) return 26;
    return 21;
  })();

  // Capped at the session weight so shaping can reorder within the band without
  // letting a well-tagged game outscore the whole term.
  return clamp(lengthPoints + shaping, 0, VAULT_SCORE_WEIGHTS.session);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Worth a few points either way - enough to break ties, not to overturn fit. */
const SESSION_SHAPE_POINTS = 4;

function sessionShapePoints(game: DemoGame, session: VaultSessionId) {
  const lean = sessionLean(game.sessionability ?? 0);
  if (lean === "either") return 0;
  if (session === "short") return lean === "pick-up" ? SESSION_SHAPE_POINTS : -SESSION_SHAPE_POINTS;
  if (session === "weekend") return lean === "sit-down" ? SESSION_SHAPE_POINTS : -SESSION_SHAPE_POINTS;
  return 0;
}

function finishPoints(game: DemoGame) {
  const totalMinutes = estimatedTimeToBeatMinutes(game.duration);
  const remainingHours = totalMinutes
    ? totalMinutes * Math.max(0.05, 1 - Math.min(99, game.completionPercent) / 100) / 60
    : null;
  const progressPoints = 8 + Math.min(12, Math.max(0, game.completionPercent) * 0.12);
  const remainingPoints = remainingHours === null ? 4
    : remainingHours <= 2 ? 10
    : remainingHours <= 5 ? 9
    : remainingHours <= 10 ? 8
    : remainingHours <= 20 ? 6
    : 4;
  return Math.min(VAULT_SCORE_WEIGHTS.goal, Math.round(progressPoints + remainingPoints));
}

function finishReason(game: DemoGame) {
  const totalMinutes = estimatedTimeToBeatMinutes(game.duration);
  if (!totalMinutes) return `${game.completionPercent}% complete`;
  const remainingHours = Math.max(1, Math.round(totalMinutes * Math.max(0.05, 1 - Math.min(99, game.completionPercent) / 100) / 60));
  return `${remainingHours}h left`;
}

function canonicalGenre(value: string) {
  const key = value.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["sci-fi", "sci--fi", "science-fiction"].includes(key)) return "sci-fi";
  if (["role-playing", "role-playing-game", "rpg"].includes(key)) return "rpg";
  return key;
}

/** "Action", "Action and Casual", "Action, Adventure and Casual". */
function listGenres(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function displayGenre(value: string) {
  if (value === "sci-fi") return "Sci-Fi";
  if (value === "rpg") return "RPG";
  return value.replace(/(^|-)([a-z])/g, (_match, separator: string, letter: string) => `${separator ? " " : ""}${letter.toUpperCase()}`);
}

function sessionLabel(session: VaultSessionId) {
  return vaultSessionOptions.find((option) => option.id === session)?.label ?? "session";
}

function sessionReason(game: DemoGame, session: VaultSessionId) {
  if (game.duration?.endless) return "Endless \u00b7 play any length";

  const label = sessionLabel(session).toLowerCase();
  const earned = sessionPoints(game, session);
  const ratio = earned / VAULT_SCORE_WEIGHTS.session;
  if (ratio >= 0.93) return `Ideal ${label} length`;
  if (ratio >= 0.8) return `Good ${label} length`;
  return `${sessionLabel(session)} fit`;
}

/**
 * Null when the game merely does not clash with the mood. Now that a weak or
 * mildly negative score is eligible, claiming "Intense match" for a game that is
 * nothing of the sort would be the reason list telling the player something
 * untrue.
 */
function moodReason(game: DemoGame, mood: VaultMoodId) {
  const label = labelForMood(mood);
  const strength = moodScoreFor(game.moodScores, mood, game.moodTags.includes(mood));
  if (strength >= 7) return `Perfect ${label} match`;
  if (strength >= 5) return `Strong ${label} match`;
  if (strength >= 3) return `Solid ${label} match`;
  return null;
}

/**
 * Dormancy is the one reason a player cannot work out for themselves at a glance,
 * so it earns a place ahead of the genre echo. Anything played recently is not
 * worth mentioning, hence the three-week floor.
 */
/**
 * A DemoGame already carries a resolved recency; this keeps the raw exact
 * timestamp working as one more source for anything built before the mapper ran.
 */
function recencyEvidenceOf(game: DemoGame): RecencyEvidence | null {
  if (game.recency?.known) {
    return {
      lastObservedPlayedAt: game.lastPlayedAt,
      recencySource: game.recency.source,
      recencyEvidenceAt: game.lastPlayedAt
    };
  }
  return game.lastPlayedAt ? { lastObservedPlayedAt: game.lastPlayedAt, recencySource: "steam_exact" } : null;
}

function lastPlayedReason(game: DemoGame, now: number) {
  // Only claimed where there is evidence. Most accounts never get an exact Steam
  // timestamp, so reading one was both usually silent and, where the app filled
  // the gap itself, sometimes wrong.
  const recency = describeRecency(recencyEvidenceOf(game), new Date(now));
  if (!recency.known || recency.daysSince === null) return null;

  const days = Math.floor(recency.daysSince);
  if (days < 21) return null;
  if (!recency.precise) return `Not played in about ${approximateAge(days)}`;
  if (days >= 365) return "Untouched for over a year";
  if (days >= 60) return `Not played in ${Math.round(days / 30)} months`;
  return `Not played in ${days} days`;
}

function labelForMood(mood: VaultMoodId) {
  if (mood === "brain-off") return "Brain-Off";
  return mood.charAt(0).toUpperCase() + mood.slice(1);
}

export type VaultMatchInsightKind = "selection" | "session" | "mood" | "goal" | "taste" | "appeal" | "dormancy" | "genre";

export type VaultMatchInsight = {
  kind: VaultMatchInsightKind;
  /** Drives the accent colour: how strongly this dimension supports the pick. */
  strength: "perfect" | "strong" | "good";
  headline: string;
  detail: string;
};

/**
 * Two across, two rows.
 *
 * Seven kinds can fire, but a draw rarely produces more than four: Surprise Me
 * contributes no goal line, genre only speaks when filters are set, and
 * dormancy, appeal and learned taste each need evidence the game may not have.
 * Reserving three rows meant one sat empty almost every time, so the card
 * carried a permanent gap to accommodate a case that hardly ever arrives.
 */
export const MAX_MATCH_INSIGHTS = 4;

export type VaultMatchExplanation = {
  score: number;
  label: string;
  rank: number;
  poolSize: number;
  insights: VaultMatchInsight[];
};

/**
 * The case for a specific pick, in the player's terms.
 *
 * The result screen previously showed four bare fragments — "1h left",
 * "Untouched for over a year" — which state facts without ever making an
 * argument, and could flatly contradict the panel beside them: "1h left" next to
 * "17h estimated" reads as a bug rather than as "you are nearly finished".
 *
 * Every line here is derived from the same values that produced the score, so the
 * explanation cannot drift from the decision. Nothing is asserted that the data
 * does not support: each insight is omitted when its evidence is missing.
 */
export function buildVaultMatchExplanation({
  entry,
  pool,
  session,
  mood,
  goal,
  selectedGenres = [],
  now = Date.now()
}: {
  entry: VaultPoolEntry;
  pool: VaultPoolEntry[];
  session: VaultSessionId | null;
  mood: VaultMoodId | null;
  goal: VaultGoalId | null;
  selectedGenres?: string[];
  now?: number;
}): VaultMatchExplanation {
  const { game } = entry;
  const insights: VaultMatchInsight[] = [];
  const rank = Math.max(1, pool.findIndex((candidate) => candidate.game.id === game.id) + 1);
  const remaining = remainingHours(game);
  const totalHours = totalPlaythroughHours(game);

  // Rank is not a tile. It says the same thing as the score in the header
  // beside it, and it was taking one of the few slots that could have carried a
  // reason the player did not already know.

  if (session) {
    const label = sessionLabel(session).toLowerCase();
    const earned = sessionPoints(game, session);
    const ratio = earned / VAULT_SCORE_WEIGHTS.session;
    insights.push({
      kind: "session",
      strength: ratio >= 0.93 ? "perfect" : ratio >= 0.8 ? "strong" : "good",
      headline: game.duration?.endless ? "Plays to any length" : `${ratio >= 0.93 ? "Ideal" : ratio >= 0.8 ? "Good" : "Workable"} ${label} length`,
      detail: game.duration?.endless
        ? "No fixed ending, so you can stop whenever you like."
        : remaining === null
          ? "No length estimate yet, so this is neither helped nor penalised."
          : sessionDetail(session, remaining)
    });
  }

  if (mood) {
    const strength = moodScoreFor(game.moodScores, mood, game.moodTags.includes(mood));
    const drivers = moodContributors(game.genres, mood, 3);
    if (strength >= 1 || drivers.length) {
      insights.push({
        kind: "mood",
        strength: strength >= 7 ? "perfect" : strength >= 5 ? "strong" : "good",
        headline: `${strength >= 7 ? "Perfect" : strength >= 5 ? "Strong" : "Fair"} ${labelForMood(mood)} match`,
        // The score is derived from a wider label set than the handful shown on the
        // card, so a strong match can genuinely have no visible driver. Saying
        // "nothing pulls against it" under a "Perfect" headline would undersell the
        // very claim it is meant to support.
        detail: drivers.length
          ? `Tagged ${drivers.join(", ")} — that is what gives it the ${labelForMood(mood)} feel.`
          : strength >= 5
            ? `Its overall tag mix reads strongly ${labelForMood(mood)}.`
            : `Nothing about it pulls against a ${labelForMood(mood)} night.`
      });
    }
  }

  if (goal === "finish" && game.completionPercent > 0) {
    const left = remaining === null ? null : Math.max(1, Math.round(remaining));
    insights.push({
      kind: "goal",
      strength: game.completionPercent >= 80 ? "perfect" : game.completionPercent >= 40 ? "strong" : "good",
      headline: left === null ? `${game.completionPercent}% through` : `About ${left}h from the credits`,
      detail: totalHours && left !== null
        ? `You're ${game.completionPercent}% through a game of roughly ${Math.round(totalHours)}h — the ending is genuinely in reach.`
        : `You're ${game.completionPercent}% through, so finishing it is realistic.`
    });
  }

  if (goal === "new") {
    insights.push({
      kind: "goal",
      strength: canClaimNeverPlayed(game) ? "perfect" : "strong",
      headline: canClaimNeverPlayed(game) ? "Never played" : "Barely sampled",
      detail: canClaimNeverPlayed(game)
        ? "It has been sitting in your library waiting for exactly this."
        : `Only ${game.hoursPlayed}h in, so there is still a whole game here.`
    });
  }

  const dormancy = dormancyDetail(game, now);
  if (dormancy) {
    insights.push({
      kind: "dormancy",
      strength: "strong",
      headline: dormancy.headline,
      detail: dormancy.detail
    });
  }

  if (selectedGenres.length) {
    // Both sides normalised. The picker hands back the label it displays -
    // "Action" - and the game's genres are lowercased and hyphenated on the way
    // in, so comparing them as they arrived never matched a single genre and
    // this reason had never once appeared. Everywhere else in the scoring does
    // canonicalise both; only the explanation did not.
    const wanted = selectedGenres.map(canonicalGenre);
    const gameGenres = game.genres.map(canonicalGenre);
    const matches = wanted.filter((genre) => gameGenres.includes(genre));
    if (matches.length) {
      const everything = matches.length === wanted.length;
      insights.push({
        kind: "genre",
        strength: everything ? "perfect" : "strong",
        headline: listGenres(matches.map(displayGenre)),
        detail: everything
          ? `Matches every genre you filtered for.`
          : `You filtered for ${listGenres(wanted.map(displayGenre))}, and this has ${matches.length} of the ${wanted.length}.`
      });
    }
  }

  const appeal = gameAppeal(game);
  const appealName = appealLabel(appeal.kind);
  const appealWhy = appealDetail(appeal);
  if (appealName && appealWhy) {
    insights.push({
      kind: "appeal",
      strength: appeal.points >= 3 ? "perfect" : appeal.points > 0 ? "strong" : "good",
      headline: appealName,
      detail: appealWhy
    });
  }

  // The learned term, when it had something to say about this game.
  const taste = entry.reasons.find((reason) => reason.includes("lands well for you"));
  if (taste) {
    insights.push({
      kind: "taste",
      strength: entry.preferencePoints >= 5 ? "perfect" : "strong",
      headline: taste,
      detail: "Drawn from what you have actually launched and liked before, not what you told us."
    });
  }

  // Strongest first, so the grid is read in the order that matters rather than
  // the order the reasons happened to be built in. Two things were wrong with
  // build order: a "Workable short length" could sit above a perfect genre
  // match, and the trim took whatever came last - so a perfect reason could be
  // cut to keep a merely good one that had been pushed earlier.
  //
  // Sorted before the trim for that second reason, and stable, so reasons of
  // equal strength keep the order they were built in: what you asked for, then
  // what the game brings to it.
  const shown = insights
    .map((insight, order) => ({ insight, order }))
    .sort((a, b) => insightRank(b.insight) - insightRank(a.insight) || a.order - b.order)
    .slice(0, MAX_MATCH_INSIGHTS)
    .map((entry) => entry.insight);

  return {
    score: entry.score,
    label: vaultMatchLabel(entry.score),
    rank,
    poolSize: pool.length,
    insights: shown
  };
}

/** The same three levels the accent colour uses, as something sortable. */
function insightRank(insight: VaultMatchInsight) {
  if (insight.strength === "perfect") return 2;
  if (insight.strength === "strong") return 1;
  return 0;
}

function totalPlaythroughHours(game: DemoGame) {
  const minutes = estimatedTimeToBeatMinutes(game.duration);
  return minutes ? minutes / 60 : null;
}

function remainingHours(game: DemoGame) {
  const minutes = estimatedTimeToBeatMinutes(game.duration);
  if (!minutes || game.duration?.endless) return null;
  return (minutes * Math.max(0.05, 1 - Math.min(99, game.completionPercent) / 100)) / 60;
}

function sessionDetail(session: VaultSessionId, remaining: number) {
  const left = remaining < 1 ? "Under an hour left" : `Roughly ${Math.round(remaining)}h left`;
  if (session === "short") {
    return remaining <= 3
      ? `${left} — you could see the end of it tonight.`
      : `${left}, so one sitting makes real progress.`;
  }
  if (session === "evening") {
    return remaining >= 10 && remaining <= 30
      ? `${left} — a few evenings, which is exactly the shape you asked for.`
      : `${left}, so an evening covers a good chunk of it.`;
  }
  return remaining > 30
    ? `${left} — enough to properly sink into over a weekend.`
    : `${left}, so a weekend would see it finished.`;
}

function dormancyDetail(game: DemoGame, now: number) {
  const recency = describeRecency(recencyEvidenceOf(game), new Date(now));
  if (!recency.known || recency.daysSince === null) return null;
  const days = Math.floor(recency.daysSince);
  if (days < 21) return null;

  // Only name a month when the evidence can support naming one.
  if (!recency.precise) {
    return {
      headline: `Not played in about ${approximateAge(days)}`,
      detail: "Steam last showed it as active around then, which is as precise as Steam gets."
    };
  }
  const when = new Date(now - days * 86_400_000).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return {
      headline: years >= 2 ? `Untouched for ${years} years` : "Untouched for over a year",
      detail: `Last played ${when}.`
    };
  }
  if (days >= 60) {
    return { headline: `Not played in ${Math.round(days / 30)} months`, detail: `Last played ${when}, so it is well overdue another look.` };
  }
  return { headline: `Not played in ${days} days`, detail: `Last played ${when}.` };
}

