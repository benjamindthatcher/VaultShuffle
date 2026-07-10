import type { DemoGame, VaultGoalId, VaultMoodId, VaultSessionId } from "@/lib/demo-data";

export const vaultSessionOptions = [
  { id: "short", label: "Short Session", caption: "~ 1-2 hours" },
  { id: "evening", label: "Evening Session", caption: "~ 2-4 hours" },
  { id: "weekend", label: "Weekend Session", caption: "4+ hours" }
] satisfies ReadonlyArray<{ id: VaultSessionId; label: string; caption: string }>;

export const vaultMoodOptions = [
  { id: "chill", label: "Chill", caption: "Low-friction, softer energy." },
  { id: "story", label: "Story", caption: "Writing, characters, or worldbuilding." },
  { id: "intense", label: "Intense", caption: "Momentum, combat, or pressure." },
  { id: "brain-off", label: "Brain-Off", caption: "Easy to drop into and play." }
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

export function availableVaultGenres(games: DemoGame[]) {
  return Array.from(new Set(games.flatMap((game) => game.genres))).sort((left, right) => left.localeCompare(right));
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
  session: VaultSessionId;
  mood: VaultMoodId;
  goal: VaultGoalId;
  selectedCollectionId: string;
  selectedGenres: string[];
  snoozedIds: Set<string>;
}) {
  return games
    .filter((game) => game.ownership === "Owned")
    .filter((game) => !snoozedIds.has(game.id))
    .filter((game) => (selectedCollectionId === "all" ? true : game.collectionIds.includes(selectedCollectionId)))
    .filter((game) => game.sessionFit.includes(session))
    .filter((game) => (selectedGenres.length ? selectedGenres.every((genre) => game.genres.includes(genre)) : true))
    .map((game) => scoreVaultGame(game, mood, goal, selectedGenres))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.game.title.localeCompare(right.game.title);
    });
}

export function drawVaultGame(pool: VaultPoolEntry[]) {
  if (!pool.length) return null;
  const finalists = pool.slice(0, Math.min(pool.length, 4));
  return finalists[Math.floor(Math.random() * finalists.length)].game;
}

function scoreVaultGame(game: DemoGame, mood: VaultMoodId, goal: VaultGoalId, selectedGenres: string[]): VaultPoolEntry {
  let score = 0;
  const reasons: string[] = [];

  if (game.moodTags.includes(mood)) {
    score += 5;
    reasons.push(`${labelForMood(mood)} fit`);
  }

  if (selectedGenres.length) {
    const overlap = selectedGenres.filter((genre) => game.genres.includes(genre)).length;
    score += overlap * 3;
    if (overlap > 0) reasons.push(`${overlap} selected genre${overlap > 1 ? "s" : ""}`);
  }

  if (goal === "new") {
    if (game.status === "Not Started") {
      score += 7;
      reasons.push("Fresh pick");
    } else if (game.status === "In Progress") {
      score += 2;
    }
  }

  if (goal === "finish") {
    if (game.status === "In Progress") {
      score += 7;
      reasons.push("Progress-ready");
    } else if (game.status === "Not Started") {
      score += 1;
    }
  }

  if (goal === "surprise") {
    score += seededRank(game.id) % 7;
    reasons.push("Vault wildcard");
  }

  if (game.priority === "Must Play") score += 3;
  if (game.priority === "High") score += 2;

  score += game.status === "Completed" ? -10 : 0;
  return { game, score, reasons };
}

function labelForMood(mood: VaultMoodId) {
  if (mood === "brain-off") return "Brain-off";
  return mood.charAt(0).toUpperCase() + mood.slice(1);
}

function seededRank(value: string) {
  return Array.from(value).reduce((total, character) => total + character.charCodeAt(0), 0);
}
