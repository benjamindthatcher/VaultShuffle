import { getSupabaseAdmin } from "@/lib/supabase";
import { clearSteamAppDetailsCache, fetchSteamAppDetails } from "@/lib/steam";
import type { SteamAppDetails } from "@/lib/steam";
import { steamImageUrl } from "@/lib/images";
import { normaliseSteamGenreLabel, steamTagGenreLabels } from "@/lib/genres";
import type { Game, GamePayload } from "@/lib/types";

type SteamMetadataRow = {
  steam_appid: string;
  title: string | null;
  genre: string | null;
  rating: number | null;
  review_score_desc: string | null;
  review_total: number | null;
  review_positive: number | null;
  capsule_url: string | null;
  header_url: string | null;
  price_currency: string | null;
  price_initial: number | null;
  price_final: number | null;
  discount_percent: number | null;
  is_free: boolean;
  status: "pending" | "ready" | "failed";
  checked_at: string | null;
  failure_count?: number | null;
};

const UNKNOWN_GENRES = new Set(["", "Unknown"]);
const METADATA_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const METADATA_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export async function applyCachedSteamMetadata<T extends GamePayload | Game>(games: T[]): Promise<T[]> {
  const appIds = steamAppIds(games);
  if (!appIds.length) return games;

  const supabase = getSupabaseAdmin();
  const [{ data, error }, { data: catalogueData, error: catalogueError }] = await Promise.all([
    supabase
      .from("steam_app_metadata")
      .select("steam_appid, title, genre, rating, review_score_desc, review_total, review_positive, capsule_url, header_url, price_currency, price_initial, price_final, discount_percent, is_free, status")
      .in("steam_appid", appIds),
    supabase
      .from("catalog_games")
      .select("steam_appid, name, genres, tags, capsule_url, header_url, review_positive, review_total, price_currency, price_initial, price_final, discount_percent, is_free, main_story_minutes, main_extras_minutes, completionist_minutes, duration_source, duration_source_updated_at, duration_confidence, duration_kind")
      .in("steam_appid", appIds)
  ]);

  if (isMissingMetadataTable(error)) return games;
  if (isMissingArtworkColumns(error)) return applyLegacyCachedSteamMetadata(games, appIds);
  if (error) throw error;
  if (catalogueError) throw catalogueError;

  const metadataByAppId = new Map(((data ?? []) as SteamMetadataRow[]).map((row) => [row.steam_appid, row]));
  const catalogueByAppId = new Map((catalogueData ?? []).map((row) => [String(row.steam_appid), row]));

  return games.map((game) => {
    const appid = game.steam_appid ? String(game.steam_appid) : "";
    const metadata = metadataByAppId.get(appid);
    const catalogue = catalogueByAppId.get(appid);
    const steamTags = normaliseSteamTags(catalogue?.tags);
    const catalogueGenre = Array.isArray(catalogue?.genres) ? catalogue.genres.filter(Boolean).join(", ") : "";
    const tagGenre = steamTagGenreLabels(steamTags).join(", ");
    const genre = metadata?.genre && !UNKNOWN_GENRES.has(metadata.genre)
      ? normaliseSteamGenreLabel(metadata.genre, metadata.title || game.title)
      : catalogueGenre
        ? normaliseSteamGenreLabel(catalogueGenre, catalogue?.name || game.title)
        : tagGenre
          ? normaliseSteamGenreLabel(tagGenre, catalogue?.name || game.title)
          : null;
    const catalogueRating = Number(catalogue?.review_total || 0) > 0
      ? Math.round(Number(catalogue?.review_positive || 0) * 10 / Number(catalogue?.review_total || 1))
      : 0;
    const rating = Number(metadata?.rating || catalogueRating || 0);
    const capsuleUrl = steamImageUrl(appid, "capsule") || metadata?.capsule_url || catalogue?.capsule_url;
    const headerUrl = steamImageUrl(appid, "header") || metadata?.header_url || catalogue?.header_url;
    const nextGame = {
      ...game,
      title: catalogue?.name || game.title,
      rating: rating > 0 ? rating : game.rating,
      capsule_url: capsuleUrl || game.capsule_url || null,
      header_url: headerUrl || game.header_url || null,
      price_currency: metadata?.price_currency ?? catalogue?.price_currency ?? null,
      price_initial: metadata?.price_initial ?? catalogue?.price_initial ?? null,
      price_final: metadata?.price_final ?? catalogue?.price_final ?? null,
      discount_percent: metadata?.discount_percent ?? catalogue?.discount_percent ?? null,
      is_free: Boolean(metadata?.is_free ?? catalogue?.is_free),
      main_story_minutes: catalogue?.main_story_minutes ?? null,
      main_extras_minutes: catalogue?.main_extras_minutes ?? null,
      completionist_minutes: catalogue?.completionist_minutes ?? null,
      duration_source: catalogue?.duration_source ?? null,
      duration_source_updated_at: catalogue?.duration_source_updated_at ?? null,
      duration_confidence: catalogue?.duration_confidence ?? null,
      duration_kind: catalogue?.duration_kind ?? null,
      steam_tags: steamTags
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

  const refreshBefore = new Date(Date.now() - METADATA_REFRESH_AFTER_MS).toISOString();
  const { error: refreshError } = await supabase
    .from("steam_app_metadata")
    .update({ status: "pending", last_error: null })
    .in("steam_appid", uniqueAppIds)
    .eq("status", "ready")
    .lt("checked_at", refreshBefore);

  if (refreshError && !isMissingMetadataTable(refreshError)) throw refreshError;

  return rows.length;
}

export async function enrichSteamMetadataForUser(userId: string, limit = 12, force = false, wishlistOnly = false) {
  const supabase = getSupabaseAdmin();
  let gameQuery = supabase
    .from("games")
    .select("steam_appid, ownership")
    .eq("user_id", userId)
    .not("steam_appid", "is", null);
  if (wishlistOnly) gameQuery = gameQuery.eq("ownership", "Wishlist");
  const { data: gameData, error: gameError } = await gameQuery;

  if (gameError) throw gameError;

  const appIds = uniqueSteamAppIds((gameData ?? []).map((game) => String(game.steam_appid ?? "")));
  if (!appIds.length) return { processed: 0, updated: 0, remaining: 0 };

  await queueSteamMetadata(appIds);
  if (force) {
    clearSteamAppDetailsCache(appIds);
    const { error: forceError } = await supabase
      .from("steam_app_metadata")
      .update({ status: "pending", last_error: null })
      .in("steam_appid", appIds);

    if (forceError && !isMissingMetadataTable(forceError) && !isMissingArtworkColumns(forceError)) throw forceError;
  }

  const { data: pendingData, error: pendingError } = await supabase
    .from("steam_app_metadata")
    .select("steam_appid, status, checked_at, failure_count")
    .in("steam_appid", appIds)
    .eq("status", "pending")
    .order("checked_at", { ascending: true, nullsFirst: true })
    .limit(clampLimit(limit));

  if (isMissingMetadataTable(pendingError)) return { processed: 0, updated: 0, remaining: 0 };
  if (pendingError) throw pendingError;

  const pendingRows = (pendingData ?? []) as SteamMetadataRow[];
  if (!pendingRows.length) return { processed: 0, updated: 0, remaining: 0 };

  let updated = 0;
  for (const chunk of chunks(pendingRows, 2)) {
    const results = await Promise.allSettled(
      chunk.map((row) => fetchAndStoreMetadata(row.steam_appid, force, Number(row.failure_count || 0)))
    );
    updated += results.filter((result) => result.status === "fulfilled" && result.value).length;
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

export async function queueAllKnownSteamMetadata() {
  const supabase = getSupabaseAdmin();
  const appIds = new Set<string>();
  const pageSize = 1_000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("catalog_games")
      .select("steam_appid")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) appIds.add(String(row.steam_appid));
    if ((data ?? []).length < pageSize) break;
  }

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("games")
      .select("steam_appid")
      .not("steam_appid", "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) appIds.add(String(row.steam_appid));
    if ((data ?? []).length < pageSize) break;
  }

  const ids = uniqueSteamAppIds([...appIds]);
  for (const chunk of chunks(ids, 500)) await queueSteamMetadata(chunk);
  return ids.length;
}

export async function processSteamMetadataQueue(limit = 60, force = false) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("steam_app_metadata")
    .select("steam_appid, status, checked_at, failure_count")
    .eq("status", "pending")
    .order("checked_at", { ascending: true, nullsFirst: true })
    .limit(clampLimit(limit));
  if (error) throw error;

  const rows = (data ?? []) as SteamMetadataRow[];
  let updated = 0;
  let failed = 0;
  for (const chunk of chunks(rows, 2)) {
    const results = await Promise.allSettled(
      chunk.map((row) => fetchAndStoreMetadata(row.steam_appid, force, Number(row.failure_count || 0)))
    );
    updated += results.filter((result) => result.status === "fulfilled" && result.value).length;
    failed += results.filter((result) => result.status === "rejected" || !result.value).length;
  }

  const { count, error: countError } = await supabase
    .from("steam_app_metadata")
    .select("steam_appid", { count: "exact", head: true })
    .eq("status", "pending");
  if (countError) throw countError;
  return { processed: rows.length, updated, failed, remaining: count ?? 0 };
}

async function fetchAndStoreMetadata(appid: string, forceRefresh = false, previousFailureCount = 0) {
  const supabase = getSupabaseAdmin();
  const checkedAt = new Date().toISOString();
  let details: Awaited<ReturnType<typeof fetchSteamAppDetails>>;
  try {
    details = await fetchSteamAppDetails(appid, forceRefresh);
  } catch (error) {
    const failureCount = previousFailureCount + 1;
    const { error: updateError } = await supabase
      .from("steam_app_metadata")
      .update({
        status: "failed",
        checked_at: checkedAt,
        failure_count: failureCount,
        last_error: error instanceof Error ? error.message.slice(0, 500) : "Steam metadata request failed."
      })
      .eq("steam_appid", appid);
    if (updateError) throw updateError;
    throw error;
  }
  const catalogueFallback = await loadCatalogueMetadataFallback(appid);
  if (catalogueFallback) {
    details = mergeSteamMetadata(details, catalogueFallback);
  }
  const title = String(details?.title || "").trim();
  const genre = normaliseSteamGenreLabel(String(details?.genre || "").trim(), title);
  const rating = clamp(Math.round(Number(details?.rating || 0)), 0, 10);
  const reviewTotal = Math.max(0, Math.round(Number(details?.review_total || 0)));
  const reviewPositive = Math.max(0, Math.round(Number(details?.review_positive || 0)));
  const reviewScoreDesc = String(details?.review_score_desc || "").trim();
  const providerCapsuleUrl = String(details?.capsule_url || "").trim();
  const providerHeaderUrl = String(details?.header_url || "").trim();
  const capsuleUrl = steamImageUrl(appid, "capsule") || providerCapsuleUrl;
  const headerUrl = steamImageUrl(appid, "header") || providerHeaderUrl;
  const isUsd = String(details?.price_currency || "").trim().toUpperCase() === "USD";
  const priceCurrency = isUsd ? "USD" : null;
  const priceInitial = isUsd ? cleanPrice(details?.price_initial) : null;
  const priceFinal = isUsd ? cleanPrice(details?.price_final) : null;
  const discountPercent = isUsd ? clamp(Math.round(Number(details?.discount_percent || 0)), 0, 100) : 0;
  const hasGenre = !UNKNOWN_GENRES.has(genre);
  const hasUsefulMetadata = Boolean(
    details && (
      title ||
      hasGenre ||
      rating ||
      reviewTotal ||
      providerCapsuleUrl ||
      providerHeaderUrl ||
      priceCurrency ||
      details.is_free
    )
  );

  const row = {
    steam_appid: appid,
    title: title || null,
    genre: genre || "Unknown",
    rating,
    review_score_desc: reviewScoreDesc || null,
    review_total: reviewTotal,
    review_positive: reviewPositive,
    capsule_url: capsuleUrl || null,
    header_url: headerUrl || null,
    price_currency: priceCurrency,
    price_initial: priceInitial,
    price_final: priceFinal,
    discount_percent: discountPercent,
    is_free: Boolean(details?.is_free),
    status: hasUsefulMetadata ? "ready" : "failed",
    checked_at: checkedAt,
    failure_count: hasUsefulMetadata ? 0 : previousFailureCount + 1,
    last_error: hasUsefulMetadata ? null : "Steam did not return usable app metadata."
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

  return hasUsefulMetadata;
}

async function loadCatalogueMetadataFallback(appid: string): Promise<SteamAppDetails | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("catalog_games")
    .select("name, genres, review_positive, review_total, capsule_url, header_url, price_currency, price_initial, price_final, discount_percent, is_free")
    .eq("steam_appid", appid)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const reviewTotal = Math.max(0, Number(data.review_total || 0));
  const reviewPositive = Math.max(0, Number(data.review_positive || 0));
  return {
    steam_appid: appid,
    store: "Steam",
    title: String(data.name || "").trim(),
    genre: Array.isArray(data.genres) ? data.genres.filter(Boolean).join(" / ") : "Unknown",
    rating: reviewTotal > 0 ? Math.round(reviewPositive * 10 / reviewTotal) : 0,
    review_total: reviewTotal,
    review_positive: reviewPositive,
    capsule_url: data.capsule_url || null,
    header_url: data.header_url || null,
    price_currency: data.price_currency === "USD" ? "USD" : undefined,
    price_initial: data.price_currency === "USD" ? data.price_initial ?? undefined : undefined,
    price_final: data.price_currency === "USD" ? data.price_final ?? undefined : undefined,
    discount_percent: data.price_currency === "USD" ? data.discount_percent ?? 0 : 0,
    is_free: Boolean(data.is_free)
  };
}

function mergeSteamMetadata(
  live: SteamAppDetails | null,
  fallback: SteamAppDetails
): SteamAppDetails {
  if (!live) return fallback;
  const liveGenre = String(live.genre || "").trim();
  return {
    ...fallback,
    ...live,
    title: live.title || fallback.title,
    genre: liveGenre && !UNKNOWN_GENRES.has(liveGenre) ? liveGenre : fallback.genre,
    rating: Number(live.rating || 0) > 0 ? live.rating : fallback.rating,
    review_total: Number(live.review_total || 0) > 0 ? live.review_total : fallback.review_total,
    review_positive: Number(live.review_total || 0) > 0 ? live.review_positive : fallback.review_positive,
    capsule_url: live.capsule_url || fallback.capsule_url,
    header_url: live.header_url || fallback.header_url,
    price_currency: live.price_currency === "USD" ? "USD" : fallback.price_currency,
    price_initial: live.price_currency === "USD" ? live.price_initial : fallback.price_initial,
    price_final: live.price_currency === "USD" ? live.price_final : fallback.price_final,
    discount_percent: live.price_currency === "USD" ? live.discount_percent : fallback.discount_percent,
    is_free: Boolean(live.is_free || fallback.is_free)
  };
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
  return Math.max(1, Math.min(Math.floor(parsed), 100));
}

function isMissingMetadataTable(error: { code?: string } | null) {
  return error?.code === "42P01";
}

function isMissingArtworkColumns(error: { code?: string } | null) {
  return error?.code === "42703";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function cleanPrice(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null;
}

function normaliseSteamTags(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([label, weight]) => [label.trim(), Number(weight)] as const)
    .filter(([label, weight]) => label && Number.isFinite(weight) && weight > 0);
  return entries.length ? Object.fromEntries(entries) : null;
}
