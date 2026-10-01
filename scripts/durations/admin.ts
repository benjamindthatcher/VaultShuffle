import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

if (process.env.VAULT_DATABASE_AUTHORITY === "v2") {
  await runV2Admin();
  process.exit(0);
}

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
  const { data, error } = await supabase.from("game_duration_estimates").select("steam_app_id,provider_game_id,checked_at").eq("provider", "hltb").in("match_status", ["ambiguous", "needs_review"]).order("checked_at", { ascending: false });
  output(error, data ?? []);
} else if (command === "coverage") {
  const [{ count: total, error: totalError }, { count: matched, error: matchedError }] = await Promise.all([
    supabase.from("catalog_games").select("steam_appid", { count: "exact", head: true }).eq("steam_type", "game"),
    supabase.from("game_duration_estimates").select("steam_app_id", { count: "exact", head: true }).eq("provider", "hltb").eq("match_status", "matched")
  ]);
  output(totalError || matchedError, { confirmedGames: total ?? 0, matchedEstimates: matched ?? 0 });
} else if (command === "process") {
  fail("Hosted duration processing is retired. Use the local duration enrichment and reviewed writeback workflow documented in supabase/README.md.");
} else {
  fail("Commands: queue, backfill, counts, retry, ambiguous, coverage, process");
}

function argument(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function bounded(value: unknown, fallback: number, max: number) { const number = Number(value); return Number.isFinite(number) ? Math.max(1, Math.min(max, Math.floor(number))) : fallback; }
function output(error: unknown, data: unknown) { if (error) fail("Administrative operation failed."); console.log(JSON.stringify(data, null, 2)); }
function fail(message: string): never { console.error(message); process.exit(1); }

async function runV2Admin() {
  const command = process.argv[2];
  if (["queue", "backfill", "retry", "process"].includes(command)) {
    fail("V2 has no duration processing queue. Use catalogue input, local HLTB validation and --target v2 writeback; nothing was queued.");
  }
  if (!["counts", "ambiguous", "coverage", "input"].includes(command)) fail("V2 commands: counts, ambiguous, coverage, input");
  const url = process.env.V2_DURATION_DATABASE_URL;
  const ca = process.env.V2_DATABASE_CA_PEM;
  if (!url || !ca) fail("Provide private operator V2_DURATION_DATABASE_URL and V2_DATABASE_CA_PEM. Runtime roles cannot perform duration administration.");
  const sql = postgres(url, { max: 1, prepare: false, ssl: { rejectUnauthorized: true, ca },
    connect_timeout: 15, onnotice: () => {} });
  try {
    const [marker] = await sql`select expected_project_ref from ops.project_marker where marker`;
    if (marker?.expected_project_ref !== "vbjtbwelnhbbdfrqczyf") throw new Error("Wrong target");
    if (command === "counts") {
      console.log(JSON.stringify(await sql`select match_status, count(*)::integer as count
        from catalog.duration_estimates where provider='hltb' group by match_status order by match_status`, null, 2));
    } else if (command === "ambiguous") {
      console.log(JSON.stringify(await sql`select steam_app_id,provider_game_id,checked_at
        from catalog.duration_estimates where provider='hltb' and match_status in ('ambiguous','needs_review')
        order by checked_at desc,steam_app_id`, null, 2));
    } else if (command === "input") {
      console.log(JSON.stringify(await sql`select steam_app_id as steam_appid,title as name
        from catalog.games where lifecycle_status='active' and game_type='game' order by steam_app_id`, null, 2));
    } else {
      const [row] = await sql`select
        (select count(*)::integer from catalog.games where lifecycle_status='active' and game_type='game') as "confirmedGames",
        (select count(*)::integer from catalog.duration_estimates e where catalog.hltb_estimate_is_eligible(e)) as "matchedEstimates"`;
      console.log(JSON.stringify(row, null, 2));
    }
  } catch {
    console.error("V2 duration administration failed; no connection credentials printed.");
    process.exitCode = 1;
  } finally { await sql.end({ timeout: 5 }); }
  if (process.exitCode) process.exit(1);
}
