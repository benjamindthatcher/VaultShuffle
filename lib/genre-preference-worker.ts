import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import { statesAnOpinion } from "@/lib/draw-signal-precedence";
import { ANY_MOOD_CONTEXT, BASELINE_GENRE, canonicalPreferenceGenre, preferenceGenresFor, type GenrePreference } from "@/lib/genre-preferences";
import type { VaultDrawEventType } from "@/lib/vault-history";
import type { VaultMoodId } from "@/lib/demo-data";

/**
 * Only draws from the last six months count. A preference the user has grown out
 * of should fade rather than be argued with forever, and a bounded window also
 * keeps the nightly rebuild cheap as the table grows.
 */
const LOOKBACK_DAYS = 180;

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
const EVENT_SIGNALS: Partial<Record<VaultDrawEventType, Signal>> = {
  opened_on_steam: { positive: 2, total: 2 },
  liked: { positive: 2, total: 2 },
  pinned: { positive: 1, total: 1 },

  disliked: { positive: 0, total: 2 },
  // Sleeping a game is the most deliberate rejection the product offers: it is a
  // decision about the game itself, not about tonight.
  slept: { positive: 0, total: 3 },
  reroll_not_interested: { positive: 0, total: 2 },
  reroll_wrong_mood: { positive: 0, total: 1, moodOnly: true },

  // The bare reroll is the weakest signal there is: it is also just how the
  // product is used. It counts for something, but barely, and only when the draw
  // carries no more explicit opinion — see statesAnOpinion.
  drew_again: { positive: 0, total: 0.5 }
};

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

const DECISION_PAGE_SIZE = 1000;

/**
 * How each Purge verdict reads as taste. Sleeping matches the weight a Vault
 * "slept" carries, because it is the same decision. "Keep" is a deliberate
 * retention rather than an endorsement, so it counts for half.
 */
const PURGE_SIGNALS: Record<string, { positive: number; total: number }> = {
  // Matched to the draw-side weight: sleeping is the clearest rejection there is,
  // reached deliberately through a review rather than in passing.
  sleep: { positive: 0, total: 3 },
  keep: { positive: 1, total: 2 },
  pin: { positive: 2, total: 2 },
  complete: { positive: 2, total: 2 }
};
type CatalogRow = { steam_appid: number | string; name: string | null; genres: string[] | null };
type Tally = { positive: number; total: number };

export type GenrePreferenceRebuildSummary = {
  draws: number;
  events: number;
  scoredEvents: number;
  purgeDecisions: number;
  users: number;
  rows: number;
  globalRows: number;
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
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: drawData, error: drawError } = await supabase
    .from("vault_draws")
    .select("id, user_id, steam_appid, mood")
    .gte("drawn_at", since);
  if (drawError) throw drawError;

  const draws = (drawData ?? []) as DrawRow[];
  const summary: GenrePreferenceRebuildSummary = {
    draws: draws.length,
    events: 0,
    scoredEvents: 0,
    purgeDecisions: 0,
    users: 0,
    rows: 0,
    globalRows: 0,
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
      const signal = EVENT_SIGNALS[eventType];
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
    }
  }

  // A Purge decision is the most considered signal the app collects: the player
  // was looking at one game and deliberately chose its fate. Until now none of it
  // reached the recommender - every sleep in the system happened in Purge, so the
  // learner's "slept" weight had never once fired, and the same action taught the
  // model or not depending on which page it happened on.
  for (const decision of purgeDecisions) {
    const signal = PURGE_SIGNALS[decision.action];
    if (!signal) continue;
    const genres = genresByAppId.get(decision.steamAppId);
    if (!genres?.length) continue;

    const decay = recencyWeight(decision.reviewedAt);
    if (decay <= 0) continue;

    const userTallies = tallies.get(decision.userId) ?? new Map<string, Tally>();
    tallies.set(decision.userId, userTallies);

    // No mood context: a Purge decision is about the game, not about the evening
    // the player happened to be having.
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

async function fetchGenres(supabase: AdminClient, appIds: number[]) {
  const unique = [...new Set(appIds.filter((appId) => Number.isFinite(appId)))];
  const genresByAppId = new Map<number, string[]>();

  for (let index = 0; index < unique.length; index += 200) {
    const { data, error } = await supabase
      .from("catalog_games")
      .select("steam_appid, name, genres")
      .in("steam_appid", unique.slice(index, index + 200));
    if (error) throw error;

    for (const row of (data ?? []) as CatalogRow[]) {
      const genres = preferenceGenresFor(row.genres ?? [], row.name ?? "")
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

  return [...latest.values()];
}
