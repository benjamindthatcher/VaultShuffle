import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchSteamAppDetails } from "@/lib/steam";

const NON_GAME_TERMS = ["dedicated server", "soundtrack", "artbook", "sdk", "editor", "benchmark", "playtest"];
type CatalogueQueueRow = { steam_appid: number; attempts: number };

export async function recordImportedSteamAppIds(userId: string, appIds: string[]) {
  const ids = uniqueNumericAppIds(appIds);
  if (!ids.length) return { queued: 0 };
  const supabase = getSupabaseAdmin();
  const { data: queued, error } = await supabase.rpc("register_catalog_imports", {
    p_user_id: userId, p_appids: ids, p_priority: 80
  });
  if (error) throw error;
  return { queued: Number(queued || 0) };
}

export async function processCatalogueQueue(limit = 25, restrictToAppIds?: number[]) {
  const supabase = getSupabaseAdmin();
  let query = supabase.from("catalog_ingest_queue").select("steam_appid, attempts").eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${new Date().toISOString()}`)
    .order("priority", { ascending: false }).order("first_requested_at", { ascending: true }).limit(clamp(limit, 1, 100));
  if (restrictToAppIds?.length) query = query.in("steam_appid", restrictToAppIds);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as CatalogueQueueRow[];
  if (!rows.length) return { processed: 0, accepted: 0, rejected: 0 };
  const appIds = rows.map((row) => row.steam_appid);
  const { error: lockError } = await supabase.from("catalog_ingest_queue")
    .update({ status: "processing", processing_started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("steam_appid", appIds).eq("status", "pending");
  if (lockError) throw lockError;

  let accepted = 0;
  let rejected = 0;
  for (const row of rows) {
    const appid = String(row.steam_appid);
    try {
      const details = await fetchSteamAppDetails(appid);
      const classification = classifySteamCatalogueEntry(details);
      if (!classification.accepted || !details?.title) {
        rejected += 1;
        await supabase.from("catalog_ingest_queue").update({ status: "rejected", rejection_reason: classification.reason,
          processed_at: new Date().toISOString(), processing_started_at: null, updated_at: new Date().toISOString() })
          .eq("steam_appid", row.steam_appid);
        continue;
      }
      const now = new Date().toISOString();
      const { error: gameError } = await supabase.from("catalog_games").upsert({
        steam_appid: row.steam_appid, name: details.title, normalized_name: normalizeName(details.title), steam_type: "game",
        developer: details.developers?.join(", ") || null, publisher: details.publishers?.join(", ") || null,
        genres: details.genres ?? [], categories: details.categories ?? [], short_description: details.short_description || null,
        release_date: details.release_date || null, is_free: Boolean(details.is_free), capsule_url: details.capsule_url || null,
        header_url: details.header_url || null, review_positive: Math.max(0, Number(details.review_positive || 0)),
        review_negative: Math.max(0, Number(details.review_total || 0) - Number(details.review_positive || 0)),
        price_currency: details.price_currency || null, price_initial: details.price_initial ?? null,
        price_final: details.price_final ?? null, discount_percent: details.discount_percent ?? 0,
        first_seen_reason: "user_import", metadata_fetched_at: now, updated_at: now
      }, { onConflict: "steam_appid" });
      if (gameError) throw gameError;
      accepted += 1;
      await supabase.from("catalog_ingest_queue").update({ status: "ready", processed_at: now,
        processing_started_at: null, last_error: null, updated_at: now }).eq("steam_appid", row.steam_appid);
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const terminal = attempts >= 5;
      await supabase.from("catalog_ingest_queue").update({ status: terminal ? "failed" : "pending", attempts,
        next_attempt_at: terminal ? null : new Date(Date.now() + Math.min(2 ** attempts * 60_000, 6 * 60 * 60_000)).toISOString(),
        processing_started_at: null, last_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown catalogue ingestion error",
        updated_at: new Date().toISOString() }).eq("steam_appid", row.steam_appid);
    }
  }
  return { processed: rows.length, accepted, rejected };
}

function classifySteamCatalogueEntry(details: Awaited<ReturnType<typeof fetchSteamAppDetails>>) {
  if (!details) return { accepted: false, reason: "Steam metadata was unavailable." };
  if (details.steam_type !== "game") return { accepted: false, reason: `Steam classified this AppID as ${details.steam_type || "unknown"}.` };
  const title = String(details.title || "").toLowerCase();
  const labels = [...(details.genres ?? []), ...(details.categories ?? [])].join(" ").toLowerCase();
  const blocked = NON_GAME_TERMS.find((term) => title.includes(term) || labels.includes(term));
  return blocked ? { accepted: false, reason: `Non-game classification matched: ${blocked}.` } : { accepted: true, reason: null };
}

function uniqueNumericAppIds(appIds: string[]) {
  return [...new Set(appIds.map(Number).filter((appid) => Number.isSafeInteger(appid) && appid > 0))];
}
function normalizeName(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(Math.floor(Number(value) || min), max)); }
