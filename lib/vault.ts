import type { DemoGame, VaultGoalId, VaultMoodId, VaultSessionId } from "./demo-data.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";
import type { VaultMoodScores } from "./vault-matching.ts";

export const MAX_VAULT_GENRES = 3;
export const MAX_VAULT_DECK_SIZE = 32;
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
  score: number;
  reasons: string[];
};

const VAULT_SCORE_WEIGHTS = {
  session: 30,
  mood: 30,
  goal: 30,
  genres: 10
} as const;

export type VaultEligibilityStage = {
  id: "active" | "collection" | "genres" | "session" | "mood" | "goal" | "snoozes" | "available" | "shortlist";
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
  const sessionMatches = !collectionDraw && session ? genreMatches.filter((game) => game.sessionFit.includes(session)) : genreMatches;
  const moodMatches = !collectionDraw && mood ? sessionMatches.filter((game) => moodEligible(game, mood)) : sessionMatches;
  const goalMatches = collectionDraw ? moodMatches : moodMatches.filter((game) => goalEligible(game, goal));
  const available = goalMatches.filter((game) => !snoozedIds.has(game.id));
  const stages: VaultEligibilityStage[] = [{ id: "active", label: "Active", count: active.length }];

  if (collectionDraw) {
    stages.push({ id: "collection", label: `in ${selectedCollectionName || "Collection"}`, count: inCollection.length });
  }
  if (!collectionDraw && selectedGenres.length) {
    stages.push({ id: "genres", label: "Genre Matches", count: genreMatches.length });
  }
  if (!collectionDraw && session) {
    stages.push({ id: "session", label: `${sessionLabel(session)} Fits`, count: sessionMatches.length });
  }
  if (!collectionDraw && mood) {
    stages.push({ id: "mood", label: `${labelForMood(mood)} Fits`, count: moodMatches.length });
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
  snoozedIds
}: {
  games: DemoGame[];
  session: VaultSessionId | null;
  mood: VaultMoodId | null;
  goal: VaultGoalId | null;
  selectedCollectionId: string | null;
  selectedGenres: string[];
  snoozedIds: Set<string>;
}) {
  const collectionDraw = isCollectionDraw(selectedCollectionId);
  const canonicalSelectedGenres = collectionDraw ? [] : selectedGenres.map(canonicalGenre);
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
      canonicalSelectedGenres
    ))
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

export function drawVaultGame(pool: VaultPoolEntry[], previousWinnerId?: string | null, rng = Math.random) {
  if (!pool.length) return null;
  const eligible = pool.length > 1 && previousWinnerId
    ? pool.filter((entry) => entry.game.id !== previousWinnerId)
    : pool;
  const finalistCount = eligible.length <= 5
    ? eligible.length
    : Math.min(20, Math.max(3, Math.ceil(eligible.length * 0.4)));
  const finalists = eligible.slice(0, finalistCount);
  const maxScore = Math.max(...finalists.map((entry) => entry.score));
  const weights = finalists.map((entry) => Math.exp((entry.score - maxScore) / VAULT_SELECTION_TEMPERATURE));
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
  selectedGenres: string[]
): VaultPoolEntry {
  let earnedPoints = 0;
  let availablePoints = 0;
  const reasons: string[] = [];

  if (session) {
    availablePoints += VAULT_SCORE_WEIGHTS.session;
    earnedPoints += sessionPoints(game, session);
    reasons.push(sessionReason(session));
  }

  if (mood) {
    const moodStrength = moodScoreFor(game.moodScores, mood, game.moodTags.includes(mood));
    availablePoints += VAULT_SCORE_WEIGHTS.mood;
    earnedPoints += moodPoints(moodStrength);
    reasons.push(moodReason(mood));
  }

  if (selectedGenres.length) {
    const gameGenres = game.genres.map(canonicalGenre);
    const matches = selectedGenres.filter((genre) => gameGenres.includes(genre));
    availablePoints += VAULT_SCORE_WEIGHTS.genres;
    earnedPoints += VAULT_SCORE_WEIGHTS.genres * (matches.length / selectedGenres.length);
    if (matches.length) reasons.push(matches.map(displayGenre).join(" · "));
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

  const score = availablePoints > 0 ? Math.round((earnedPoints / availablePoints) * 100) : 0;
  return { game, score, reasons: reasons.slice(0, 4) };
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

function moodEligible(game: DemoGame, mood: VaultMoodId) {
  return moodScoreFor(game.moodScores, mood, game.moodTags.includes(mood)) >= 3;
}

function moodPoints(strength: number) {
  if (strength <= 3) return 21;
  if (strength === 4) return 24;
  if (strength === 5) return 27;
  return VAULT_SCORE_WEIGHTS.mood;
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

function sessionPoints(game: DemoGame, session: VaultSessionId) {
  if (!game.sessionFit.includes(session)) return 0;
  if (game.duration?.endless) return session === "weekend" ? 27 : 24;

  const totalMinutes = estimatedTimeToBeatMinutes(game.duration);
  if (!totalMinutes) return 20;
  const remainingHours = totalMinutes * Math.max(0.05, 1 - Math.min(99, game.completionPercent) / 100) / 60;

  if (session === "short") {
    if (remainingHours <= 3) return 30;
    if (remainingHours <= 6) return 28;
    if (remainingHours <= 8) return 26;
    return 24;
  }
  if (session === "evening") {
    if (remainingHours <= 18) return 30;
    if (remainingHours <= 24) return 28;
    return 25;
  }
  if (remainingHours <= 60) return 30;
  if (remainingHours <= 100) return 28;
  return 26;
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

function moodReason(mood: VaultMoodId) {
  if (mood === "brain-off") return "Low focus";
  if (mood === "chill") return "Chill pace";
  return "High energy";
}

function sessionReason(session: VaultSessionId) {
  if (session === "short") return "Short fit";
  if (session === "evening") return "Evening fit";
  return "Weekend fit";
}

function labelForMood(mood: VaultMoodId) {
  if (mood === "brain-off") return "Brain-Off";
  return mood.charAt(0).toUpperCase() + mood.slice(1);
}
