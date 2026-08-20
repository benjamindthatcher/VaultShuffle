import type { DemoGame } from "./demo-data.ts";
import { estimatedTimeToBeatMinutes } from "./game-duration.ts";

/**
 * How much of a library the app actually knows enough about to draw well.
 *
 * An import finishes in seconds because enrichment is deferred to background
 * workers, which is architecturally right and completely invisible: the app says
 * "done" while lengths and genres arrive over the following days. That silence is
 * why a pick can say "no length estimate yet" with no explanation.
 *
 * Only the two fields the draw actually depends on are counted. Steam Deck
 * compatibility is a far longer backfill and would peg the number low for weeks
 * while telling the player nothing about their next draw.
 */
export type LibraryEnrichment = {
  total: number;
  ready: number;
  missingLength: number;
  missingGenres: number;
  percent: number;
};

export function measureLibraryEnrichment(games: DemoGame[]): LibraryEnrichment {
  const owned = games.filter((game) => game.ownership === "Owned");
  if (!owned.length) return { total: 0, ready: 0, missingLength: 0, missingGenres: 0, percent: 100 };

  let missingLength = 0;
  let missingGenres = 0;
  for (const game of owned) {
    if (!hasLength(game)) missingLength += 1;
    if (!hasGenres(game)) missingGenres += 1;
  }

  const ready = owned.filter((game) => hasLength(game) && hasGenres(game)).length;
  return {
    total: owned.length,
    ready,
    missingLength,
    missingGenres,
    percent: Math.round((ready / owned.length) * 100)
  };
}

/** Endless games have no estimate by nature, which is knowledge rather than a gap. */
function hasLength(game: DemoGame) {
  if (game.duration?.endless) return true;
  return Boolean(estimatedTimeToBeatMinutes(game.duration));
}

function hasGenres(game: DemoGame) {
  return game.genres.some((genre) => genre && genre.toLowerCase() !== "unknown");
}
