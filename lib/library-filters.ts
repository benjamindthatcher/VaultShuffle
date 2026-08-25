import type { DemoGame } from "./demo-data.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";

/**
 * Filtering a library, as opposed to searching it.
 *
 * Search answers "where is this game". These answer "what could I play", which
 * is the question someone with 208 active games actually has and the one the
 * toolbar could not express: show me things I have started, show me something
 * under ten hours, show me the RPGs.
 *
 * Status is deliberately absent - the Active/Slept/Completed tabs already own
 * that - and so is platform, which the account menu's device mode covers
 * globally.
 */

export type ProgressFilter = "any" | "not-started" | "in-progress";
export type LengthFilter = "any" | "under-10" | "10-30" | "over-30" | "endless";

export type LibraryFilters = {
  progress: ProgressFilter;
  length: LengthFilter;
  genres: string[];
};

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = { progress: "any", length: "any", genres: [] };

export const PROGRESS_OPTIONS: Array<{ id: ProgressFilter; label: string }> = [
  { id: "any", label: "Any" },
  { id: "not-started", label: "Not started" },
  { id: "in-progress", label: "In progress" }
];

export const LENGTH_OPTIONS: Array<{ id: LengthFilter; label: string }> = [
  { id: "any", label: "Any" },
  { id: "under-10", label: "Under 10h" },
  { id: "10-30", label: "10–30h" },
  { id: "over-30", label: "30h+" },
  { id: "endless", label: "Endless" }
];

/**
 * How many filters are doing something, for the button's badge. Genres count
 * once however many are picked, because the button is reporting how many
 * decisions are in effect rather than how many boxes are ticked.
 */
export function activeFilterCount(filters: LibraryFilters): number {
  let count = 0;
  if (filters.progress !== "any") count += 1;
  if (filters.length !== "any") count += 1;
  if (filters.genres.length) count += 1;
  return count;
}

export function hasActiveFilters(filters: LibraryFilters): boolean {
  return activeFilterCount(filters) > 0;
}

function matchesProgress(game: DemoGame, progress: ProgressFilter) {
  if (progress === "any") return true;
  // Judged on playtime rather than the status label, which can lag behind and
  // which the tabs already filter on.
  const started = game.hoursPlayed > 0;
  return progress === "not-started" ? !started : started;
}

function matchesLength(game: DemoGame, length: LengthFilter) {
  if (length === "any") return true;
  if (game.duration?.endless) return length === "endless";
  if (length === "endless") return false;

  const minutes = estimatedTimeToBeatMinutes(game.duration);
  // A game with no estimate cannot be claimed to be short or long. It drops out
  // of a length filter rather than being guessed into one.
  if (!minutes) return false;

  const hours = minutes / 60;
  if (length === "under-10") return hours < 10;
  if (length === "10-30") return hours >= 10 && hours <= 30;
  return hours > 30;
}

function matchesGenres(game: DemoGame, genres: string[]) {
  if (!genres.length) return true;
  const owned = new Set(game.genres.map((genre) => genre.toLowerCase()));
  // Any, not all: picking RPG and Strategy means "either of these", which is how
  // people read a list of ticks.
  return genres.some((genre) => owned.has(genre.toLowerCase()));
}

export function matchesLibraryFilters(game: DemoGame, filters: LibraryFilters): boolean {
  return matchesProgress(game, filters.progress)
    && matchesLength(game, filters.length)
    && matchesGenres(game, filters.genres);
}

/**
 * The genres worth offering: the ones actually present in this library, most
 * common first. Offering the full Steam taxonomy would mostly offer empty
 * results.
 */
export function availableGenres(games: DemoGame[], limit = 18): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const game of games) {
    for (const genre of game.genres) {
      if (!genre || genre.toLowerCase() === "unknown") continue;
      const key = genre.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { label: genre, count: 1 });
    }
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit)
    .map((entry) => entry.label);
}
