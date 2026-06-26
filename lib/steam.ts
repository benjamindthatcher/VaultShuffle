import type { GamePayload, SteamPlayerSummary, SteamSearchResult } from "@/lib/types";

export const STEAM_OPENID_URL = "https://steamcommunity.com/openid/login";
const SEARCH_CACHE_MS = 10 * 60 * 1000;
const PLAYER_CACHE_MS = 30 * 60 * 1000;
const APP_DETAIL_CACHE_MS = 60 * 60 * 1000;
const parsedImportDetailLimit = Number(process.env.STEAM_IMPORT_DETAIL_LIMIT || 60);
const IMPORT_APP_DETAIL_LIMIT = Number.isFinite(parsedImportDetailLimit) ? parsedImportDetailLimit : 60;

type CacheEntry<T> = { expires: number; value: T };
const searchCache = new Map<string, CacheEntry<SteamSearchResult[]>>();
const playerCache = new Map<string, CacheEntry<SteamPlayerSummary | null>>();
const appDetailCache = new Map<string, CacheEntry<Partial<GamePayload> | null>>();

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
    cc: "GB",
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
      genre: steamGenreLabel(item)
    };
  });
  searchCache.set(normalizedTerm, { expires: Date.now() + SEARCH_CACHE_MS, value: results });
  return results;
}

export async function fetchSteamAppDetails(appid: string): Promise<Partial<GamePayload> | null> {
  const normalizedAppId = String(appid || "").trim();
  if (!normalizedAppId) return null;
  const details = await fetchSteamAppDetailsBatch([normalizedAppId]);
  return details.get(normalizedAppId) ?? null;
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
      notes: `Imported from Steam account. AppID: ${appid}`,
      steam_appid: appid
    };
  });

  const detailIds = [...baseGames]
    .sort((a, b) => Number(b.hours_played || 0) - Number(a.hours_played || 0))
    .slice(0, Math.max(0, IMPORT_APP_DETAIL_LIMIT))
    .map((game) => String(game.steam_appid ?? ""));
  const details = await fetchSteamAppDetailsBatch(detailIds);
  return baseGames.map((game) => {
    const appDetails = game.steam_appid ? details.get(String(game.steam_appid)) : null;
    return {
      ...game,
      genre: appDetails?.genre || game.genre
    };
  });
}

async function fetchSteamAppDetailsBatch(appids: string[]) {
  const uniqueAppIds = [...new Set(appids.map((appid) => String(appid || "").trim()).filter(Boolean))];
  const results = new Map<string, Partial<GamePayload>>();
  const missing: string[] = [];

  for (const appid of uniqueAppIds) {
    const cached = appDetailCache.get(appid);
    if (cached && cached.expires > Date.now()) {
      if (cached.value) results.set(appid, cached.value);
    } else {
      missing.push(appid);
    }
  }

  const chunkSize = 6;
  for (let index = 0; index < missing.length; index += chunkSize) {
    const chunk = missing.slice(index, index + chunkSize);
    const chunkResults = await Promise.all(chunk.map(fetchSingleSteamAppDetail));
    for (const [appid, detail] of chunkResults) {
      appDetailCache.set(appid, { expires: Date.now() + APP_DETAIL_CACHE_MS, value: detail });
      if (detail) results.set(appid, detail);
    }
  }

  return results;
}

async function fetchSingleSteamAppDetail(appid: string): Promise<[string, Partial<GamePayload> | null]> {
  const params = new URLSearchParams({
    appids: appid,
    filters: "basic,genres",
    cc: "GB",
    l: "en"
  });

  try {
    const response = await fetch(`https://store.steampowered.com/api/appdetails?${params.toString()}`, {
      headers: { "User-Agent": "VaultShuffle/0.1" },
      cache: "no-store"
    });

    if (!response.ok) return [appid, null];
    const payload = await response.json();
    const data = payload?.[appid]?.data;
    if (!data || payload?.[appid]?.success === false) return [appid, null];
    return [appid, steamDetailPayload(appid, data)];
  } catch {
    return [appid, null];
  }
}

function steamDetailPayload(appid: string, data: Record<string, unknown>): Partial<GamePayload> {
  return {
    title: String(data.name ?? "").trim() || undefined,
    genre: steamGenreLabel(data) || undefined,
    store: "Steam",
    notes: `Added from Steam search. AppID: ${appid}`,
    steam_appid: appid
  };
}

function steamLastPlayedDate(value: unknown) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function steamGenreLabel(item: Record<string, unknown>) {
  const genreList = Array.isArray(item.genres) ? item.genres : [];
  const genres = genreList
    .map((genre) => (typeof genre === "string" ? genre : String((genre as Record<string, unknown>)?.description ?? "")))
    .map((genre) => genre.trim())
    .filter(Boolean);
  if (genres.length) return genres.slice(0, 2).join(" / ");
  const genreText = String(item.genre ?? "").trim();
  return genreText || "";
}
