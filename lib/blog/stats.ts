import statsJson from "@/data/blog/stats.json";

/**
 * Aggregates over the live library data, precomputed.
 *
 * These are counts across every owned row in user_games, and PostgREST cannot
 * aggregate - it selects, filters and orders. Doing this at build time would
 * mean either pulling 383,663 rows into the build or adding Postgres functions
 * and calling them over rpc, and rpc against a changed function silently
 * no-ops until the schema cache is reloaded. So the numbers are computed by
 * hand and checked in, with the query set recorded in
 * docs/blog-stats-refresh.md.
 *
 * The consequence to respect: every figure here is only as current as
 * generatedAt, and any post quoting one should say so in the prose.
 */

export type LibraryStats = {
  libraries: number;
  ownedRows: number;
  neverLaunched: number;
  pctNeverLaunched: number;
  pctUnderOneHour: number;
  completions: number;
};

export type CompletionBand = {
  band: string;
  started: number;
  completed: number;
  pctFinished: number;
};

export type PlayedGame = {
  name: string;
  appid: number;
  mainHours: number;
  owners: number;
  pctLaunched: number;
  medianHours: number;
  pctFinished: number;
};

export type FinishedGame = {
  name: string;
  appid: number;
  mainHours: number;
  started: number;
  pctFinished: number;
};

/** Per game figures from our own libraries, keyed by Steam AppID as a string. */
export type PickStat = {
  owners: number;
  started: number;
  pctFinished: number;
  medianHours: number;
};

export const blogStats = statsJson as {
  generatedAt: string;
  library: LibraryStats;
  catalogue: { games: number; withDurations: number; withDeckRating: number; deckVerified: number };
  completionByLength: CompletionBand[];
  mostPlayed: PlayedGame[];
  mostFinished: FinishedGame[];
  pickStats: Record<string, PickStat>;
};

export function pickStat(appid: number): PickStat | undefined {
  return blogStats.pickStats[String(appid)];
}

/** "September 2026" - the honest way to date a statistic in prose. */
export const statsAsOf = new Date(blogStats.generatedAt).toLocaleDateString("en-GB", {
  month: "long",
  year: "numeric"
});

export function formatCount(value: number): string {
  return value.toLocaleString("en-GB");
}
