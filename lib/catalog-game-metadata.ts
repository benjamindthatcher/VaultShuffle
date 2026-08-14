import { getSupabaseAdmin } from "@/lib/supabase";
import { normaliseSteamGenreLabel, steamTagGenreLabels } from "@/lib/genres";
import { steamImageUrl } from "@/lib/images";
import type { Game, GamePayload } from "@/lib/types";

const UNKNOWN_GENRES = new Set(["", "Unknown"]);

/**
 * Enrich an in-memory Steam payload from the canonical catalogue. This is
 * needed while an owned-games payload is being imported; persisted reads use
 * the database `user_games_with_catalog` read model directly.
 */
export async function applyCatalogueMetadata<T extends GamePayload | Game>(games: T[]): Promise<T[]> {
  const appIds = uniqueSteamAppIds(games);
  if (!appIds.length) return games;

  const { data, error } = await getSupabaseAdmin()
    .from("catalog_games")
    .select("steam_appid, name, genres, tags, capsule_url, header_url, review_positive, review_total, price_currency, price_initial, price_final, discount_percent, is_free, main_story_minutes, main_extras_minutes, completionist_minutes, duration_source, duration_source_updated_at, duration_confidence, duration_kind")
    .in("steam_appid", appIds);
  if (error) throw error;

  const catalogueByAppId = new Map((data ?? []).map((row) => [String(row.steam_appid), row]));
  return games.map((game) => {
    const appid = String(game.steam_appid ?? "");
    const catalogue = catalogueByAppId.get(appid);
    if (!catalogue) return game;

    const steamTags = normaliseSteamTags(catalogue.tags);
    const catalogueGenre = Array.isArray(catalogue.genres)
      ? catalogue.genres.filter(Boolean).join(", ")
      : "";
    const tagGenre = steamTagGenreLabels(steamTags).join(", ");
    const genre = catalogueGenre
      ? normaliseSteamGenreLabel(catalogueGenre, catalogue.name || game.title)
      : tagGenre
        ? normaliseSteamGenreLabel(tagGenre, catalogue.name || game.title)
        : null;
    const reviewTotal = Number(catalogue.review_total || 0);
    const catalogueRating = reviewTotal > 0
      ? Math.round(Number(catalogue.review_positive || 0) * 10 / reviewTotal)
      : 0;

    return {
      ...game,
      title: catalogue.name || game.title,
      genre: genre && UNKNOWN_GENRES.has(String(game.genre || "")) ? genre : game.genre,
      rating: catalogueRating > 0 ? catalogueRating : game.rating,
      capsule_url: steamImageUrl(appid, "capsule") || catalogue.capsule_url || game.capsule_url || null,
      header_url: steamImageUrl(appid, "header") || catalogue.header_url || game.header_url || null,
      price_currency: catalogue.price_currency ?? null,
      price_initial: catalogue.price_initial ?? null,
      price_final: catalogue.price_final ?? null,
      discount_percent: catalogue.discount_percent ?? null,
      is_free: Boolean(catalogue.is_free),
      main_story_minutes: catalogue.main_story_minutes ?? null,
      main_extras_minutes: catalogue.main_extras_minutes ?? null,
      completionist_minutes: catalogue.completionist_minutes ?? null,
      duration_source: catalogue.duration_source ?? null,
      duration_source_updated_at: catalogue.duration_source_updated_at ?? null,
      duration_confidence: catalogue.duration_confidence ?? null,
      duration_kind: catalogue.duration_kind ?? null,
      steam_tags: steamTags
    };
  });
}

function uniqueSteamAppIds(games: Array<Pick<GamePayload, "steam_appid">>) {
  return [...new Set(
    games
      .map((game) => Number(game.steam_appid))
      .filter((appid) => Number.isSafeInteger(appid) && appid > 0)
  )];
}

function normaliseSteamTags(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([tag, weight]) => [tag.trim(), Math.max(0, Number(weight) || 0)] as const)
      .filter(([tag, weight]) => Boolean(tag) && weight > 0)
  );
}
