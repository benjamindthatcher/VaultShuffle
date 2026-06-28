import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchSteamAppDetails } from "@/lib/steam";
import { steamImageUrl } from "@/lib/images";
import type { Game, GamePayload } from "@/lib/types";

type SteamMetadataRow = {
  steam_appid: string;
  title: string | null;
  genre: string | null;
  capsule_url: string | null;
  header_url: string | null;
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
    .select("steam_appid, genre, capsule_url, header_url, status")
    .in("steam_appid", appIds);

  if (isMissingMetadataTable(error)) return games;
  if (isMissingArtworkColumns(error)) return applyLegacyCachedSteamMetadata(games, appIds);
  if (error) throw error;

  const metadataByAppId = new Map(((data ?? []) as SteamMetadataRow[]).map((row) => [row.steam_appid, row]));

  return games.map((game) => {
    const appid = game.steam_appid ? String(game.steam_appid) : "";
    const metadata = metadataByAppId.get(appid);
    const genre = metadata?.genre && !UNKNOWN_GENRES.has(metadata.genre) ? metadata.genre : null;
    const capsuleUrl = metadata?.capsule_url || steamImageUrl(appid, "capsule");
    const headerUrl = metadata?.header_url || steamImageUrl(appid, "header");
    const nextGame = {
      ...game,
      capsule_url: capsuleUrl || game.capsule_url || null,
      header_url: headerUrl || game.header_url || null
    };
    if (genre && UNKNOWN_GENRES.has(String(game.genre || ""))) return { ...nextGame, genre };
    return nextGame;
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
  const capsuleUrl = String(details?.capsule_url || "").trim() || steamImageUrl(appid, "capsule");
  const headerUrl = String(details?.header_url || "").trim() || steamImageUrl(appid, "header");

  const row = {
    steam_appid: appid,
    title: title || null,
    genre: genre || "Unknown",
    capsule_url: capsuleUrl || null,
    header_url: headerUrl || null,
    status: genre ? "ready" : "failed",
    checked_at: checkedAt,
    failure_count: genre ? 0 : 1,
    last_error: genre ? null : "Steam did not return genre metadata."
  };

  const { error } = await supabase.from("steam_app_metadata").upsert(row, { onConflict: "steam_appid" });
  if (isMissingArtworkColumns(error)) {
    const { error: legacyError } = await supabase.from("steam_app_metadata").upsert(
      {
        steam_appid: row.steam_appid,
        title: row.title,
        genre: row.genre,
        status: row.status,
        checked_at: row.checked_at,
        failure_count: row.failure_count,
        last_error: row.last_error
      },
      { onConflict: "steam_appid" }
    );
    if (legacyError) throw legacyError;
  } else if (error) {
    throw error;
  }

  if (!genre) return Boolean(capsuleUrl || headerUrl);

  const { error: updateError } = await supabase
    .from("games")
    .update({ genre })
    .eq("steam_appid", appid)
    .eq("genre", "Unknown");

  if (updateError) throw updateError;
  return true;
}

async function applyLegacyCachedSteamMetadata<T extends GamePayload | Game>(games: T[], appIds: string[]): Promise<T[]> {
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

  return games.map((game) => {
    const appid = game.steam_appid ? String(game.steam_appid) : "";
    const genre = metadataByAppId.get(appid);
    const nextGame = {
      ...game,
      capsule_url: steamImageUrl(appid, "capsule") || game.capsule_url || null,
      header_url: steamImageUrl(appid, "header") || game.header_url || null
    };
    if (genre && UNKNOWN_GENRES.has(String(game.genre || ""))) return { ...nextGame, genre };
    return nextGame;
  });
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

function isMissingArtworkColumns(error: { code?: string } | null) {
  return error?.code === "42703";
}
