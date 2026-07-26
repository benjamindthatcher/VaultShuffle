import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchSteamAppDetails } from "@/lib/steam";
import type { GamePayload } from "@/lib/types";

const NON_GAME_TERMS = [
  "dedicated server",
  "soundtrack",
  "artbook",
  "sdk",
  "editor",
  "benchmark",
  "playtest",
  "test server",
  "test realm",
  "public test",
  "technical test",
  "modding tool",
  "development tool"
];
const NON_GAME_LABELS = new Set([
  "animation & modeling",
  "audio production",
  "design & illustration",
  "education",
  "game development",
  "photo editing",
  "software",
  "software training",
  "utilities",
  "utility",
  "video production",
  "web publishing"
]);
const NON_GAME_TITLE_PATTERNS = [
  /\bplaytest\b/i,
  /\bdedicated server\b/i,
  /\btest (?:server|realm|client)\b/i,
  /\bpublic test\b/i,
  /\btechnical test\b/i,
  /\b(?:pts|ptr)\b/i,
  /\b(?:sdk|benchmark|editor|soundtrack|artbook)\b/i
];
type CatalogueQueueRow = { steam_appid: number; attempts: number };

export async function quarantinedSteamImports(games: GamePayload[]) {
  const supabase = getSupabaseAdmin();
  const candidates = games.flatMap((game) => {
    const appid = Number(game.steam_appid);
    const matchedRule = immediateNonGameRule(game.title, game.genre);
    return Number.isSafeInteger(appid) && appid > 0 && matchedRule
      ? [{ steam_appid: appid, name: game.title, matched_rule: matchedRule, reason: `Automatic non-game rule matched: ${matchedRule}.`, last_detected_at: new Date().toISOString(), updated_at: new Date().toISOString() }]
      : [];
  });

  if (candidates.length) {
    const { error } = await supabase.from("catalog_game_quarantine").upsert(candidates, { onConflict: "steam_appid" });
    if (error) throw error;
  }

  const appids = uniqueNumericAppIds(games.flatMap((game) => game.steam_appid ? [game.steam_appid] : []));
  if (!appids.length) return new Map<string, string>();
  const { data, error } = await supabase
    .from("catalog_game_quarantine")
    .select("steam_appid, reason")
    .in("steam_appid", appids)
    .eq("review_status", "excluded");
  if (error) throw error;
  return new Map((data ?? []).map((row) => [String(row.steam_appid), String(row.reason)]));
}

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
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 15 * 60_000).toISOString();
  const { error: recoveryError } = await supabase
    .from("catalog_ingest_queue")
    .update({
      status: "pending",
      processing_started_at: null,
      next_attempt_at: now.toISOString(),
      last_error: "Recovered an expired catalogue worker lease.",
      updated_at: now.toISOString()
    })
    .eq("status", "processing")
    .lt("processing_started_at", staleBefore);
  if (recoveryError) throw recoveryError;

  let query = supabase.from("catalog_ingest_queue").select("steam_appid, attempts").eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .order("priority", { ascending: false }).order("first_requested_at", { ascending: true }).limit(clamp(limit, 1, 100));
  if (restrictToAppIds?.length) query = query.in("steam_appid", restrictToAppIds);
  const { data, error } = await query;
  if (error) throw error;
  const candidates = (data ?? []) as CatalogueQueueRow[];
  if (!candidates.length) return { processed: 0, accepted: 0, rejected: 0 };

  // Claim each item optimistically. Concurrent workers may read the same candidate
  // list, but only one can transition an item from pending to processing.
  const claims = await Promise.all(candidates.map(async (row) => {
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("catalog_ingest_queue")
      .update({ status: "processing", processing_started_at: claimedAt, updated_at: claimedAt })
      .eq("steam_appid", row.steam_appid)
      .eq("status", "pending")
      .select("steam_appid, attempts")
      .maybeSingle();
    if (claimError) throw claimError;
    return claimed as CatalogueQueueRow | null;
  }));
  const rows = claims.filter((row): row is CatalogueQueueRow => Boolean(row));

  let accepted = 0;
  let rejected = 0;
  for (const row of rows) {
    const appid = String(row.steam_appid);
    try {
      const details = await fetchSteamAppDetails(appid);
      const classification = classifySteamCatalogueEntry(details);
      if (!classification.accepted || !details?.title) {
        rejected += 1;
        const now = new Date().toISOString();
        const { error: quarantineError } = await supabase.from("catalog_game_quarantine").upsert({
          steam_appid: row.steam_appid,
          name: details?.title || null,
          steam_type: details?.steam_type || null,
          matched_rule: classification.matchedRule,
          reason: classification.reason || "Steam metadata was unavailable.",
          genres: details?.genres ?? [],
          categories: details?.categories ?? [],
          last_detected_at: now,
          updated_at: now
        }, { onConflict: "steam_appid" });
        if (quarantineError) throw quarantineError;
        const { error: rejectedError } = await supabase.from("catalog_ingest_queue").update({ status: "rejected", rejection_reason: classification.reason,
          processed_at: now, processing_started_at: null, updated_at: now })
          .eq("steam_appid", row.steam_appid);
        if (rejectedError) throw rejectedError;
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
        price_currency: details.price_currency === "USD" ? "USD" : null,
        price_initial: details.price_currency === "USD" ? details.price_initial ?? null : null,
        price_final: details.price_currency === "USD" ? details.price_final ?? null : null,
        discount_percent: details.price_currency === "USD" ? details.discount_percent ?? 0 : 0,
        first_seen_reason: "user_import", metadata_fetched_at: now, updated_at: now
      }, { onConflict: "steam_appid" });
      if (gameError) throw gameError;
      accepted += 1;
      const { error: readyError } = await supabase.from("catalog_ingest_queue").update({ status: "ready", processed_at: now,
        processing_started_at: null, last_error: null, updated_at: now }).eq("steam_appid", row.steam_appid);
      if (readyError) throw readyError;
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const terminal = attempts >= 5;
      const { error: failureUpdateError } = await supabase.from("catalog_ingest_queue").update({ status: terminal ? "failed" : "pending", attempts,
        next_attempt_at: terminal ? null : new Date(Date.now() + Math.min(2 ** attempts * 60_000, 6 * 60 * 60_000)).toISOString(),
        processing_started_at: null, last_error: error instanceof Error ? error.message.slice(0, 500) : "Unknown catalogue ingestion error",
        updated_at: new Date().toISOString() }).eq("steam_appid", row.steam_appid);
      if (failureUpdateError) throw failureUpdateError;
    }
  }
  return { processed: rows.length, accepted, rejected };
}

function classifySteamCatalogueEntry(details: Awaited<ReturnType<typeof fetchSteamAppDetails>>) {
  if (!details) return { accepted: false, reason: "Steam metadata was unavailable.", matchedRule: "metadata_unavailable" };
  if (details.steam_type !== "game") return { accepted: false, reason: `Steam classified this AppID as ${details.steam_type || "unknown"}.`, matchedRule: `steam_type:${details.steam_type || "unknown"}` };
  const title = String(details.title || "").toLowerCase();
  const normalizedLabels = [...(details.genres ?? []), ...(details.categories ?? [])]
    .map((label) => String(label).trim().toLowerCase());
  const exactBlockedLabel = normalizedLabels.find((label) => NON_GAME_LABELS.has(label));
  if (exactBlockedLabel) {
    return {
      accepted: false,
      reason: `Steam classified this AppID as ${exactBlockedLabel}, not a game.`,
      matchedRule: `steam_label:${exactBlockedLabel}`
    };
  }
  const labels = normalizedLabels.join(" ");
  const blocked = NON_GAME_TERMS.find((term) => title.includes(term) || labels.includes(term));
  return blocked
    ? { accepted: false, reason: `Non-game classification matched: ${blocked}.`, matchedRule: `tag_or_title:${blocked}` }
    : { accepted: true, reason: null, matchedRule: null };
}

function immediateNonGameRule(title: string, genre?: string | null) {
  const genreLabels = String(genre || "")
    .split(/[\/,|]/)
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
  const blockedGenre = genreLabels.find((label) => NON_GAME_LABELS.has(label));
  if (blockedGenre) return `steam_label:${blockedGenre}`;
  const match = NON_GAME_TITLE_PATTERNS.find((pattern) => pattern.test(title));
  return match?.source ?? null;
}

function uniqueNumericAppIds(appIds: string[]) {
  return [...new Set(appIds.map(Number).filter((appid) => Number.isSafeInteger(appid) && appid > 0))];
}
function normalizeName(value: string) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(Math.floor(Number(value) || min), max)); }
