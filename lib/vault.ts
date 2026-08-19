import type { DemoGame, VaultGoalId, VaultMoodId, VaultSessionId } from "./demo-data.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";
import { buildGenreWeightIndex, genrePreferenceAdjustment, type GenrePreferenceContextData, type GenrePreferenceIndex } from "./genre-preferences.ts";
import type { VaultMoodScores } from "./vault-matching.ts";

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

export const vaultSessionOptions = [
  { id: "short", label: "Short Session", caption: "Shorter pick · up to 10h left" },
  { id: "evening", label: "Evening Session", caption: "Medium pick · 10-30h left" },
  { id: "weekend", label: "Weekend Session", caption: "Long pick · 30h+ left" }
] satisfies ReadonlyArray<{ id: VaultSessionId; label: string; caption: string }>;

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
  reasons: string[];
};

const VAULT_SCORE_WEIGHTS = {
  session: 30,
  mood: 30,
  goal: 30,
  genres: 10
} as const;

export type VaultEligibilityStage = {
  id: "active" | "collection" | "genres" | "goal" | "snoozes" | "available" | "shortlist";
  label: string;
  count: number;
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
  session,
  mood,
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
  const active = games
    .filter((game) => game.ownership === "Owned")
    .filter((game) => game.status !== "Completed" && game.status !== "Slept");
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
  const stages: VaultEligibilityStage[] = [{ id: "active", label: "Active", count: active.length }];

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
  genrePreferenceGlobals = null
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
}) {
  const collectionDraw = isCollectionDraw(selectedCollectionId);
  const canonicalSelectedGenres = collectionDraw ? [] : selectedGenres.map(canonicalGenre);
  // Genre rarity is measured against this user's own library, which is the corpus
  // the draw actually chooses from.
  const preferenceContext: GenrePreferenceContextData | null = genrePreferences
    ? { index: genrePreferences, globals: genrePreferenceGlobals, genreWeights: buildGenreWeightIndex(games) }
    : null;
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
      preferenceContext
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
export function vaultFinalists(pool: VaultPoolEntry[], previousWinnerId?: string | null) {
  if (!pool.length) return [];
  const eligible = pool.length > 1 && previousWinnerId
    ? pool.filter((entry) => entry.game.id !== previousWinnerId)
    : pool;
  const finalistCount = eligible.length <= 5
    ? eligible.length
    : Math.min(20, Math.max(3, Math.ceil(eligible.length * 0.4)));
  return eligible.slice(0, finalistCount);
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
    entry.score + (applyPreferences ? entry.preferencePoints : 0);
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
  preferenceContext: GenrePreferenceContextData | null = null
): VaultPoolEntry {
  let earnedPoints = 0;
  let availablePoints = 0;
  const reasons: string[] = [];

  if (session) {
    availablePoints += VAULT_SCORE_WEIGHTS.session;
    earnedPoints += sessionPoints(game, session);
    reasons.push(sessionReason(game, session));
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
    availablePoints += VAULT_SCORE_WEIGHTS.goal;
    earnedPoints += newGamePoints(game);
    reasons.push(game.hoursPlayed === 0 ? "Unplayed" : "Barely sampled");
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

  const score = availablePoints > 0 ? Math.round((earnedPoints / availablePoints) * 100) : 0;

  // Reported alongside the score rather than inside it. The explanation still
  // reaches the UI, so the user sees why a game was favoured even though the match
  // percentage continues to mean "how well this fits what you asked for".
  const preference = genrePreferenceAdjustment(preferenceContext, game.genres, game.title, mood);
  if (preference.reason) reasons.push(preference.reason);

  return { game, score, preferencePoints: preference.points, reasons: reasons.slice(0, 4) };
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
  if (goal === "new") return game.status === "Not Started" && game.hoursPlayed <= 0.5;
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
function sessionPoints(game: DemoGame, session: VaultSessionId) {
  if (!game.sessionFit.includes(session)) return 0;
  if (game.duration?.endless) return session === "weekend" ? 27 : 24;

  // Eligible everywhere, preferred nowhere: an unknown length should neither be
  // rewarded nor punished against games whose length is actually known.
  const totalMinutes = estimatedTimeToBeatMinutes(game.duration);
  if (!totalMinutes) return 20;
  const remainingHours = totalMinutes * Math.max(0.05, 1 - Math.min(99, game.completionPercent) / 100) / 60;

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
}

function newGamePoints(game: DemoGame) {
  if (game.hoursPlayed === 0) return VAULT_SCORE_WEIGHTS.goal;
  if (game.hoursPlayed <= 0.25) return 27;
  return 24;
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
function lastPlayedReason(game: DemoGame, now: number) {
  if (!game.lastPlayedAt) return null;
  const playedAt = new Date(game.lastPlayedAt).getTime();
  if (!Number.isFinite(playedAt)) return null;

  const days = Math.floor((now - playedAt) / 86_400_000);
  if (days < 21) return null;
  if (days >= 365) return "Untouched for over a year";
  if (days >= 60) return `Not played in ${Math.round(days / 30)} months`;
  return `Not played in ${days} days`;
}

function labelForMood(mood: VaultMoodId) {
  if (mood === "brain-off") return "Brain-Off";
  return mood.charAt(0).toUpperCase() + mood.slice(1);
}
