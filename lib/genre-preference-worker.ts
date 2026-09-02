import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import { statesAnOpinion } from "@/lib/draw-signal-precedence";
import { ANY_MOOD_CONTEXT, BASELINE_GENRE, canonicalPreferenceGenre, capDecisionsPerUser, preferenceGenresFor, type GenrePreference } from "@/lib/genre-preferences";
import { steamTagGenreLabels } from "@/lib/genres";
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
 * Two hours is the floor: below that a game was launched and abandoned, which is
 * not a verdict either way. From there it reads as endorsement in proportion to
 * the time given - bouncing off at two hours counts against a game, twenty hours
 * counts fully for it. Owning something and never opening it says nothing at
 * all, and is not counted: that is the normal state of a backlog and the reason
 * this product exists.
 */
const PLAYTIME_WEIGHT = 0.5;
const PLAYTIME_MIN_HOURS = 2;
const PLAYTIME_FULL_HOURS = 20;

/** PostgREST caps a response at 1,000 rows, so every unbounded read pages. */
const DECISION_PAGE_SIZE = 1000;

/** Taste drifts, so evidence loses half its weight every this many days. */
const RECENCY_HALF_LIFE_DAYS = 60;

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
const EVENT_SIGNALS: Partial<Record<VaultDrawEventType, Signal>> = {
  // Launching it is the strongest thing anyone can say about a pick: they took
  // the recommendation. It used to be worth the same as a thumbs-up.
  opened_on_steam: { positive: 3, total: 3 },
  liked: { positive: 2, total: 2 },
  // Committing to play something next, which was worth half of a launch.
  pinned: { positive: 2, total: 2 },

  // Both deliberate rejections carry more than they did: these are the two
  // moments someone tells us a pick was wrong, and they were quieter than a
  // thumbs-up was loud.
  disliked: { positive: 0, total: 3 },
  // Snoozing was the most common thing anyone did with a pick - 177 of 423
  // recorded reactions - and it scored nothing at all, so the largest single
  // body of evidence the product had taught the model nothing. It is a
  // deliberate no about this game tonight, which is weaker than "Not really"
  // and stronger than clicking draw again.
  //
  // The button that produced it has since been retired in favour of the reroll,
  // so this earns from the history rather than from anything new.
  hidden_for_session: { positive: 0, total: 1.5 },
  // Sleeping a game is the most deliberate rejection the product offers: it is a
  // decision about the game itself, not about tonight.
  slept: { positive: 0, total: 4 },
  reroll_not_interested: { positive: 0, total: 2 },
  reroll_wrong_mood: { positive: 0, total: 1, moodOnly: true },

  // The bare reroll is the weakest signal there is: it is also just how the
  // product is used. It counts for something, but barely, and only when the draw
  // carries no more explicit opinion — see statesAnOpinion.
  // Doubled from 0.5: it is now the only way to reject a pick at all, since the
  // snooze button that carried 42% of every recorded reaction has been retired.
  drew_again: { positive: 0, total: 1 }
};

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
      const positive = Number(row.positive);
      const total = Number(row.total);
      if (!Number.isFinite(positive) || !Number.isFinite(total) || total < 0) continue;
      overrides.set(key, { positive, total });
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

function withOverrides<T extends Record<string, Signal>>(base: T, prefix: string, overrides: Map<string, Signal>): T {
  const merged = { ...base } as Record<string, Signal>;
  for (const name of Object.keys(base)) {
    const override = overrides.get(`${prefix}:${name}`);
    // moodOnly is a property of what the signal means, not of its strength, so
    // it is never something the tuning table gets to change.
    if (override) merged[name] = { ...base[name], ...override };
  }
  return merged as T;
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
type PurgeDecision = { userId: string; steamAppId: number; action: string; reviewedAt: string };


/**
 * How each Purge verdict reads as taste. Sleeping matches the weight a Vault
 * "slept" carries, because it is the same decision. "Keep" is a deliberate
 * retention rather than an endorsement, so it counts for half.
 */
const PURGE_SIGNALS: Record<string, { positive: number; total: number }> = {
  // Matched to the draw-side weight: sleeping is the clearest rejection there is,
  // reached deliberately through a review rather than in passing. This is the
  // signal the learner was missing entirely, so it keeps its full weight.
  sleep: { positive: 0, total: 4 },
  keep: { positive: 1, total: 2 },
  pin: { positive: 2, total: 2 },
  // Finishing something is real evidence and weaker than choosing it tonight.
  // At 2/2 it was the strongest positive the model had, and once completions
  // were read from the ownership row there were 11,494 of them against 414 draw
  // reactions - so the model was mostly learning what people had already played
  // rather than what makes a good pick, which for a discovery tool argues in a
  // circle. Counted once, not twice.
  complete: { positive: 1, total: 1 }
};

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
  purgeDecisions: number;
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
  const decisionSignals = withOverrides(PURGE_SIGNALS, "decision", weightOverrides);
  const playtimeWeight = weightOverrides.get("playtime:per_owner")?.total ?? PLAYTIME_WEIGHT;
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
    purgeDecisions: 0,
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

  const purgeDecisions = await fetchPurgeDecisions(supabase, since);
  summary.purgeDecisions = purgeDecisions.length;
  if (!events.length && !purgeDecisions.length) return summary;

  const genresByAppId = await fetchGenres(supabase, [
    ...draws.map((draw) => Number(draw.steam_appid)),
    ...purgeDecisions.map((decision) => decision.steamAppId)
  ]);

  // user -> "context::genre" -> tally
  const tallies = new Map<string, Map<string, Tally>>();
  // steam_appid -> tally, across everyone. What people do with one specific
  // game, which is the thing no amount of tag resolution can reach: the VR
  // edition and the beta demo share every tag with something worth playing.
  const gameTallies = new Map<number, Tally>();
  const eventsByDraw = new Map<string, EventRow[]>();
  for (const event of events) {
    const bucket = eventsByDraw.get(event.draw_id);
    if (bucket) bucket.push(event); else eventsByDraw.set(event.draw_id, [event]);
  }

  for (const [drawId, drawEvents] of eventsByDraw) {
    const draw = drawsById.get(drawId);
    if (!draw) continue;
    const genres = genresByAppId.get(Number(draw.steam_appid));
    if (!genres?.length) continue;

    // A stated opinion supersedes the bare reroll on the same draw. Both are
    // written for one action, and counting them together let a single rejection
    // be recorded twice while a rejection with no reason counted once.
    const hasStatedOpinion = statesAnOpinion(drawEvents.map((event) => event.event_type));

    for (const event of drawEvents) {
      const eventType = event.event_type as VaultDrawEventType;
      if (eventType === "drew_again" && hasStatedOpinion) continue;
      const signal = eventSignals[eventType];
      if (!signal) continue;

      const decay = recencyWeight(event.created_at);
      if (decay <= 0) continue;
      summary.scoredEvents += 1;

      const userTallies = tallies.get(draw.user_id) ?? new Map<string, Tally>();
      tallies.set(draw.user_id, userTallies);

      const positive = signal.positive * decay;
      const total = signal.total * decay;

      // Every signal also updates the user's own baseline, which is what each
      // genre is later measured against.
      for (const genre of [...genres, BASELINE_GENRE]) {
        if (!signal.moodOnly) addTally(userTallies, `${ANY_MOOD_CONTEXT}::${genre}`, positive, total);
        if (draw.mood) addTally(userTallies, `${draw.mood}::${genre}`, positive, total);
      }

      // Mood-scoped signals say something about the evening rather than the
      // game, so they are not evidence about the game itself.
      if (!signal.moodOnly) addGameTally(gameTallies, Number(draw.steam_appid), positive, total);
    }
  }

  // A Purge decision is the most considered signal the app collects: the player
  // was looking at one game and deliberately chose its fate. Until now none of it
  // reached the recommender - every sleep in the system happened in Purge, so the
  // learner's "slept" weight had never once fired, and the same action taught the
  // model or not depending on which page it happened on.
  for (const decision of purgeDecisions) {
    const signal = decisionSignals[decision.action];
    if (!signal) continue;
    const genres = genresByAppId.get(decision.steamAppId);
    if (!genres?.length) continue;

    const decay = recencyWeight(decision.reviewedAt);
    if (decay <= 0) continue;

    const userTallies = tallies.get(decision.userId) ?? new Map<string, Tally>();
    tallies.set(decision.userId, userTallies);

    // No mood context: a Purge decision is about the game, not about the evening
    // the player happened to be having.
    // A decision is the strongest thing said about a game: someone was looking
    // at exactly this one and chose its fate. It is the bulk of the per-game
    // evidence, and the reason unplayable editions and dead demos are visible
    // at all.
    addGameTally(gameTallies, decision.steamAppId, signal.positive * decay, signal.total * decay);

    for (const genre of [...genres, BASELINE_GENRE]) {
      addTally(userTallies, `${ANY_MOOD_CONTEXT}::${genre}`, signal.positive * decay, signal.total * decay);
    }
  }

  summary.users = tallies.size;
  const rows = [...tallies.entries()].flatMap(([userId, userTallies]) =>
    [...userTallies.entries()].map(([key, tally]) => {
      const separator = key.indexOf("::");
      return {
        user_id: userId,
        context_mood: key.slice(0, separator),
        genre: key.slice(separator + 2),
        positive: Number(tally.positive.toFixed(4)),
        total: Number(tally.total.toFixed(4)),
        updated_at: new Date().toISOString()
      };
    })
  );
  summary.rows = rows.length;

  summary.deletedRows = await replacePreferences(supabase, rows);
  summary.globalRows = await replaceGlobals(supabase, rows);
  const gameHours = new Map<number, number>();
  summary.playtimeRows = await addPlaytimeSignal(supabase, gameTallies, gameHours, playtimeWeight);
  summary.gameRows = await replaceGameGlobals(supabase, gameTallies, gameHours, new Date().toISOString());
  return summary;
}

function addTally(userTallies: Map<string, Tally>, key: string, positive: number, total: number) {
  const tally = userTallies.get(key) ?? { positive: 0, total: 0 };
  tally.positive += positive;
  tally.total += total;
  userTallies.set(key, tally);
}


/**
 * Exponential decay rather than the flat window it replaces: a 179-day-old signal
 * counting for exactly as much as yesterday's, and then nothing at all the next
 * day, is not a description of how taste changes.
 */
function recencyWeight(createdAt: string) {
  const age = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(age)) return 0;
  const ageDays = Math.max(0, age / 86_400_000);
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
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

function addGameTally(tallies: Map<number, Tally>, steamAppId: number, positive: number, total: number) {
  if (!Number.isFinite(steamAppId) || steamAppId <= 0 || total <= 0) return;
  const held = tallies.get(steamAppId);
  if (held) {
    held.positive += positive;
    held.total += total;
    return;
  }
  tallies.set(steamAppId, { positive, total });
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
 * Paged on `id` rather than the app id: paging on a non-unique column can repeat
 * or skip rows across page boundaries, and this is the largest read the rebuild
 * makes.
 */
async function addPlaytimeSignal(
  supabase: AdminClient,
  gameTallies: Map<number, Tally>,
  gameHours: Map<number, number>,
  playtimeWeight: number
) {
  let counted = 0;

  for (let offset = 0; ; offset += DECISION_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("user_games")
      .select("id, catalog_steam_appid, hours_played")
      .gte("hours_played", PLAYTIME_MIN_HOURS)
      .not("catalog_steam_appid", "is", null)
      .order("id")
      .range(offset, offset + DECISION_PAGE_SIZE - 1);
    if (error) throw error;

    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const row of page) {
      const steamAppId = Number(row.catalog_steam_appid);
      const hours = Number(row.hours_played);
      if (!Number.isFinite(steamAppId) || steamAppId <= 0 || !Number.isFinite(hours)) continue;

      const endorsement = Math.min(1, Math.max(0, (hours - PLAYTIME_MIN_HOURS) / (PLAYTIME_FULL_HOURS - PLAYTIME_MIN_HOURS)));
      addGameTally(gameTallies, steamAppId, playtimeWeight * endorsement, playtimeWeight);
      // The hours themselves, not a rate. A rate cannot tell 50,000 hours from
      // 5,000 - it is capped at 1 either way - which is why popularity needs an
      // absolute number of its own. Every hour counts here, including the ones
      // below the endorsement floor: someone bounced off at 30 minutes still
      // says the game is played.
      gameHours.set(steamAppId, (gameHours.get(steamAppId) ?? 0) + hours);
      counted += 1;
    }

    if (page.length < DECISION_PAGE_SIZE) break;
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
 * Scoped to their library rather than sent whole: the table covers 12,781 games
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

/**
 * The standing Purge verdict for each game, resolved to a Steam AppID.
 *
 * Only the most recent decision per game counts. A game kept and later slept has
 * changed its mind, not voted twice, and counting both would let a flip-flop
 * cancel itself out instead of recording where the player actually landed.
 */
async function fetchPurgeDecisions(supabase: AdminClient, since: string): Promise<PurgeDecision[]> {
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
  const latest = new Map<string, PurgeDecision>();

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
