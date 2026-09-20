import { getSupabaseAdmin } from "@/lib/supabase";

/**
 * The data behind a blog post's game table.
 *
 * A post declares what it wants; this fetches it at build time. The point is
 * that a list like "Deck-Verified games under ten hours" stays correct after
 * the nightly workers move a duration or Valve changes a Deck rating, which a
 * hand-typed list in the prose cannot.
 *
 * Deck ratings follow the same numbering the app filters on
 * (see lib/global-filters.ts): 3 Verified, 2 Playable, 1 Unsupported,
 * 0 or null Unknown.
 *
 * On cost: there is no index that serves these filter combinations, so every
 * query here is a sequential scan of the catalogue - about 130ms, which is the
 * floor and is fine at build time. What is not fine is the payload. `tags` is
 * a jsonb object per row, and selecting it pushed the row width from 162 to
 * 510 and the same query from 588ms to over two seconds, which PostgREST's 8s
 * statement timeout then failed on once serialisation was added. So `tags` is
 * requested only when a filter actually needs it, and the over-fetch that
 * covers post-query filtering is kept tight.
 */

/**
 * The AppIDs the quarantine has ruled are not games.
 *
 * `lib/catalogue-classification.ts` owns that decision and the verdicts live in
 * catalog_game_quarantine. Only `excluded` hides anything: `pending` is a flag
 * for a person and deliberately fails open, and `allowed` is a manual override
 * saying a rule got it wrong. See docs/catalogue-quarantine.md.
 *
 * In practice the review-count floors on these lists already keep DLC, demos
 * and soundtracks out - none of them reach 500 Steam reviews, and a check found
 * zero excluded AppIDs in the Deck list. This is the rule rather than the luck,
 * so a future post with a lower floor does not quietly ship a soundtrack.
 *
 * Fetched once per process and held. PostgREST caps a response at 1000 rows and
 * there are about 2,800 of these, so it pages until a short page arrives.
 */
let excludedAppIds: Promise<Set<number>> | null = null;

function loadExcludedAppIds(): Promise<Set<number>> {
  excludedAppIds ??= (async () => {
    const supabase = getSupabaseAdmin();
    const pageSize = 1000;
    const excluded = new Set<number>();

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("catalog_game_quarantine")
        .select("steam_appid")
        .eq("review_status", "excluded")
        .range(from, from + pageSize - 1);

      if (error) throw new Error(`Blog quarantine query failed: ${error.message}`);

      const rows = (data ?? []) as { steam_appid: number }[];
      for (const row of rows) excluded.add(row.steam_appid);
      if (rows.length < pageSize) break;
    }

    return excluded;
  })();

  return excludedAppIds;
}

export const DECK_VERIFIED = 3;
export const DECK_PLAYABLE = 2;

export type GameListFilter = {
  /** Verified only, or Verified and Playable together. */
  deck?: "verified" | "playable-or-better";
  /** Almost always "finite" - an endless game cannot belong on a list about finishing things. */
  durationKind?: "finite" | "endless";
  /** Inclusive bounds on the HowLongToBeat main story, in hours. */
  mainStoryHours?: readonly [number, number];
  /** Steam review count floor. Keeps test builds and asset flips out. */
  minReviews?: number;
  /** Share of positive Steam reviews, 0-1. Applied after the query - see below. */
  minPositive?: number;
  /** Restrict to a Steam tag, e.g. "Horror". Costs the jsonb column. */
  tag?: string;
  playerMode?: "single" | "coop" | "multi";
  limit?: number;
};

export type GameListRow = {
  appid: number;
  name: string;
  headerUrl: string | null;
  mainStoryHours: number | null;
  completionistHours: number | null;
  deckCompatibility: number | null;
  reviewTotal: number;
  positiveShare: number;
  playerMode: string | null;
  releaseYear: number | null;
};

const DISPLAY_COLUMNS = [
  "steam_appid", "name", "header_url", "main_story_minutes", "completionist_minutes",
  "deck_compatibility", "review_total", "review_positive", "player_mode", "release_date"
].join(",");

/** Enough to apply the post-query filters and count, and nothing else. */
const COUNT_COLUMNS = "steam_appid,review_total,review_positive";

/** The ceiling on a count. Above this a post should say "over N" anyway. */
const COUNT_CEILING = 2000;

type CatalogueRow = {
  steam_appid: number;
  name: string | null;
  header_url: string | null;
  main_story_minutes: number | null;
  completionist_minutes: number | null;
  deck_compatibility: number | null;
  review_total: number | null;
  review_positive: number | null;
  player_mode: string | null;
  release_date: string | null;
  tags?: Record<string, number> | null;
};

type PostFilterRow = Pick<CatalogueRow, "steam_appid" | "review_total" | "review_positive" | "tags">;

/**
 * Only the builder methods this file uses.
 *
 * Typed as a local shape rather than as PostgrestFilterBuilder for two
 * reasons: @supabase/postgrest-js is a transitive dependency of
 * @supabase/supabase-js, so importing from it breaks on any hoisting change;
 * and a generic bounded by itself (`T extends Filterable<T>`) makes the
 * compiler give up on the builder's own generics with "type instantiation is
 * excessively deep". One cast at the call site, and the chain is typed after.
 */
type CatalogueQuery = {
  not(column: string, operator: string, value: unknown): CatalogueQuery;
  eq(column: string, value: unknown): CatalogueQuery;
  gte(column: string, value: unknown): CatalogueQuery;
  lte(column: string, value: unknown): CatalogueQuery;
  order(column: string, options: { ascending: boolean }): CatalogueQuery;
  limit(count: number): PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>;
};

function columnsFor(base: string, filter: GameListFilter): string {
  return filter.tag ? `${base},tags` : base;
}

function applyFilters(query: CatalogueQuery, filter: GameListFilter): CatalogueQuery {
  let next = query.not("name", "is", null).not("header_url", "is", null);

  if (filter.durationKind) next = next.eq("duration_kind", filter.durationKind);
  if (filter.minReviews) next = next.gte("review_total", filter.minReviews);
  if (filter.playerMode) next = next.eq("player_mode", filter.playerMode);

  if (filter.deck === "verified") next = next.eq("deck_compatibility", DECK_VERIFIED);
  if (filter.deck === "playable-or-better") next = next.gte("deck_compatibility", DECK_PLAYABLE);

  if (filter.mainStoryHours) {
    const [low, high] = filter.mainStoryHours;
    next = next
      .gte("main_story_minutes", Math.round(low * 60))
      .lte("main_story_minutes", Math.round(high * 60));
  }

  return next;
}

/**
 * Two things cannot be expressed as PostgREST filters: the positive-review
 * share, which is a ratio of two columns, and tag membership, which lives in a
 * jsonb object keyed by tag name.
 */
function passesPostFilters(row: PostFilterRow, filter: GameListFilter): boolean {
  const total = row.review_total ?? 0;
  if (total <= 0) return false;
  if (filter.minPositive && (row.review_positive ?? 0) / total < filter.minPositive) return false;
  if (filter.tag && !(row.tags && filter.tag in row.tags)) return false;
  return true;
}

function hours(minutes: number | null): number | null {
  return minutes === null ? null : Math.round((minutes / 60) * 10) / 10;
}

export async function fetchGameList(filter: GameListFilter): Promise<GameListRow[]> {
  const limit = filter.limit ?? 40;
  const supabase = getSupabaseAdmin();
  const excluded = await loadExcludedAppIds();

  const query = applyFilters(
    supabase.from("catalog_games").select(columnsFor(DISPLAY_COLUMNS, filter)) as unknown as CatalogueQuery,
    filter
  );

  // Room for what the ratio and the tag remove, without dragging the payload.
  const needsPostFilter = Boolean(filter.minPositive || filter.tag);
  const overFetch = needsPostFilter ? Math.min(limit * 4, 400) : limit;

  const { data, error } = await query.order("review_total", { ascending: false }).limit(overFetch);
  if (error) throw new Error(`Blog game list query failed: ${error.message}`);

  return ((data ?? []) as unknown as CatalogueRow[])
    .filter((row) => !excluded.has(row.steam_appid) && passesPostFilters(row, filter))
    .slice(0, limit)
    .map((row) => ({
      appid: row.steam_appid,
      name: row.name as string,
      headerUrl: row.header_url,
      mainStoryHours: hours(row.main_story_minutes),
      completionistHours: hours(row.completionist_minutes),
      deckCompatibility: row.deck_compatibility,
      reviewTotal: row.review_total ?? 0,
      positiveShare: (row.review_positive ?? 0) / (row.review_total || 1),
      playerMode: row.player_mode,
      releaseYear: row.release_date ? Number(row.release_date.slice(0, 4)) : null
    }));
}

/**
 * How many games qualify, which is the claim a post's prose makes.
 *
 * Deliberately a second query rather than a count of the display rows: with
 * two narrow columns the same scan returns every match in about 130ms, so the
 * number is exact instead of being capped at whatever the table shows.
 *
 * `capped` matters. There is no ORDER BY here - ordering would only cost time
 * for a number - so if the filters ever match more than COUNT_CEILING rows,
 * the rows that come back are an arbitrary subset and `count` is a floor, not
 * a total. A post must say "over N" in that case rather than printing a
 * confident wrong number.
 */
export async function countGameList(
  filter: GameListFilter
): Promise<{ count: number; capped: boolean }> {
  const supabase = getSupabaseAdmin();
  const excluded = await loadExcludedAppIds();

  const query = applyFilters(
    supabase.from("catalog_games").select(columnsFor(COUNT_COLUMNS, filter)) as unknown as CatalogueQuery,
    filter
  );

  const { data, error } = await query.limit(COUNT_CEILING);
  if (error) throw new Error(`Blog game count query failed: ${error.message}`);

  const rows = (data ?? []) as unknown as PostFilterRow[];

  return {
    count: rows.filter((row) => !excluded.has(row.steam_appid) && passesPostFilters(row, filter)).length,
    capped: rows.length >= COUNT_CEILING
  };
}

/**
 * Live catalogue data for a fixed set of AppIDs.
 *
 * For the hand-written picks at the top of a list post. IGN can write a
 * paragraph per game because its lists are typed by hand; ours are queries, so
 * prose about a game that later drops out of the filter would be left stranded.
 * The split is: the opinion is written and stays put, the numbers beside it come
 * from the catalogue on every build.
 *
 * `qualifies` is the guard. It says whether the pick still passes the post's own
 * filter, so a post can drop a pick that no longer belongs rather than printing
 * a recommendation the list beneath it contradicts.
 */
export async function fetchPicks(
  appids: readonly number[],
  filter: GameListFilter
): Promise<Map<number, GameListRow & { qualifies: boolean }>> {
  const supabase = getSupabaseAdmin();
  const excluded = await loadExcludedAppIds();

  const { data, error } = await supabase
    .from("catalog_games")
    .select(DISPLAY_COLUMNS)
    .in("steam_appid", [...appids]);

  if (error) throw new Error(`Blog picks query failed: ${error.message}`);

  const qualifying = new Set(
    (await fetchGameList({ ...filter, limit: 600 })).map((row) => row.appid)
  );

  const picks = new Map<number, GameListRow & { qualifies: boolean }>();

  for (const row of (data ?? []) as unknown as CatalogueRow[]) {
    if (excluded.has(row.steam_appid)) continue;
    picks.set(row.steam_appid, {
      appid: row.steam_appid,
      name: row.name as string,
      headerUrl: row.header_url,
      mainStoryHours: hours(row.main_story_minutes),
      completionistHours: hours(row.completionist_minutes),
      deckCompatibility: row.deck_compatibility,
      reviewTotal: row.review_total ?? 0,
      positiveShare: (row.review_positive ?? 0) / (row.review_total || 1),
      playerMode: row.player_mode,
      releaseYear: row.release_date ? Number(row.release_date.slice(0, 4)) : null,
      qualifies: qualifying.has(row.steam_appid)
    });
  }

  return picks;
}

export function deckLabel(rating: number | null): string {
  if (rating === DECK_VERIFIED) return "Verified";
  if (rating === DECK_PLAYABLE) return "Playable";
  if (rating === 1) return "Unsupported";
  return "Unknown";
}
