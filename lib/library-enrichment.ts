import type { DemoGame } from "./demo-data.ts";

/**
 * How many games are genuinely still being processed.
 *
 * This used to count games with no duration at all, which conflated two
 * completely different things. A game can be missing a length because the
 * catalogue has not looked yet, or because it looked and there is nothing to
 * find — an endless game has no campaign length, and plenty of obscure titles
 * are in no duration database at all. Reporting the second as "still filling in"
 * is untrue, never resolves, and hands the player a number they can do nothing
 * about.
 *
 * Only work actually in flight counts. Once the queue drains this reports zero
 * and the banner disappears, which is the honest end state.
 */
export type LibraryEnrichment = {
  total: number;
  /** Games with catalogue work still queued or running. */
  processing: number;
  ready: number;
  percent: number;
};

const IN_FLIGHT = new Set(["pending", "processing"]);

export function measureLibraryEnrichment(games: DemoGame[]): LibraryEnrichment {
  const owned = games.filter((game) => game.ownership === "Owned");
  if (!owned.length) return { total: 0, processing: 0, ready: 0, percent: 100 };

  const processing = owned.filter(isProcessing).length;
  const ready = owned.length - processing;
  return {
    total: owned.length,
    processing,
    ready,
    percent: Math.round((ready / owned.length) * 100)
  };
}

function isProcessing(game: DemoGame) {
  if (IN_FLIGHT.has(String(game.durationStatus ?? ""))) return true;
  if (IN_FLIGHT.has(String(game.tagsStatus ?? ""))) return true;
  // A freshly imported game has no catalogue row yet, so nothing has a status and
  // it has no genres either — that is genuinely still on its way.
  const unknownGenres = !game.genres.some((genre) => genre && genre.toLowerCase() !== "unknown");
  return unknownGenres && !game.durationStatus && !game.tagsStatus;
}
