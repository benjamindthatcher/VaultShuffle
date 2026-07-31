import type { DemoGame, VaultGoalId, VaultMoodId, VaultSessionId } from "@/lib/demo-data";
import { formatGameDuration } from "@/lib/game-duration";
import type { VaultMoodScores } from "@/lib/vault-matching";

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

export type VaultEligibilityStage = {
  id: "active" | "collection" | "genres" | "session" | "mood" | "goal" | "snoozes" | "available" | "shortlist";
  label: string;
  count: number;
};

export type VaultEligibility = {
  stages: VaultEligibilityStage[];
  games: DemoGame[];
};

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

  const active = games
    .filter((game) => game.ownership === "Owned")
    .filter((game) => game.status !== "Completed" && game.status !== "Slept");
  const inCollection = !selectedCollectionId || selectedCollectionId === "all"
    ? active
    : active.filter((game) => game.collectionIds.includes(selectedCollectionId));
  const canonicalSelectedGenres = selectedGenres.map(canonicalGenre);
  const genreMatches = inCollection.filter((game) => matchesAnyGenre(game, canonicalSelectedGenres));
  const sessionMatches = session ? genreMatches.filter((game) => game.sessionFit.includes(session)) : genreMatches;
  const moodMatches = sessionMatches;
  const goalMatches = moodMatches.filter((game) => goalEligible(game, goal));
  const available = goalMatches.filter((game) => !snoozedIds.has(game.id));
  const stages: VaultEligibilityStage[] = [{ id: "active", label: "Active", count: active.length }];

  if (selectedCollectionId && selectedCollectionId !== "all") {
    stages.push({ id: "collection", label: `in ${selectedCollectionName || "Collection"}`, count: inCollection.length });
  }
  if (selectedGenres.length) {
    stages.push({ id: "genres", label: "Genre Matches", count: genreMatches.length });
  }
  if (session) {
    stages.push({ id: "session", label: `${sessionLabel(session)} Fits`, count: sessionMatches.length });
  }
  if (mood) {
    stages.push({ id: "mood", label: `${labelForMood(mood)} Ranked`, count: moodMatches.length });
  }
  if (goal && goal !== "surprise") {
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
  const canonicalSelectedGenres = selectedGenres.map(canonicalGenre);
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
    .map((game) => scoreVaultGame(game, session, mood, goal, canonicalSelectedGenres))
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

function scoreVaultGame(
  game: DemoGame,
  session: VaultSessionId | null,
  mood: VaultMoodId | null,
  goal: VaultGoalId | null,
  selectedGenres: string[]
): VaultPoolEntry {
  let score = 0;
  const reasons: string[] = [];

  if (session) {
    const sessionScore = game.sessionFit.includes(session) ? 24 : 12;
    score += sessionScore;
    const durationLabel = formatGameDuration(game.duration);
    if (sessionScore >= 20) {
      reasons.push(durationLabel
        ? `${sessionLabel(session)} fit · ${durationLabel}`
        : `${sessionLabel(session)} fit`);
    }
  }

  if (mood) {
    const moodStrength = moodScoreFor(game.moodScores, mood, game.moodTags.includes(mood));
    score += 14 + moodStrength * 3;
    if (moodStrength >= 3) reasons.push(moodReason(mood));
  }

  if (selectedGenres.length) {
    const gameGenres = game.genres.map(canonicalGenre);
    const matches = selectedGenres.filter((genre) => gameGenres.includes(genre));
    score += Math.round(8 + 12 * (matches.length / selectedGenres.length));
    if (matches.length) reasons.push(`Matches ${matches.map(displayGenre).join(" and ")}`);
  }

  if (goal === "new") {
    score += game.hoursPlayed === 0 ? 40 : game.hoursPlayed <= 0.5 ? 34 : 28;
    reasons.push(game.hoursPlayed === 0 ? "Fresh start · no recorded playtime" : "Barely sampled so far");
  }

  if (goal === "finish") {
    score += finishScore(game.completionPercent);
    reasons.push(game.completionPercent > 0
      ? `Finish Something · ${game.completionPercent}% complete`
      : "Already started and ready to resume");
  }

  if (goal === "surprise") {
    score += 30;
    reasons.push("A wildcard from your eligible library");
  }

  return { game, score, reasons: reasons.slice(0, 4) };
}

function moodScoreFor(scores: VaultMoodScores | undefined, mood: VaultMoodId, tagged: boolean) {
  if (scores) return scores[mood];
  return tagged ? 4 : 0;
}

function goalEligible(game: DemoGame, goal: VaultGoalId | null) {
  if (!goal || goal === "surprise") return true;
  if (goal === "new") return game.status === "Not Started" || game.completionPercent === 0;
  return game.status === "In Progress" || (game.completionPercent > 0 && game.completionPercent < 100);
}

function matchesAnyGenre(game: DemoGame, selectedGenres: string[]) {
  if (!selectedGenres.length) return true;
  const gameGenres = game.genres.map(canonicalGenre);
  return selectedGenres.some((genre) => gameGenres.includes(genre));
}

function finishScore(progress: number) {
  if (progress >= 70) return 40;
  if (progress >= 40) return 36;
  if (progress >= 15) return 31;
  return 25;
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
  if (mood === "brain-off") return "Low-friction pick for switching off";
  if (mood === "chill") return "Softer-energy fit for a chill session";
  return "High-energy fit for an intense session";
}

function labelForMood(mood: VaultMoodId) {
  if (mood === "brain-off") return "Brain-Off";
  return mood.charAt(0).toUpperCase() + mood.slice(1);
}
