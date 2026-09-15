import "server-only";

import { endlessPromotionBlocker, endlessVerdict, type EndlessWitness } from "@/lib/game-classification";
import type { getSupabaseAdmin } from "@/lib/supabase";

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

/** The stored fields endlessPromotionBlocker reads, off a catalog_games row. */
function blockerFor(row: Record<string, unknown>) {
  return endlessPromotionBlocker({
    durationKind: row.duration_kind as string | null,
    durationSource: row.duration_source as string | null,
    durationManualOverride: row.duration_manual_override as boolean | null
  });
}

/**
 * What a promotion writes.
 *
 * The HLTB minutes are kept rather than nulled. Nothing reads them once the kind
 * is endless - isEndlessGame short-circuits and deriveSessionFits opens every
 * session - so keeping them costs nothing and leaves a figure to fall back on if
 * a person later rules the game finite.
 */
function endlessColumns() {
  const now = new Date().toISOString();
  return {
    duration_kind: "endless",
    duration_source: "classification",
    duration_status: "ready",
    duration_confidence: "medium",
    duration_source_updated_at: now,
    updated_at: now
  };
}

/**
 * Re-ask the endless question when the nightly tag worker stores a game's tags.
 *
 * The catalogue used to answer it once, badly: a HowLongToBeat match wrote
 * `duration_kind = 'finite'` and nothing ever looked at the tags, so of the owned
 * catalogue every one of the 16,292 HLTB matches came out finite - Rainbow Six
 * Siege among them, on a recorded 3h19 "story". The backfills fixed the rows that
 * existed; this and sweepEndlessVerdicts stop the drift starting again.
 *
 * This one covers the worker's own writes, the moment they happen. Tags and
 * lengths set by any other route - a bulk import script, the HLTB writeback - are
 * the sweep's job.
 *
 * Only ever promotes. A game already endless is left alone, a length a person
 * ruled on is never overturned (see endlessPromotionBlocker), and nothing here can
 * move a game back to finite - demotion is a decision for a person.
 */
export async function promoteIfEndless(
  supabase: AdminClient,
  steamAppId: number,
  tags: Record<string, number> | null | undefined
): Promise<{ promoted: boolean; witnesses: EndlessWitness[] }> {
  const quiet = { promoted: false, witnesses: [] as EndlessWitness[] };
  if (!tags || !Object.keys(tags).length) return quiet;

  const { data, error } = await supabase
    .from("catalog_games")
    .select("genres, categories, main_story_minutes, completionist_minutes, duration_kind, duration_source, duration_manual_override, steam_type")
    .eq("steam_appid", steamAppId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return quiet;

  const row = data as Record<string, unknown>;
  // Demos, DLC and software are a different problem - see the quarantine notes in
  // docs/vault-recommender.md - and not one a length verdict should guess at.
  if (String(row.steam_type ?? "").toLowerCase() !== "game") return quiet;
  if (blockerFor(row)) return quiet;

  const verdict = endlessVerdict({
    tags,
    genres: (row.genres ?? []) as string[],
    categories: (row.categories ?? []) as string[],
    mainStoryMinutes: row.main_story_minutes as number | null,
    completionistMinutes: row.completionist_minutes as number | null,
    manualOverride: false
  });
  if (!verdict.endless) return quiet;

  const { error: updateError } = await supabase
    .from("catalog_games")
    .update(endlessColumns())
    .eq("steam_appid", steamAppId)
    // Written as `is not true` rather than `neq`. The column is NOT NULL DEFAULT
    // false today, so the two agree - but `neq` compiles to `<>`, which would
    // silently drop every row if that ever changed.
    .not("duration_manual_override", "is", true);
  if (updateError) throw updateError;

  return { promoted: true, witnesses: verdict.witnesses };
}

/**
 * How far back a change is worth re-examining.
 *
 * Fourteen days covers the gap between nightly runs with room for a stretch of
 * failed ones, which is not hypothetical - this cron failed every night from
 * 2026-09-04 to 2026-09-15 - while keeping the read bounded.
 */
const SWEEP_CHANGED_WITHIN_DAYS = 14;

/** Rows per read. Tags are the heavy column, so pages stay well under a megabyte. */
const SWEEP_PAGE_SIZE = 500;

/**
 * The most rows one run will judge. The deadline is the real limit; this is a
 * backstop against a runaway window. The largest bulk import seen so far wrote
 * 3,075 tag sets in one morning.
 */
const SWEEP_MAX_EXAMINED = 10_000;

/**
 * Re-ask the endless question for every game whose tags or length changed recently.
 *
 * promoteIfEndless hangs off the nightly tag worker's own write, which is only one
 * of the ways a game's inputs change. The others were invisible to it:
 *
 *   - HowLongToBeat resolves a length. That enrichment is a local script and a SQL
 *     writeback that writes 'finite' onto an 'unknown' row, so the tags never
 *     changed and nothing re-asked.
 *   - Tags arrive from anywhere but the worker. On 2026-09-12 a SteamSpy import
 *     wrote 2,444 tag sets and a Steam store-page import 631, and neither calls the
 *     verdict - the store-page importer is not even in this repository. 242 games
 *     had to be promoted by hand three days later.
 *
 * So the sweep keys on both columns instead of hooking each writer, which would
 * only ever cover the writers that exist today. Anything that sets tags or a
 * length, by any route, is judged on the next night.
 *
 * Re-examining a row that did not qualify costs a pure function call and is correct
 * anyway, since its inputs can change again. Paged by AppID rather than by offset,
 * so a large window is one walk of the primary key rather than a rescan per page,
 * and bounded by the caller's deadline so the steps after it still get their time.
 */
export async function sweepEndlessVerdicts(
  supabase: AdminClient,
  options: { deadlineAt?: number; maxExamined?: number; pageSize?: number } = {}
): Promise<{ examined: number; promoted: number; held: number; pages: number; complete: boolean }> {
  const deadlineAt = options.deadlineAt ?? Number.POSITIVE_INFINITY;
  const maxExamined = Math.max(1, options.maxExamined ?? SWEEP_MAX_EXAMINED);
  const pageSize = Math.max(1, Math.min(1000, options.pageSize ?? SWEEP_PAGE_SIZE));
  const since = new Date(Date.now() - SWEEP_CHANGED_WITHIN_DAYS * 86_400_000).toISOString();

  const promote: number[] = [];
  let examined = 0;
  let held = 0;
  let pages = 0;
  let cursor = 0;
  let complete = false;

  while (examined < maxExamined && Date.now() < deadlineAt) {
    const requested = Math.min(pageSize, maxExamined - examined);
    const { data, error } = await supabase
      .from("catalog_games")
      .select("steam_appid, tags, genres, categories, main_story_minutes, completionist_minutes, duration_kind, duration_source, duration_manual_override")
      .in("duration_kind", ["finite", "unknown"])
      .eq("steam_type", "game")
      .not("tags", "is", null)
      .or(`tags_fetched_at.gte."${since}",duration_source_updated_at.gte."${since}"`)
      .gt("steam_appid", cursor)
      .order("steam_appid", { ascending: true })
      .limit(requested);
    if (error) throw error;

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    pages += 1;
    examined += rows.length;

    for (const row of rows) {
      const steamAppId = Number(row.steam_appid);
      if (!Number.isFinite(steamAppId)) continue;
      cursor = Math.max(cursor, steamAppId);

      const tags = row.tags as Record<string, number> | null;
      if (!tags || !Object.keys(tags).length) continue;
      if (blockerFor(row)) { held += 1; continue; }

      const verdict = endlessVerdict({
        tags,
        genres: (row.genres ?? []) as string[],
        categories: (row.categories ?? []) as string[],
        mainStoryMinutes: row.main_story_minutes as number | null,
        completionistMinutes: row.completionist_minutes as number | null
      });
      if (verdict.endless) promote.push(steamAppId);
    }

    if (rows.length < requested) {
      complete = true;
      break;
    }
  }

  for (let index = 0; index < promote.length; index += 200) {
    const { error: updateError } = await supabase
      .from("catalog_games")
      .update(endlessColumns())
      .in("steam_appid", promote.slice(index, index + 200))
      // Re-checked at write time as well as read time, so a ruling made while the
      // sweep was running still wins.
      .in("duration_kind", ["finite", "unknown"])
      .not("duration_manual_override", "is", true);
    if (updateError) throw updateError;
  }

  return { examined, promoted: promote.length, held, pages, complete };
}
