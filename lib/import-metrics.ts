import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";

export type ImportMetricsRecount = {
  gamesCounted: number;
  sightingsWritten: number;
  catalogueRowsWritten: number;
};

/**
 * Recounts how many people own each catalogue game.
 *
 * This used to run inside upsert_user_steam_games, once per import batch, over
 * just that batch's AppIDs: 500 index probes across 385,054 ownership rows,
 * 2.0s of an 8s statement_timeout the upsert had already spent most of. Imports
 * died there, which is why nine jobs sit at `importing`.
 *
 * Counting every sighted game in one sequential scan costs 3.0s, so recounting
 * the entire catalogue is barely dearer than recounting a single batch was.
 * Doing it nightly rather than per batch also takes the work off the path a
 * person is waiting on.
 *
 * The counter is read by the duration review queue's ordering and by nothing a
 * player sees, so a figure up to a day old changes the order two admin screens
 * list games in. The import path stops maintaining it the moment the matching
 * database change lands; until then both run and agree.
 */
export async function recountImportMetrics(): Promise<ImportMetricsRecount> {
  const { data, error } = await getSupabaseAdmin().rpc("recount_catalog_import_metrics");
  if (error) throw error;

  // A set-returning function comes back as a one-row array through PostgREST,
  // but a scalar shape is accepted too rather than reporting zeroes if that
  // ever changes.
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;

  return {
    gamesCounted: Number(row?.games_counted ?? 0),
    sightingsWritten: Number(row?.sightings_written ?? 0),
    catalogueRowsWritten: Number(row?.catalogue_rows_written ?? 0)
  };
}
