import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchSteamAppDetails } from "@/lib/steam";
import type { Game, GamePayload } from "@/lib/types";

type SteamMetadataRow = {
  steam_appid: string;
  title: string | null;
  genre: string | null;
  status: "pending" | "ready" | "failed";
  checked_at: string | null;
};

const UNKNOWN_GENRES = new Set(["", "Unknown"]);
const METADATA_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

export async function applyCachedSteamMetadata<T extends GamePayload | Game>(games: T[]): Promise<T[]> {
  const appIds = steamAppIds(games);
  if (!appIds.length) return games;

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("steam_app_metadata")
    .select("steam_appid, genre, status")
    .in("steam_appid", appIds)
    .eq("status", "ready");

  if (isMissingMetadataTable(error)) return games;
  if (error) throw error;

  const metadataByAppId = new Map(
    ((data ?? []) as Pick<SteamMetadataRow, "steam_appid" | "genre">[])
      .filter((row) => row.genre && !UNKNOWN_GENRES.has(row.genre))
      .map((row) => [row.steam_appid, row.genre as string])
  );

  if (!metadataByAppId.size) return games;

  return games.map((game) => {
    const appid = game.steam_appid ? String(game.steam_appid) : "";
    const genre = metadataByAppId.get(appid);
    if (!genre || !UNKNOWN_GENRES.has(String(game.genre || ""))) return game;
    return { ...game, genre };
  });
}

export async function queueSteamMetadata(appIds: string[]) {
  const uniqueAppIds = uniqueSteamAppIds(appIds);
  if (!uniqueAppIds.length) return 0;

  const supabase = getSupabaseAdmin();
  const rows = uniqueAppIds.map((steam_appid) => ({ steam_appid, status: "pending" }));
  const { error } = await supabase
    .from("steam_app_metadata")
    .upsert(rows, { onConflict: "steam_appid", ignoreDuplicates: true });

  if (isMissingMetadataTable(error)) return 0;
  if (error) throw error;

  const retryBefore = new Date(Date.now() - METADATA_RETRY_AFTER_MS).toISOString();
  const { error: retryError } = await supabase
    .from("steam_app_metadata")
    .update({ status: "pending", last_error: null })
    .in("steam_appid", uniqueAppIds)
    .eq("status", "failed")
    .lt("checked_at", retryBefore);

  if (retryError && !isMissingMetadataTable(retryError)) throw retryError;

  return rows.length;
}

export async function enrichSteamMetadataForUser(userId: string, limit = 12) {
  const supabase = getSupabaseAdmin();
  const { data: gameData, error: gameError } = await supabase
    .from("games")
    .select("steam_appid")
    .eq("user_id", userId)
    .not("steam_appid", "is", null);

  if (gameError) throw gameError;

  const appIds = uniqueSteamAppIds((gameData ?? []).map((game) => String(game.steam_appid ?? "")));
  if (!appIds.length) return { processed: 0, updated: 0, remaining: 0 };

  await queueSteamMetadata(appIds);

  const { data: pendingData, error: pendingError } = await supabase
    .from("steam_app_metadata")
    .select("steam_appid, status, checked_at")
    .in("steam_appid", appIds)
    .eq("status", "pending")
    .order("checked_at", { ascending: true, nullsFirst: true })
    .limit(clampLimit(limit));

  if (isMissingMetadataTable(pendingError)) return { processed: 0, updated: 0, remaining: 0 };
  if (pendingError) throw pendingError;

  const pendingRows = (pendingData ?? []) as SteamMetadataRow[];
  if (!pendingRows.length) return { processed: 0, updated: 0, remaining: 0 };

  let updated = 0;
  for (const chunk of chunks(pendingRows, 4)) {
    const results = await Promise.all(chunk.map((row) => fetchAndStoreMetadata(row.steam_appid)));
    updated += results.filter(Boolean).length;
  }

  const { count, error: countError } = await supabase
    .from("steam_app_metadata")
    .select("steam_appid", { count: "exact", head: true })
    .in("steam_appid", appIds)
    .eq("status", "pending");

  if (countError && !isMissingMetadataTable(countError)) throw countError;

  return {
    processed: pendingRows.length,
    updated,
    remaining: count ?? 0
  };
}

async function fetchAndStoreMetadata(appid: string) {
  const supabase = getSupabaseAdmin();
  const checkedAt = new Date().toISOString();
  const details = await fetchSteamAppDetails(appid);
  const genre = String(details?.genre || "").trim();
  const title = String(details?.title || "").trim();

  const row = {
    steam_appid: appid,
    title: title || null,
    genre: genre || "Unknown",
    status: genre ? "ready" : "failed",
    checked_at: checkedAt,
    failure_count: genre ? 0 : 1,
    last_error: genre ? null : "Steam did not return genre metadata."
  };

  const { error } = await supabase.from("steam_app_metadata").upsert(row, { onConflict: "steam_appid" });
  if (error) throw error;

  if (!genre) return false;

  const { error: updateError } = await supabase
    .from("games")
    .update({ genre })
    .eq("steam_appid", appid)
    .eq("genre", "Unknown");

  if (updateError) throw updateError;
  return true;
}

function steamAppIds(games: Array<Pick<GamePayload, "steam_appid">>) {
  return uniqueSteamAppIds(games.map((game) => String(game.steam_appid ?? "")));
}

function uniqueSteamAppIds(appIds: string[]) {
  return [...new Set(appIds.map((appid) => appid.trim()).filter(Boolean))];
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function clampLimit(value: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 12;
  return Math.max(1, Math.min(Math.floor(parsed), 24));
}

function isMissingMetadataTable(error: { code?: string } | null) {
  return error?.code === "42P01";
}
