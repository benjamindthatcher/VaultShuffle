import type { GamePayload, SteamPlayerSummary, SteamSearchResult } from "@/lib/types";
import { steamImageUrl } from "@/lib/images";
import { normaliseSteamGenreLabel } from "@/lib/genres";

export const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";
const SEARCH_CACHE_MS = 10 * 60 * 1000;
const PLAYER_CACHE_MS = 30 * 60 * 1000;
const APP_DETAIL_CACHE_MS = 60 * 60 * 1000;
// Steam's public Store endpoint is sensitive to short bursts, particularly
// from shared cloud egress addresses. Reserve request slots up front so
// concurrent metadata jobs are spaced out instead of waking together.
const STEAM_STORE_MIN_INTERVAL_MS = 650;

type CacheEntry<T> = { expires: number; value: T };
const searchCache = new Map<string, CacheEntry<SteamSearchResult[]>>();
const playerCache = new Map<string, CacheEntry<SteamPlayerSummary | null>>();
export type SteamAppDetails = Partial<GamePayload> & {
  steam_type?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  categories?: string[];
  short_description?: string;
  release_date?: string | null;
  review_score_desc?: string;
  review_total?: number;
  review_positive?: number;
  price_currency?: string;
  price_initial?: number;
  price_final?: number;
  discount_percent?: number;
  is_free?: boolean;
};
const appDetailCache = new Map<string, CacheEntry<SteamAppDetails | null>>();
let nextSteamStoreRequestAt = 0;

export class SteamAppUnavailableError extends Error {
  constructor(appid: string) {
    super(`Steam Store reports AppID ${appid} as unavailable.`);
    this.name = "SteamAppUnavailableError";
  }
}

export class SteamAppRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SteamAppRequestError";
  }
}

export function siteBaseUrl(request?: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (request) return new URL(request.url).origin;
  return "http://localhost:8766";
}

export function steamAuthUrl(baseUrl: string) {
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": `${baseUrl}/api/auth/steam/callback`,
    "openid.realm": `${baseUrl}/`,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select"
  });
  return `${STEAM_OPENID_URL}?${params.toString()}`;
}

export async function verifySteamOpenId(searchParams: URLSearchParams) {
  const params = new URLSearchParams(searchParams);
  params.set("openid.mode", "check_authentication");

  const response = await fetch(STEAM_OPENID_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "VaultShuffle/0.1"
    },
    body: params.toString(),
    cache: "no-store"
  });

  if (!response.ok) return false;
  const text = await response.text();
  return text.includes("is_valid:true");
}

export function steamIdFromOpenId(searchParams: URLSearchParams) {
  const claimedId = searchParams.get("openid.claimed_id") ?? "";
  const match = claimedId.match(/\/id\/(\d+)$/);
  return match?.[1] ?? "";
}

export async function fetchSteamPlayerSummary(steamId: string, apiKey: string): Promise<SteamPlayerSummary | null> {
  const cacheKey = `${apiKey.slice(0, 8)}:${steamId}`;
  const cached = playerCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const params = new URLSearchParams({
    key: apiKey,
    steamids: steamId,
    format: "json"
  });

  const response = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?${params.toString()}`, {
    headers: { "User-Agent": "VaultShuffle/0.1" },
    cache: "no-store"
  });

  if (!response.ok) return null;
  const payload = await response.json();
  const player = Array.isArray(payload?.response?.players) ? payload.response.players[0] : null;
  if (!player) {
    playerCache.set(cacheKey, { expires: Date.now() + PLAYER_CACHE_MS, value: null });
    return null;
  }

  const summary = {
    steam_id: String(player.steamid ?? steamId),
    display_name: String(player.personaname ?? "").trim() || null,
    avatar_url: String(player.avatarfull ?? player.avatarmedium ?? player.avatar ?? "").trim() || null
  };
  playerCache.set(cacheKey, { expires: Date.now() + PLAYER_CACHE_MS, value: summary });
  return summary;
}

export async function searchSteamStore(term: string): Promise<SteamSearchResult[]> {
  const normalizedTerm = term.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalizedTerm.length < 2) return [];
  const cached = searchCache.get(normalizedTerm);
  if (cached && cached.expires > Date.now()) return cached.value;

  const params = new URLSearchParams({
    term: normalizedTerm,
    cc: "US",
    l: "en"
  });

  const response = await fetch(`https://store.steampowered.com/api/storesearch/?${params.toString()}`, {
    headers: { "User-Agent": "VaultShuffle/0.1" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Steam search failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload.items) ? payload.items : [];

  const results = items.slice(0, 12).flatMap((item: Record<string, unknown>) => {
    const appid = String(item.id ?? item.appid ?? "").trim();
    const name = String(item.name ?? "").trim();
    if (!appid || !name) return [];
    return {
      appid,
      name,
      image: String(item.tiny_image ?? `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_184x69.jpg`),
      store_url: `https://store.steampowered.com/app/${appid}/`,
      genre: steamGenreLabel(item, name)
    };
  });
  searchCache.set(normalizedTerm, { expires: Date.now() + SEARCH_CACHE_MS, value: results });
  return results;
}

export async function fetchSteamAppDetails(appid: string, forceRefresh = false): Promise<SteamAppDetails | null> {
  const normalizedAppId = String(appid || "").trim();
  if (!normalizedAppId) return null;
  const cached = forceRefresh ? undefined : appDetailCache.get(normalizedAppId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const [, detail] = await fetchSingleSteamAppDetail(normalizedAppId);
  appDetailCache.set(normalizedAppId, { expires: Date.now() + APP_DETAIL_CACHE_MS, value: detail });
  return detail;
}

export function clearSteamAppDetailsCache(appids: string[]) {
  for (const appid of appids) appDetailCache.delete(String(appid || "").trim());
}

export async function fetchOwnedSteamGames(steamId: string, apiKey: string): Promise<GamePayload[]> {
  const params = new URLSearchParams({
    key: apiKey,
    steamid: steamId,
    include_appinfo: "1",
    include_played_free_games: "1",
    format: "json"
  });

  const response = await fetch(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?${params.toString()}`, {
    headers: { "User-Agent": "VaultShuffle/0.1" },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Steam library import failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const games = Array.isArray(payload?.response?.games) ? payload.response.games : [];
  const today = new Date().toLocaleDateString("en-GB");

  const baseGames: GamePayload[] = games.flatMap((item: Record<string, unknown>) => {
    const appid = String(item.appid ?? "").trim();
    const title = String(item.name ?? "").trim();
    if (!appid || !title) return [];
    const hours = Math.round((Number(item.playtime_forever ?? 0) / 60) * 10) / 10;
    return {
      title,
      genre: "Unknown",
      store: "Steam",
      ownership: "Owned",
      status: hours > 0 ? "In Progress" : "Not Started",
      rating: 0,
      hours_played: hours,
      completion_percentage: 0,
      priority: "Medium",
      date_added: today,
      last_played_at: steamLastPlayedDate(item.rtime_last_played),
      notes: "",
      steam_appid: appid
    };
  });

  return baseGames;
}

export async function fetchPublicSteamWishlist(steamId: string, apiKey: string): Promise<GamePayload[]> {
  const normalizedSteamId = String(steamId || "").trim();
  if (!/^\d{16,20}$/.test(normalizedSteamId)) {
    throw new Error("A valid Steam account is required to import a wishlist.");
  }

  const input = JSON.stringify({ steamid: normalizedSteamId });
  const params = new URLSearchParams({ key: apiKey, input_json: input });
  const response = await fetch(
    `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "VaultShuffle/0.1"
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    }
  );

  if (response.status === 403 || response.status === 401) {
    throw new Error("Steam wishlist access is private. Make your Steam profile and game details public, then try again.");
  }
  if (response.status === 429) {
    throw new Error("Steam is temporarily limiting wishlist imports. Please try again shortly.");
  }
  if (!response.ok) {
    throw new Error(`Steam wishlist import failed with HTTP ${response.status}.`);
  }

  const payload = await response.json() as {
    response?: {
      items?: Array<Record<string, unknown>>;
      wishlist?: Array<Record<string, unknown>>;
    };
  };
  const items = Array.isArray(payload?.response?.items)
    ? payload.response.items
    : Array.isArray(payload?.response?.wishlist) ? payload.response.wishlist : [];
  const wishlistItems = items.flatMap((item) => {
    const appid = String(item.appid ?? item.app_id ?? "").trim();
    if (!/^\d+$/.test(appid)) return [];
    return [{
      appid,
      dateAddedSeconds: Number(item.date_added ?? item.time_added ?? 0)
    }];
  });
  const uniqueItems = [...new Map(wishlistItems.map((item) => [item.appid, item])).values()];
  const details = await fetchSteamAppDetailsBatch(uniqueItems.map((item) => item.appid));

  return uniqueItems.flatMap(({ appid, dateAddedSeconds }) => {
    const detail = details.get(appid);
    const title = String(detail?.title ?? "").trim();
    if (!title) return [];
    return [{
      title,
      genre: normaliseSteamGenreLabel(detail?.genre, title),
      store: "Steam",
      ownership: "Wishlist",
      status: "Not Started",
      rating: Number(detail?.rating ?? 0),
      hours_played: 0,
      completion_percentage: 0,
      priority: "Medium",
      date_added: Number.isFinite(dateAddedSeconds) && dateAddedSeconds > 0
        ? new Date(dateAddedSeconds * 1000).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      last_played_at: null,
      notes: "",
      steam_appid: appid
    } satisfies GamePayload];
  });
}

export async function fetchSteamAppDetailsBatch(appids: string[], forceRefresh = false) {
  const uniqueAppIds = [...new Set(appids.map((appid) => String(appid || "").trim()).filter(Boolean))];
  const results = new Map<string, SteamAppDetails>();
  const missing: string[] = [];

  for (const appid of uniqueAppIds) {
    const cached = forceRefresh ? undefined : appDetailCache.get(appid);
    if (cached && cached.expires > Date.now()) {
      if (cached.value) results.set(appid, cached.value);
    } else {
      missing.push(appid);
    }
  }

  const chunkSize = 6;
  for (let index = 0; index < missing.length; index += chunkSize) {
    const chunk = missing.slice(index, index + chunkSize);
    const settled = await Promise.allSettled(chunk.map(fetchSingleSteamAppDetail));
    for (const result of settled) {
      if (result.status === "rejected") continue;
      const [appid, detail] = result.value;
      appDetailCache.set(appid, { expires: Date.now() + APP_DETAIL_CACHE_MS, value: detail });
      if (detail) results.set(appid, detail);
    }
  }

  return results;
}

async function fetchSingleSteamAppDetail(appid: string): Promise<[string, SteamAppDetails | null]> {
  const params = new URLSearchParams({
    appids: appid,
    cc: "US",
    l: "en"
  });

  // App details are authoritative. A reviews-only response must never be
  // promoted into a partial game record because it has no title, genres or
  // artwork and previously made healthy games look malformed during a rate
  // limit or transient Store failure.
  const details = await fetchSteamStoreAppDetail(appid, params);
  const reviews = await fetchSteamReviewSummary(appid);
  return [appid, { ...details, ...(reviews || {}) }];
}

async function fetchSteamStoreAppDetail(appid: string, params: URLSearchParams): Promise<SteamAppDetails> {
  await waitForSteamStoreRateLimit();
  try {
    const response = await fetch(`https://store.steampowered.com/api/appdetails?${params.toString()}`, {
      headers: { "User-Agent": "VaultShuffle/0.1" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });

    if (!response.ok) {
      throw new SteamAppRequestError(`Steam Store app details returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    if (payload?.[appid]?.success === false) throw new SteamAppUnavailableError(appid);
    const data = payload?.[appid]?.data;
    if (!data || typeof data !== "object") {
      throw new SteamAppRequestError("Steam Store returned an incomplete app-details response.");
    }
    return steamDetailPayload(appid, data);
  } catch (error) {
    if (error instanceof SteamAppUnavailableError || error instanceof SteamAppRequestError) throw error;
    throw new SteamAppRequestError("Steam Store app details request failed.", { cause: error });
  }
}

async function waitForSteamStoreRateLimit() {
  const now = Date.now();
  const requestAt = Math.max(now, nextSteamStoreRequestAt);
  nextSteamStoreRequestAt = requestAt + STEAM_STORE_MIN_INTERVAL_MS;
  const delay = requestAt - now;
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function fetchSteamReviewSummary(appid: string): Promise<SteamAppDetails | null> {
  try {
    const params = new URLSearchParams({
      json: "1",
      language: "all",
      purchase_type: "all",
      num_per_page: "0"
    });

    const response = await fetch(`https://store.steampowered.com/appreviews/${appid}?${params.toString()}`, {
      headers: { "User-Agent": "VaultShuffle/0.1" },
      cache: "no-store"
    });

    if (!response.ok) return null;
    const payload = await response.json();
    const summary = payload?.query_summary;
    if (!summary) return null;
    const total = Number(summary.total_reviews || 0);
    const positive = Number(summary.total_positive || 0);
    const rating = total > 0 ? clamp(Math.round((positive / total) * 10), 1, 10) : 0;
    return {
      rating,
      review_score_desc: String(summary.review_score_desc || "").trim() || undefined,
      review_total: Number.isFinite(total) ? total : 0,
      review_positive: Number.isFinite(positive) ? positive : 0
    };
  } catch {
    return null;
  }
}

function steamDetailPayload(appid: string, data: Record<string, unknown>): SteamAppDetails {
  const headerImage = String(data.header_image ?? "").trim();
  const price = data.price_overview && typeof data.price_overview === "object"
    ? data.price_overview as Record<string, unknown>
    : null;
  return {
    steam_type: String(data.type ?? "").trim().toLowerCase() || undefined,
    title: String(data.name ?? "").trim() || undefined,
    genre: steamGenreLabel(data, String(data.name ?? "")) || undefined,
    store: "Steam",
    notes: "",
    steam_appid: appid,
    capsule_url: steamImageUrl(appid, "capsule"),
    header_url: headerImage || steamImageUrl(appid, "header"),
    price_currency: cleanCurrency(price?.currency),
    price_initial: cleanMinorUnits(price?.initial),
    price_final: cleanMinorUnits(price?.final),
    discount_percent: clamp(Math.round(Number(price?.discount_percent || 0)), 0, 100),
    is_free: Boolean(data.is_free),
    developers: stringList(data.developers),
    publishers: stringList(data.publishers),
    genres: descriptionList(data.genres),
    categories: descriptionList(data.categories),
    short_description: String(data.short_description ?? "").trim() || undefined,
    release_date: steamReleaseDate(data.release_date)
  };
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}
function descriptionList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item : String((item as Record<string, unknown>)?.description ?? ""))
    .map((item) => item.trim()).filter(Boolean);
}
function steamReleaseDate(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const raw = String((value as Record<string, unknown>).date ?? "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function cleanCurrency(value: unknown) {
  const currency = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

function cleanMinorUnits(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : undefined;
}

function steamLastPlayedDate(value: unknown) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function steamGenreLabel(item: Record<string, unknown>, title = "") {
  const genreList = Array.isArray(item.genres) ? item.genres : [];
  const genres = genreList
    .map((genre) => (typeof genre === "string" ? genre : String((genre as Record<string, unknown>)?.description ?? "")))
    .map((genre) => genre.trim())
    .filter(Boolean);
  const genreText = String(item.genre ?? "").trim();
  const allGenres = [...genres, ...genreText.split(/[\/,;|]+/g)];
  return normaliseSteamGenreLabel(allGenres, title);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}
