import type { DemoGame, VaultGoalId, VaultMoodId, VaultSessionId } from "@/lib/demo-data";

export const MAX_VAULT_GENRES = 3;
const VAULT_SELECTION_TEMPERATURE = 15;

export const vaultSessionOptions = [
  { id: "short", label: "Short Session", caption: "~ 1-2 hours" },
  { id: "evening", label: "Evening Session", caption: "~ 2-4 hours" },
  { id: "weekend", label: "Weekend Session", caption: "4+ hours" }
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
  if (selectedGenres.length > MAX_VAULT_GENRES) {
    throw new RangeError(`Select no more than ${MAX_VAULT_GENRES} genres.`);
  }

  const canonicalSelectedGenres = selectedGenres.map(canonicalGenre);

  return games
    .filter((game) => game.ownership === "Owned")
    .filter((game) => !snoozedIds.has(game.id))
    .filter((game) => game.status !== "Completed" && game.completionPercent < 100)
    .filter((game) => (!selectedCollectionId || selectedCollectionId === "all" ? true : game.collectionIds.includes(selectedCollectionId)))
    .filter((game) => goalEligible(game, goal))
    .filter((game) => matchesAnyGenre(game, canonicalSelectedGenres))
    .map((game) => scoreVaultGame(game, session, mood, goal, canonicalSelectedGenres))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.game.title.localeCompare(right.game.title);
    });
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

export function buildVaultAnimationSequence(pool: VaultPoolEntry[], winnerId: string) {
  const winner = pool.find((entry) => entry.game.id === winnerId);
  if (!winner) return [];
  if (pool.length === 1) return [winner];

  const decoys = pool
    .filter((entry) => entry.game.id !== winnerId)
    .map((entry) => ({ entry, order: Math.random() }))
    .sort((left, right) => left.order - right.order)
    .slice(0, Math.min(7, pool.length - 1))
    .map(({ entry }) => entry);

  return [...decoys, winner];
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
    if (sessionScore >= 20) reasons.push(`Fits a ${sessionLabel(session).toLowerCase()}`);
  }

  if (mood && game.moodTags.includes(mood)) {
    score += 24;
    reasons.push(mood === "brain-off" ? "Easy to jump into" : `Matches your ${labelForMood(mood)} mood`);
  } else if (mood) {
    score += 11;
  }

  if (selectedGenres.length) {
    const gameGenres = game.genres.map(canonicalGenre);
    const matches = selectedGenres.filter((genre) => gameGenres.includes(genre));
    score += Math.round(8 + 12 * (matches.length / selectedGenres.length));
    if (matches.length) reasons.push(`Matches ${matches.map(displayGenre).join(" and ")}`);
  }

  if (goal === "new") {
    score += game.hoursPlayed === 0 ? 40 : game.hoursPlayed <= 0.5 ? 34 : 28;
    reasons.push("Not started");
  }

  if (goal === "finish") {
    score += finishScore(game.completionPercent);
    reasons.push(game.completionPercent > 0 ? `${game.completionPercent}% complete` : "Already in progress");
  }

  if (goal === "surprise") {
    score += 30;
  }

  if (game.priority === "Must Play") score += 3;
  if (game.priority === "High") score += 2;

  return { game, score, reasons: reasons.slice(0, 4) };
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

function labelForMood(mood: VaultMoodId) {
  if (mood === "brain-off") return "Brain-off";
  return mood.charAt(0).toUpperCase() + mood.slice(1);
}
