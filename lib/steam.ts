import type { GamePayload, SteamPlayerSummary } from "@/lib/types";
import { steamImageUrl } from "@/lib/images";
import { normaliseSteamGenreLabel } from "@/lib/genres";
import { steamOwnedGamesFromPayload } from "@/lib/steam-owned-games";
import { recentlyPlayedAppIdsFromPayload } from "@/lib/steam-recent";

export const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";
const PLAYER_CACHE_MS = 30 * 60 * 1000;
const APP_DETAIL_CACHE_MS = 60 * 60 * 1000;
// Steam's public Store endpoint is sensitive to short bursts, particularly
// from shared cloud egress addresses. Reserve request slots up front so
// concurrent metadata jobs are spaced out instead of waking together.
const STEAM_STORE_MIN_INTERVAL_MS = 650;

type CacheEntry<T> = { expires: number; value: T };
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
  platform_windows?: boolean;
  platform_mac?: boolean;
  platform_linux?: boolean;
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
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: ErrorOptions & { status?: number; retryAfterMs?: number }
  ) {
    super(message, options);
    this.name = "SteamAppRequestError";
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
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

export async function fetchSteamAppDetails(appid: string, forceRefresh = false): Promise<SteamAppDetails | null> {
  const normalizedAppId = String(appid || "").trim();
  if (!normalizedAppId) return null;
  const cached = forceRefresh ? undefined : appDetailCache.get(normalizedAppId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const [, detail] = await fetchSingleSteamAppDetail(normalizedAppId);
  appDetailCache.set(normalizedAppId, { expires: Date.now() + APP_DETAIL_CACHE_MS, value: detail });
  return detail;
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
  return steamOwnedGamesFromPayload(payload);
}

/**
 * Steam's recently-played list: the appids played in roughly the last fortnight.
 *
 * This is the bootstrap for recency. GetOwnedGames will not tell a third-party
 * app when a game was last played, but it will tell us which games were played
 * lately, and that is enough to seed the model on the very first import rather
 * than waiting for our own observations to accumulate.
 *
 * It reports membership of a window, not a moment. Callers must record it as
 * such - see lib/recency.ts - and must not turn it into a date.
 *
 * Secondary to the library import, so a failure here returns nothing rather than
 * throwing: an account whose recently-played list is private, empty, or briefly
 * unavailable must still import its library.
 */
export { recentlyPlayedAppIdsFromPayload };

export async function fetchRecentlyPlayedSteamAppIds(steamId: string, apiKey: string): Promise<number[]> {
  const params = new URLSearchParams({ key: apiKey, steamid: steamId, format: "json" });

  try {
    const response = await fetch(
      `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v0001/?${params.toString()}`,
      { headers: { "User-Agent": "VaultShuffle/0.1" }, cache: "no-store" }
    );
    if (!response.ok) return [];
    const payload = await response.json();
    return recentlyPlayedAppIdsFromPayload(payload);
  } catch {
    return [];
  }
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
      throw new SteamAppRequestError(`Steam Store app details returned HTTP ${response.status}.`, {
        status: response.status,
        retryAfterMs: response.status === 429
          ? parseRetryAfterMs(response.headers.get("retry-after"))
          : undefined
      });
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

function parseRetryAfterMs(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
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
    // Steam already tells us this on the call we are making; it costs nothing.
    platform_windows: Boolean((data.platforms as Record<string, unknown> | undefined)?.windows),
    platform_mac: Boolean((data.platforms as Record<string, unknown> | undefined)?.mac),
    platform_linux: Boolean((data.platforms as Record<string, unknown> | undefined)?.linux),
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


/**
 * Steam Deck compatibility for one app.
 *
 * Not part of appdetails — it lives on its own store endpoint and returns a
 * resolved category: 0 unknown, 1 unsupported, 2 playable, 3 verified. Fetched
 * only for games that have no value yet, so it costs one extra request per game
 * once rather than on every refresh.
 */
export async function fetchSteamDeckCompatibility(appid: string): Promise<number | null> {
  try {
    const response = await fetch(
      `https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport?nAppID=${encodeURIComponent(appid)}&l=english`,
      { headers: { "User-Agent": "VaultShuffle/0.1" }, cache: "no-store" }
    );
    if (!response.ok) return null;
    const payload = await response.json() as { success?: number; results?: { resolved_category?: number } };
    if (!payload?.success || !payload.results) return null;
    const category = Number(payload.results.resolved_category);
    return Number.isFinite(category) ? category : null;
  } catch {
    return null;
  }
}
