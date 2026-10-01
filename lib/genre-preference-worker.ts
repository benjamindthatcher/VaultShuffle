import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import {EVENT_SIGNALS,LIBRARY_SIGNALS,withOverrides,foldGenreLearning,addGameTally} from "./genre-learning-model.ts";
import { canonicalPreferenceGenre, capDecisionsPerUser, parseAlgorithmWeight, playtimeTally, preferenceGenresFor, type GenrePreference } from "@/lib/genre-preferences";
import { steamTagGenreLabels } from "@/lib/genres";
import { isFamilyAccess, type AccessSource } from "@/lib/family-sharing";
import type { VaultDrawEventType } from "@/lib/vault-history";
import type { VaultMoodId } from "@/lib/demo-data";

/**
 * Only draws from the last six months count. A preference the user has grown out
 * of should fade rather than be argued with forever, and a bounded window also
 * keeps the nightly rebuild cheap as the table grows.
 */
const LOOKBACK_DAYS = 180;

/**
 * Playing a game is an opinion nobody had to state.
 *
 * Decisions and draw reactions only exist where someone stopped to give one, and
 * a game released last week has neither - nor enough reviews for its own merits
 * to say much. Hours are the signal that is always there: 8,051 games have two
 * or more players with real time in them, against 3,641 with any decision.
 *
 * Weak on purpose. It is inferred rather than said, so it nudges a game the
 * evidence has not reached yet and gets out of the way once that evidence
 * arrives.
 *
 * Two hours is the floor for endorsement: from there a game reads as endorsed in
 * proportion to the time given, bouncing off at two counting against it and
 * twenty counting fully for it.
 *
 * Below the floor still counts, against the game. One person owning something
 * unopened says nothing - that is the normal state of a backlog and the reason
 * this product exists - but three hundred people owning it unopened is not a
 * backlog, it is a verdict, and it was the loudest thing in the database that
 * nothing was listening to. Half-Life Deathmatch: Source has 349 owners here and
 * not one has ever launched it; For Honor's public test client has 136 and
 * scored exactly zero, an ordinary candidate, because it had never been drawn.
 *
 * Never-opened is weighted below launched-and-abandoned, because "not got to it
 * yet" is a real second explanation for silence and no explanation at all for
 * someone quitting after twenty minutes. Both are weak per row on purpose and
 * arrive in enough volume to matter, which is what the shrinkage is for: at five
 * owners a game stays near the population average, and by fifty it is being
 * judged on what people did with it.
 */
const PLAYTIME_WEIGHT = 0.5;
const PLAYTIME_UNPLAYED_WEIGHT = 0.25;

/** PostgREST caps a response at 1,000 rows, so every unbounded read pages. */
const DECISION_PAGE_SIZE = 1000;

/** Taste drifts, so evidence loses half its weight every this many days. */


type Signal = {
  positive: number;
  total: number;
  /** Mood-scoped only: says nothing about the genre in general. */
  moodOnly?: boolean;
};

/**
 * How loudly each event speaks, and about what.
 *
 * The reroll reasons matter more than the reroll itself. A game rerolled for
 * being too long says nothing about its genre — it says the session estimate was
 * wrong — so counting it as a genre negative actively teaches the model the wrong
 * lesson. Only "not interested" is a real statement about taste; "wrong mood" is a
 * statement about this context and is recorded against the mood row alone.
 *
 * Weights are relative, and get scaled by recency before they are accumulated.
 */
/**
 * The weights the recommender runs at, unless the database says otherwise.
 *
 * These are the fallback, not the source of truth: algorithm_weights carries the
 * live values so they can be tuned with an update statement and a nightly run
 * rather than a deploy. Kept here so a rebuild still works if that table is
 * unreachable, and so the intended shape is readable in one place.
 */
/**
 * Live weights, read once per rebuild.
 *
 * A key is "event:<draw event>", "decision:<action>" or "playtime:per_owner".
 * Anything the table does not name keeps the fallback above, so a partial table
 * is safe and a typo cannot silently zero a signal.
 */
async function loadWeightOverrides(supabase: AdminClient) {
  const overrides = new Map<string, Signal>();
  try {
    const { data, error } = await supabase
      .from("algorithm_weights")
      .select("key, positive, total");
    if (error) throw error;

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(row.key);
      const weight = parseAlgorithmWeight(row.positive, row.total);
      // Says so rather than skipping quietly. A tuning value that is silently
      // ignored is indistinguishable from one that is working, which is the
      // failure that costs an afternoon.
      if (!weight) {
        console.warn(JSON.stringify({
          level: "warning",
          message: "Ignoring an out-of-range algorithm weight; using the built-in default",
          key,
          positive: row.positive,
          total: row.total
        }));
        continue;
      }
      overrides.set(key, weight);
    }
  } catch (error) {
    // The fallback weights are a working recommender. Failing the whole rebuild
    // because the tuning table could not be read would be the worse outcome.
    console.warn(JSON.stringify({
      level: "warning",
      message: "Could not load algorithm weights; using built-in defaults",
      detail: error instanceof Error ? error.message : String(error)
    }));
  }
  return overrides;
}

/**
 * Reasons that describe something other than genre. Present so they are visibly
 * considered and deliberately unused, rather than looking like an oversight.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documentation: see the comment above.
const NON_GENRE_REASONS: VaultDrawEventType[] = [
  "reroll_too_long",
  "reroll_not_tonight",
  "reroll_played_enough"
];

type DrawRow = {
  id: string;
  user_id: string;
  steam_appid: number | string;
  mood: VaultMoodId | null;
};

type EventRow = { draw_id: string; event_type: string; created_at: string };
type LibraryDecision = { userId: string; steamAppId: number; action: string; reviewedAt: string };
type PlayingNextCommitment = { userId: string; steamAppId: number; pinnedAt: string };


/**
 * Current Library outcomes. Playing Next is learned from the draw's pin event;
 * removing or replacing a slot is not a second vote against its old occupant.
 */
/**
 * The most decisions any one account contributes to a rebuild.
 *
 * The completion sweep is built for clearing a backlog in bulk: the median
 * account has marked 21 games, one has marked 443. Ungated, that single account
 * outweighs twenty ordinary ones in the population view, and the taste it
 * describes is a weekend of tidying rather than twenty people's preferences.
 * Newest first, so what survives the cap is what they think now.
 */
const MAX_DECISIONS_PER_USER = 50;
type CatalogRow = { steam_appid: number | string; name: string | null; genres: string[] | null; tags: Record<string, number> | null };
type Tally = { positive: number; total: number };

export type GenrePreferenceRebuildSummary = {
  draws: number;
  events: number;
  scoredEvents: number;
  libraryDecisions: number;
  playingNextCommitments: number;
  users: number;
  rows: number;
  globalRows: number;
  gameRows: number;
  playtimeRows: number;
  deletedRows: number;
};

/**
 * Recomputes every user's genre preferences from scratch.
 *
 * A full rebuild rather than an incremental update: the whole input is one bounded
 * query, and rebuilding is idempotent, so a retried or double-fired cron cannot
 * double-count a like into a preference that was never earned.
 */
export async function rebuildGenrePreferences(): Promise<GenrePreferenceRebuildSummary> {
  const supabase = getSupabaseAdmin();
  const weightOverrides = await loadWeightOverrides(supabase);
  const eventSignals = withOverrides(EVENT_SIGNALS as Record<string, Signal>, "event", weightOverrides);
  const decisionSignals = withOverrides(LIBRARY_SIGNALS, "decision", weightOverrides);
  const playtimeWeight = weightOverrides.get("playtime:per_owner")?.total ?? PLAYTIME_WEIGHT;
  const unplayedWeight = weightOverrides.get("playtime:per_unplayed_owner")?.total ?? PLAYTIME_UNPLAYED_WEIGHT;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // Paged explicitly. PostgREST caps a response at 1,000 rows and says nothing
  // about it, so this returned exactly 1,000 of the 2,064 draws in the window and
  // the learner had been training on less than half its evidence - silently, and
  // getting worse with every draw the product takes.
  const draws: DrawRow[] = [];
  for (let offset = 0; ; offset += DECISION_PAGE_SIZE) {
    const { data: drawData, error: drawError } = await supabase
      .from("vault_draws")
      .select("id, user_id, steam_appid, mood")
      .gte("drawn_at", since)
      .order("drawn_at", { ascending: false })
      .range(offset, offset + DECISION_PAGE_SIZE - 1);
    if (drawError) throw drawError;

    const page = (drawData ?? []) as DrawRow[];
    draws.push(...page);
    if (page.length < DECISION_PAGE_SIZE) break;
  }
  const summary: GenrePreferenceRebuildSummary = {
    draws: draws.length,
    events: 0,
    scoredEvents: 0,
    libraryDecisions: 0,
    playingNextCommitments: 0,
    users: 0,
    rows: 0,
    globalRows: 0,
    gameRows: 0,
    playtimeRows: 0,
    deletedRows: 0
  };
  const drawsById = new Map(draws.map((draw) => [draw.id, draw]));
  const events = draws.length ? await fetchEvents(supabase, [...drawsById.keys()]) : [];
  summary.events = events.length;

  const libraryDecisions = await fetchLibraryDecisions(supabase, since);
  summary.libraryDecisions = libraryDecisions.length;
  const playingNextCommitments = await fetchPlayingNextCommitments(supabase, since);
  summary.playingNextCommitments = playingNextCommitments.length;
  if (!events.length && !libraryDecisions.length && !playingNextCommitments.length) return summary;

  const genresByAppId = await fetchGenres(supabase, [
    ...draws.map((draw) => Number(draw.steam_appid)),
    ...libraryDecisions.map((decision) => decision.steamAppId),
    ...playingNextCommitments.map((commitment) => commitment.steamAppId)
  ]);

  const folded=foldGenreLearning({draws,events,libraryDecisions,playingNextCommitments,genresByAppId,eventSignals,decisionSignals});
  const {rows,gameTallies}=folded;
  Object.assign(summary,folded.summary);

  summary.deletedRows = await replacePreferences(supabase, rows);
  summary.globalRows = await replaceGlobals(supabase, rows);
  const gameHours = new Map<number, number>();
  summary.playtimeRows = await addPlaytimeSignal(supabase, gameTallies, gameHours, playtimeWeight, unplayedWeight);
  summary.gameRows = await replaceGameGlobals(supabase, gameTallies, gameHours, new Date().toISOString());
  return summary;
}

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

/** Chunked because `in` lists are sent as a URL filter and long ones get rejected. */
async function fetchEvents(supabase: AdminClient, drawIds: string[]) {
  const events: EventRow[] = [];
  for (let index = 0; index < drawIds.length; index += 200) {
    const { data, error } = await supabase
      .from("vault_draw_events")
      .select("draw_id, event_type, created_at")
      .in("draw_id", drawIds.slice(index, index + 200));
    if (error) throw error;
    events.push(...((data ?? []) as EventRow[]));
  }
  return events;
}

/**
 * The population's view of each individual game.
 *
 * Written whole and then swept, like the genre globals: a game whose evidence
 * has all aged out of the window must stop being judged on it rather than keep
 * a verdict nobody is making any more.
 */
async function replaceGameGlobals(
  supabase: AdminClient,
  tallies: Map<number, Tally>,
  hours: Map<number, number>,
  rebuiltAt: string
) {
  const rows = [...tallies.entries()].map(([steamAppId, tally]) => ({
    steam_appid: steamAppId,
    positive: tally.positive,
    total: tally.total,
    total_hours: hours.get(steamAppId) ?? 0,
    updated_at: rebuiltAt
  }));

  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await supabase
      .from("game_preference_globals")
      .upsert(rows.slice(index, index + 500), { onConflict: "steam_appid" });
    if (error) throw error;
  }

  const { error: deleteError } = await supabase
    .from("game_preference_globals")
    .delete()
    .lt("updated_at", rebuiltAt);
  if (deleteError) throw deleteError;

  return rows.length;
}

/**
 * Fold everyone's hours into the per-game view.
 *
 * Walked by cursor rather than by offset, which is the whole difference between
 * this read working and this read failing. `range()` compiles to OFFSET, and an
 * offset does not skip rows, it reads and discards them: measured on the live
 * table, one page at offset 320,000 took 8.15 seconds and touched 322,686
 * buffers. The same page fetched as `id > last` is an index scan on the primary
 * key - 27ms and 1,008 buffers, three hundred times cheaper.
 *
 * This is the largest read the rebuild makes, and it got three times larger when
 * it started counting every owned row rather than only the played ones, so the
 * tail pages went from expensive to over the database's statement timeout. It
 * failed with 57014 in production after succeeding twice on luck. Fetching those
 * pages concurrently made it worse rather than better: the cost was never the
 * round trips, it was each query re-scanning the table, and eight of them at
 * once simply arrived at the timeout together.
 *
 * The cursor is the primary key, so the walk is total and cannot repeat or skip a
 * row the way an offset can when rows are inserted mid-read - and inserts during
 * this read are normal, because people are importing libraries while it runs.
 */
async function addPlaytimeSignal(
  supabase: AdminClient,
  gameTallies: Map<number, Tally>,
  gameHours: Map<number, number>,
  playtimeWeight: number,
  unplayedWeight: number
) {
  let counted = 0;
  let cursor: string | null = null;

  for (;;) {
    let page = supabase
      .from("user_games")
      // Every owned row, not just the played ones. Reading only past the two-hour
      // floor meant the rebuild never saw the games nobody starts, which are the
      // ones people write in about.
      .select("id, catalog_steam_appid, hours_played, access_source")
      .not("catalog_steam_appid", "is", null)
      .order("id")
      .limit(DECISION_PAGE_SIZE);
    if (cursor) page = page.gt("id", cursor);

    const { data, error } = await page;
    if (error) throw error;

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (!rows.length) break;

    for (const row of rows) {
      const steamAppId = Number(row.catalog_steam_appid);
      if (!Number.isFinite(steamAppId) || steamAppId <= 0) continue;
      // A family row's hours are the owner's, not the borrower's, and a zero on
      // an inferred row means "never told" rather than "never played" - which is
      // the one thing this signal must not confuse. See lib/family-sharing.ts.
      if (isFamilyAccess(row.access_source as AccessSource | null)) continue;

      const hours = Number(row.hours_played ?? 0);
      if (!Number.isFinite(hours) || hours < 0) continue;

      const tally = playtimeTally(hours, playtimeWeight, unplayedWeight);
      addGameTally(gameTallies, steamAppId, tally.positive, tally.total);

      // The hours themselves, not a rate. A rate cannot tell 50,000 hours from
      // 5,000 - it is capped at 1 either way - which is why popularity needs an
      // absolute number of its own. Every hour counts here, including the ones
      // below the endorsement floor: someone bounced off at 30 minutes still
      // says the game is played.
      gameHours.set(steamAppId, (gameHours.get(steamAppId) ?? 0) + hours);
      counted += 1;
    }

    cursor = String(rows[rows.length - 1].id);
    if (rows.length < DECISION_PAGE_SIZE) break;
  }

  return counted;
}

async function fetchGenres(supabase: AdminClient, appIds: number[]) {
  const unique = [...new Set(appIds.filter((appId) => Number.isFinite(appId)))];
  const genresByAppId = new Map<number, string[]>();

  for (let index = 0; index < unique.length; index += 200) {
    const { data, error } = await supabase
      .from("catalog_games")
      .select("steam_appid, name, genres, tags")
      .in("steam_appid", unique.slice(index, index + 200));
    if (error) throw error;

    for (const row of (data ?? []) as CatalogRow[]) {
      // The same labels the client builds in normaliseGenres: the stored genres
      // plus the game's Steam tags. Without the tags this side, widening the key
      // set did nothing here - the worker was still handing it the eight coarse
      // genre strings, so it learned eight coarse keys and the scorer looked up
      // sharp ones that had never been written.
      const labels = [...(row.genres ?? []), ...steamTagGenreLabels(row.tags, 8)];
      const genres = preferenceGenresFor(labels, row.name ?? "")
        .map(canonicalPreferenceGenre);
      if (genres.length) genresByAppId.set(Number(row.steam_appid), genres);
    }
  }

  return genresByAppId;
}

/**
 * Rows are upserted before the stale ones are deleted, so a user's preferences are
 * never briefly empty — a draw landing mid-rebuild sees the old numbers rather
 * than none.
 */
async function replacePreferences(
  supabase: AdminClient,
  rows: Array<{ user_id: string; genre: string; context_mood: string; positive: number; total: number; updated_at: string }>
) {
  const rebuiltAt = new Date().toISOString();

  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await supabase
      .from("user_genre_preferences")
      .upsert(rows.slice(index, index + 500).map((row) => ({ ...row, updated_at: rebuiltAt })), {
        onConflict: "user_id,genre,context_mood"
      });
    if (error) throw error;
  }

  // Swept across every user, not just the ones rebuilt: a user whose signals have
  // all aged out of the window drops out of `rows` entirely, and scoping the
  // delete to rebuilt users would leave their stale preferences in place forever.
  const { data: staleRows, error: deleteError } = await supabase
    .from("user_genre_preferences")
    .delete()
    .lt("updated_at", rebuiltAt)
    .select("user_id");
  if (deleteError) throw deleteError;
  const deleted = (staleRows ?? []).length;

  return deleted;
}

/**
 * Reads one user's learned preferences for the bootstrap payload. Returns an empty
 * list rather than throwing: a preference is an enhancement, and failing to load it
 * must never stop the Vault from drawing.
 */
export async function listGenrePreferences(userId: string): Promise<GenrePreference[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("user_genre_preferences")
      .select("genre, context_mood, positive, total")
      .eq("user_id", userId);
    if (error) throw error;

    return (data ?? []).map((row) => ({
      genre: String(row.genre),
      contextMood: String(row.context_mood) as GenrePreference["contextMood"],
      positive: Number(row.positive) || 0,
      total: Number(row.total) || 0
    }));
  } catch (error) {
    console.error("Could not load genre preferences.", error);
    return [];
  }
}

/**
 * Aggregates every user's rows into population rates.
 *
 * These are what individual baselines are now measured against, and what a user
 * with no history of their own is served until they have some. Rates only — no
 * row here can be traced back to a person.
 */
async function replaceGlobals(
  supabase: AdminClient,
  rows: Array<{ genre: string; context_mood: string; positive: number; total: number }>
) {
  const totals = new Map<string, { positive: number; total: number }>();
  for (const row of rows) {
    const key = `${row.context_mood}::${row.genre}`;
    const tally = totals.get(key) ?? { positive: 0, total: 0 };
    tally.positive += row.positive;
    tally.total += row.total;
    totals.set(key, tally);
  }

  const rebuiltAt = new Date().toISOString();
  const globalRows = [...totals.entries()].map(([key, tally]) => {
    const separator = key.indexOf("::");
    return {
      context_mood: key.slice(0, separator),
      genre: key.slice(separator + 2),
      positive: Number(tally.positive.toFixed(4)),
      total: Number(tally.total.toFixed(4)),
      updated_at: rebuiltAt
    };
  });

  if (globalRows.length) {
    const { error } = await supabase
      .from("genre_preference_globals")
      .upsert(globalRows, { onConflict: "genre,context_mood" });
    if (error) throw error;
  }

  const { error: deleteError } = await supabase
    .from("genre_preference_globals")
    .delete()
    .lt("updated_at", rebuiltAt);
  if (deleteError) throw deleteError;

  return globalRows.length;
}

/** Population rates for the bootstrap payload. Empty on failure, like the rest. */
/**
 * The population's verdict on specific games, for the games one player owns.
 *
 * Scoped to their library rather than sent whole: the table covers about 25,000 games
 * and a payload of all of them would dwarf the library it is describing. Read
 * for the games that could actually be drawn, and nothing else.
 *
 * Returned as a plain tuple map so the wire form stays small - this rides along
 * with every app-data response.
 */
export async function listGamePreferenceGlobals(steamAppIds: number[]): Promise<Record<string, [number, number, number]>> {
  const unique = [...new Set(steamAppIds.filter((appId) => Number.isFinite(appId) && appId > 0))];
  if (!unique.length) return {};

  const rates: Record<string, [number, number, number]> = {};
  try {
    for (let index = 0; index < unique.length; index += 200) {
      const { data, error } = await getSupabaseAdmin()
        .from("game_preference_globals")
        .select("steam_appid, positive, total, total_hours")
        .in("steam_appid", unique.slice(index, index + 200));
      if (error) throw error;

      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        rates[String(row.steam_appid)] = [
          Number(row.positive) || 0,
          Number(row.total) || 0,
          Number(row.total_hours) || 0
        ];
      }
    }
    return rates;
  } catch (error) {
    // A missing verdict is the normal case for most games, so failing to read
    // them is not a reason to fail the request: the scorer falls back to what
    // each game is on its own.
    console.error("Could not load global game preferences.", error);
    return {};
  }
}

export async function listGenrePreferenceGlobals(): Promise<GenrePreference[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("genre_preference_globals")
      .select("genre, context_mood, positive, total");
    if (error) throw error;

    return (data ?? []).map((row) => ({
      genre: String(row.genre),
      contextMood: String(row.context_mood) as GenrePreference["contextMood"],
      positive: Number(row.positive) || 0,
      total: Number(row.total) || 0
    }));
  } catch (error) {
    console.error("Could not load global genre preferences.", error);
    return [];
  }
}

async function fetchPlayingNextCommitments(supabase: AdminClient, since: string): Promise<PlayingNextCommitment[]> {
  const commitments: PlayingNextCommitment[] = [];
  for (let offset = 0; ; offset += DECISION_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("user_game_pins")
      .select("user_id, pinned_at, user_games!inner(catalog_steam_appid)")
      .eq("scope", "library")
      .gte("pinned_at", since)
      .order("pinned_at", { ascending: false })
      .range(offset, offset + DECISION_PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const game = row.user_games as Record<string, unknown> | null;
      const steamAppId = Number(game?.catalog_steam_appid);
      if (!Number.isFinite(steamAppId) || steamAppId <= 0 || typeof row.pinned_at !== "string") continue;
      commitments.push({ userId: String(row.user_id), steamAppId, pinnedAt: row.pinned_at });
    }
    if (rows.length < DECISION_PAGE_SIZE) break;
  }
  return commitments;
}

/**
 * The standing Library outcome for each game, resolved to a Steam AppID.
 *
 * Only the most recent Blacklist or Complete outcome per game counts.
 */
async function fetchLibraryDecisions(supabase: AdminClient, since: string): Promise<LibraryDecision[]> {
  // Read from the ownership row, not from purge_reviews.
  //
  // purge_reviews was written by one page, and that page is gone: sleeping and
  // finishing happen in the Library now. Both verdicts are already recorded on
  // user_games as the timestamp of the decision, so reading them here means the
  // learner keeps its strongest negative signal, costs no extra write on the
  // action itself, and counts a decision wherever in the app it was made.
  //
  // The catalogue AppID is on this row too, so the second lookup that
  // purge_reviews needed to turn a game id into genres is gone with it.
  const latest = new Map<string, LibraryDecision>();

  for (const [column, action] of [["slept_at", "sleep"], ["completed_at", "complete"]] as const) {
    // Paged explicitly: PostgREST caps a response at 1,000 rows, and a night's
    // worth of decisions across every account can pass that without erroring.
    for (let offset = 0; ; offset += DECISION_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("user_games")
        .select(`user_id, catalog_steam_appid, ${column}`)
        .gte(column, since)
        .order(column, { ascending: false })
        .range(offset, offset + DECISION_PAGE_SIZE - 1);
      if (error) throw error;

      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const steamAppId = Number(row.catalog_steam_appid);
        const decidedAt = row[column];
        if (!Number.isFinite(steamAppId) || steamAppId <= 0 || typeof decidedAt !== "string") continue;

        // One verdict per game per user: a game that was slept and later
        // finished should teach the later of the two, not both.
        const key = `${String(row.user_id)}::${steamAppId}`;
        const held = latest.get(key);
        if (held && held.reviewedAt >= decidedAt) continue;
        latest.set(key, {
          userId: String(row.user_id),
          steamAppId,
          action,
          reviewedAt: decidedAt
        });
      }

      if (rows.length < DECISION_PAGE_SIZE) break;
    }
  }

  return capDecisionsPerUser([...latest.values()], MAX_DECISIONS_PER_USER);
}
