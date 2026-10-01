import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase";
import { HttpError } from "@/lib/http";
import { type WishlistGame } from "@/lib/wishlist";
import { steamHeaderImage } from "@/lib/steam-images";
import { fetchSteamWishlistIds, SteamWishlistError } from "@/lib/steam-wishlist";
import { playNextTagProfile } from "@/lib/play-next";
import { createWishlistStoreLoader, type StoreCacheEntry, type WishlistStoreCache } from "@/lib/wishlist-store-cache";
import { isV2Authority } from "@/lib/database-authority";
import { getV2Runtime } from "@/lib/v2/runtime";

const storeCache: WishlistStoreCache = {
  async claim(appId, country, token) {
    if (isV2Authority()) return (await getV2Runtime()).store.claim(appId,country,token);
    const { data, error } = await getSupabaseAdmin().rpc("claim_wishlist_store_refresh", { p_appid: appId, p_country: country, p_token: token });
    if (error) throw error;
    return data as StoreCacheEntry;
  },
  async read(appId, country) {
    if (isV2Authority()) return (await getV2Runtime()).store.read(appId,country);
    const { data, error } = await getSupabaseAdmin().from("wishlist_store_cache").select("game,checked_at,expires_at,retry_after,lease_until").eq("steam_appid", appId).eq("country", country).single();
    if (error) throw error;
    return data as StoreCacheEntry;
  },
  async finish(appId, country, token, game, checkedAt, expiresAt) {
    if (isV2Authority()) return (await getV2Runtime()).store.finish(appId,country,token,game,checkedAt,expiresAt);
    const { error } = await getSupabaseAdmin().from("wishlist_store_cache").update({ game, checked_at: checkedAt, expires_at: expiresAt, retry_after: new Date(0).toISOString(), lease_token: null, lease_until: new Date(0).toISOString() }).eq("steam_appid", appId).eq("country", country).eq("lease_token", token);
    if (error) throw error;
  },
  async fail(appId, country, token, retryAfter) {
    if (isV2Authority()) return (await getV2Runtime()).store.fail(appId,country,token,retryAfter);
    const { error } = await getSupabaseAdmin().from("wishlist_store_cache").update({ retry_after: retryAfter, lease_token: null, lease_until: new Date(0).toISOString() }).eq("steam_appid", appId).eq("country", country).eq("lease_token", token);
    if (error) throw error;
  },
};
const loadStoreGame = createWishlistStoreLoader(storeCache, fetchSteamWishlistGame);

const COLUMNS = "steam_appid,name,header_url,genres,tags,main_story_minutes,duration_kind,review_positive,review_total";
type CatalogueRow = { steam_appid: number; name: string; header_url: string | null; genres: string[] | null; tags: Record<string, number> | null; main_story_minutes: number | null; duration_kind: string | null; review_positive: number | null; review_total: number | null };

async function steamJson(url: string, revalidate = 300) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000), ...(revalidate ? { next: { revalidate } } : { cache: "no-store" as const }) });
    if (!response.ok) throw new Error(`Steam returned ${response.status}`);
    return await response.json();
  } catch { throw new HttpError("Steam is unavailable right now. Please try again in a moment.", 502); }
}

export function fromCatalogue(row: CatalogueRow): WishlistGame {
  return { appId: Number(row.steam_appid), title: row.name, image: row.header_url || steamHeaderImage(row.steam_appid), genres: row.genres ?? [], tags: playNextTagProfile(row.tags), minutes: row.main_story_minutes, endless: row.duration_kind === "endless", positive: row.review_positive, reviews: row.review_total };
}

export async function wishlistGames(appIds: number[]): Promise<WishlistGame[]> {
  if (!appIds.length) return [];
  const data = await catalogueRows(appIds);
  const found = new Map(data.map((row) => [Number(row.steam_appid), fromCatalogue(row)]));
  // Resolve only the visible page, with bounded concurrency. Delisted/private
  // apps remain removable even if Steam no longer supplies their metadata.
  const missing = appIds.filter((id) => !found.has(id));
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(missing.slice(i, i + 4).map(async (id) => {
      try { found.set(id, await steamWishlistGame(id)); } catch { /* Keep the unavailable item below. */ }
    }));
  }
  return appIds.map((id) => found.get(id) ?? { appId: id, title: `Steam app ${id}`, image: steamHeaderImage(id), genres: ["Details unavailable"] });
}

export async function steamWishlistGame(appId: number, country = "GB"): Promise<WishlistGame> {
  return loadStoreGame(appId, country);
}

async function fetchSteamWishlistGame(appId: number, country: string): Promise<WishlistGame> {
  // The database owns freshness; a second cache could renew an old sale price.
  const body = await steamJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${country}&l=english`, 0);
  const app = body?.[String(appId)];
  if (!app?.success || app.data?.type !== "game" || typeof app.data?.name !== "string") throw new HttpError("This Steam app is unavailable or is not a game.", 422);
  const data = app.data;
  const price = data.price_overview;
  return { appId, title: data.name, image: data.header_image || steamHeaderImage(appId), genres: (data.genres ?? []).map((g: { description: string }) => g.description),
    description: plainSteamText(data.short_description ?? ""),
    release: data.release_date?.coming_soon ? `Coming ${data.release_date.date || "soon"}` : undefined,
    price: data.is_free ? { current: "Free to play", discount: 0, country, amountMinor: 0 } : price?.final_formatted ? { current: price.final_formatted, original: price.discount_percent ? price.initial_formatted : undefined, discount: price.discount_percent ?? 0, country, amountMinor: Number.isSafeInteger(price.final) ? price.final : undefined, currency: price.currency } : undefined,
    storeStatus: "available",
  };
}

export async function searchSteamWishlist(query: string): Promise<WishlistGame[]> {
  const data = await steamJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=GB`);
  if (!Array.isArray(data?.items)) throw new HttpError("Steam returned an incomplete search. Please try again.", 502);
  const results: WishlistGame[] = data.items.filter((item: { type?: string; id?: number; name?: string }) => item.type === "app" && Number.isSafeInteger(item.id) && typeof item.name === "string" && !/\b(soundtrack|demo|playtest|dedicated server)\b/i.test(item.name))
    .slice(0, 12).map((item: { id: number; name: string }) => ({ appId: item.id, title: item.name, image: steamHeaderImage(item.id), genres: [] }));
  if (!results.length) return results;
  // Enrich known games so saving a search result can shape recommendations
  // immediately. A catalogue outage must not take Steam search down with it.
  const known = await catalogueRows(results.map(game=>game.appId)).catch(()=>[] as CatalogueRow[]);
  const byId = new Map(((known ?? []) as CatalogueRow[]).map((row) => [Number(row.steam_appid), fromCatalogue(row)]));
  return results.map((game) => byId.get(game.appId) ?? game);
}

export async function importSteamWishlistIds(steamId: string) {
  try { return await fetchSteamWishlistIds(steamId); }
  catch (error) {
    if (error instanceof SteamWishlistError) throw new HttpError(error.message, error.status);
    throw error;
  }
}

export type WishlistRow = { steam_appid: number; source: "local" | "steam"; added_at: string };
export async function listWishlistRows(userId: string) {
  if(isV2Authority()) throw new Error("Use the bounded V2 Wishlist page.");
  const rows: WishlistRow[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await getSupabaseAdmin().from("user_wishlist").select("steam_appid,source,added_at").eq("user_id", userId).order("added_at", { ascending: false }).order("steam_appid").range(start, start + 999);
    if (error) throw error;
    rows.push(...data as WishlistRow[]);
    if (data.length < 1000) return rows;
  }
}

async function catalogueRows(appIds:number[]):Promise<CatalogueRow[]> {
  if (isV2Authority()) return (await getV2Runtime()).store.catalogue(appIds);
  const {data,error}=await getSupabaseAdmin().from("catalog_games").select(COLUMNS).in("steam_appid",appIds);
  if (error) throw error;
  return (data??[]) as CatalogueRow[];
}

/** Display Steam copy as plain text. No upstream HTML is rendered. */
export function plainSteamText(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/&(?:amp|quot|apos|lt|gt|nbsp|#39);/g, (entity) => ({ "&amp;": "&", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " " }[entity] ?? entity)).replace(/\s+/g, " ").trim().slice(0, 1200);
}
