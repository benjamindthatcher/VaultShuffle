import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) fail("Missing server-side Supabase configuration.");
const supabase = createClient(url, key, { auth: { persistSession: false } });
const command = process.argv[2];

if (command === "queue") {
  const appId = Number(argument("--steam-app-id"));
  if (!Number.isSafeInteger(appId) || appId <= 0) fail("Provide --steam-app-id.");
  const { data, error } = await supabase.rpc("queue_game_duration", { p_steam_app_id: appId, p_priority: 90 });
  output(error, { queued: Boolean(data), steamAppId: appId });
} else if (command === "backfill") {
  const limit = bounded(argument("--limit"), 250, 1000);
  const { data, error } = await supabase.rpc("queue_missing_game_durations", { p_limit: limit });
  output(error, { queued: Number(data || 0) });
} else if (command === "counts") {
  const { data, error } = await supabase.from("game_duration_jobs").select("status");
  const counts = (data ?? []).reduce<Record<string, number>>((result, row) => {
    result[row.status] = (result[row.status] ?? 0) + 1;
    return result;
  }, {});
  output(error, counts);
} else if (command === "retry") {
  const { data, error } = await supabase.from("game_duration_jobs").update({ status: "retry", next_attempt_at: new Date().toISOString(), locked_at: null, locked_by: null, updated_at: new Date().toISOString() }).in("status", ["failed", "needs_review"]).select("steam_app_id");
  output(error, { queued: data?.length ?? 0 });
} else if (command === "ambiguous") {
  const { data, error } = await supabase.from("game_duration_estimates").select("steam_app_id,provider_game_id,checked_at").in("match_status", ["ambiguous", "needs_review"]).order("checked_at", { ascending: false });
  output(error, data ?? []);
} else if (command === "coverage") {
  const [{ count: total, error: totalError }, { count: matched, error: matchedError }] = await Promise.all([
    supabase.from("catalog_games").select("steam_appid", { count: "exact", head: true }).eq("steam_type", "game"),
    supabase.from("game_duration_estimates").select("steam_app_id", { count: "exact", head: true }).eq("match_status", "matched")
  ]);
  output(totalError || matchedError, { confirmedGames: total ?? 0, matchedEstimates: matched ?? 0 });
} else if (command === "process") {
  const { data, error } = await supabase.functions.invoke("igdb-duration-worker", { body: { batchSize: bounded(argument("--limit"), 4, 8) } });
  output(error, data);
} else {
  fail("Commands: queue, backfill, counts, retry, ambiguous, coverage, process");
}

function argument(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function bounded(value: unknown, fallback: number, max: number) { const number = Number(value); return Number.isFinite(number) ? Math.max(1, Math.min(max, Math.floor(number))) : fallback; }
function output(error: unknown, data: unknown) { if (error) fail("Administrative operation failed."); console.log(JSON.stringify(data, null, 2)); }
function fail(message: string): never { console.error(message); process.exit(1); }
