import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import { ANY_MOOD_CONTEXT, canonicalPreferenceGenre, preferenceGenresFor, type GenrePreference } from "@/lib/genre-preferences";
import type { VaultDrawEventType } from "@/lib/vault-history";
import type { VaultMoodId } from "@/lib/demo-data";

/**
 * Only draws from the last six months count. A preference the user has grown out
 * of should fade rather than be argued with forever, and a bounded window also
 * keeps the nightly rebuild cheap as the table grows.
 */
const LOOKBACK_DAYS = 180;

/**
 * How loudly each event speaks. Strong signals count double so that "opened it on
 * Steam" outweighs "rerolled past it" without needing fractional counts: positive
 * and total stay integers, which keeps the smoothing in the score easy to reason
 * about.
 *
 * A reroll is only a weak negative on purpose. Users reroll for reasons that have
 * nothing to do with genre — wrong length, played it last week — so treating it as
 * a strong signal would teach the recommender noise.
 */
const EVENT_WEIGHTS: Partial<Record<VaultDrawEventType, { positive: number; total: number }>> = {
  opened_on_steam: { positive: 2, total: 2 },
  liked: { positive: 2, total: 2 },
  pinned: { positive: 1, total: 1 },
  drew_again: { positive: 0, total: 1 },
  disliked: { positive: 0, total: 2 },
  slept: { positive: 0, total: 2 }
};

type DrawRow = {
  id: string;
  user_id: string;
  steam_appid: number | string;
  mood: VaultMoodId | null;
};

type EventRow = { draw_id: string; event_type: string };
type CatalogRow = { steam_appid: number | string; name: string | null; genres: string[] | null };
type Tally = { positive: number; total: number };

export type GenrePreferenceRebuildSummary = {
  draws: number;
  events: number;
  scoredEvents: number;
  users: number;
  rows: number;
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
    users: 0,
    rows: 0,
    deletedRows: 0
  };
  if (!draws.length) return summary;

  const drawsById = new Map(draws.map((draw) => [draw.id, draw]));
  const events = await fetchEvents(supabase, [...drawsById.keys()]);
  summary.events = events.length;
  if (!events.length) return summary;

  const genresByAppId = await fetchGenres(supabase, draws.map((draw) => Number(draw.steam_appid)));

  // user -> "context::genre" -> tally
  const tallies = new Map<string, Map<string, Tally>>();

  for (const event of events) {
    const weight = EVENT_WEIGHTS[event.event_type as VaultDrawEventType];
    if (!weight) continue;
    const draw = drawsById.get(event.draw_id);
    if (!draw) continue;
    const genres = genresByAppId.get(Number(draw.steam_appid));
    if (!genres?.length) continue;

    summary.scoredEvents += 1;
    const userTallies = tallies.get(draw.user_id) ?? new Map<string, Tally>();
    tallies.set(draw.user_id, userTallies);

    for (const genre of genres) {
      // Every event writes the mood-agnostic row as well as the mood-scoped one,
      // so the fallback in scoring always has something to fall back to.
      addTally(userTallies, `${ANY_MOOD_CONTEXT}::${genre}`, weight);
      if (draw.mood) addTally(userTallies, `${draw.mood}::${genre}`, weight);
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
        positive: tally.positive,
        total: tally.total,
        updated_at: new Date().toISOString()
      };
    })
  );
  summary.rows = rows.length;

  summary.deletedRows = await replacePreferences(supabase, rows);
  return summary;
}

function addTally(userTallies: Map<string, Tally>, key: string, weight: { positive: number; total: number }) {
  const tally = userTallies.get(key) ?? { positive: 0, total: 0 };
  tally.positive += weight.positive;
  tally.total += weight.total;
  userTallies.set(key, tally);
}

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

/** Chunked because `in` lists are sent as a URL filter and long ones get rejected. */
async function fetchEvents(supabase: AdminClient, drawIds: string[]) {
  const events: EventRow[] = [];
  for (let index = 0; index < drawIds.length; index += 200) {
    const { data, error } = await supabase
      .from("vault_draw_events")
      .select("draw_id, event_type")
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
