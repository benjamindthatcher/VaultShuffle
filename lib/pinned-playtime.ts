import { getSupabaseAdmin } from "@/lib/supabase";
import { USER_GAMES_READ_MODEL } from "@/lib/game-tables";
import { findGame } from "@/lib/games";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchPinnedSteamPlaytime } from "@/lib/steam";
import { SteamLibraryUnavailableError, type SteamPlaytime } from "@/lib/steam-owned-games";
import type { Game } from "@/lib/types";

export const PINNED_PLAYTIME_COOLDOWN_SECONDS = 60;
const MAX_PINS = 3;

export type PinnedPlaytimeResult = {
  games: Game[];
  refreshed: number;
  skipped: number;
  refreshedAt: string;
  retryAfterSeconds: number;
};

export class PinnedPlaytimeError extends Error {
  readonly code = "library_unavailable";

  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "PinnedPlaytimeError";
  }
}

function steamAppId(value: unknown) {
  const text = String(value ?? "");
  const number = Number(text);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(number) && number <= 4_294_967_295 ? text : null;
}

/** Drop stale/hidden readings; a true zero for an unplayed pin remains valid. */
export function readablePinnedPlaytime(games: Game[], observations: SteamPlaytime[], now = Date.now()) {
  const allowed = new Map(games.map((game) => [String(game.steam_appid), game]));
  return observations.flatMap((observation) => {
    const game = allowed.get(observation.steam_appid);
    if (!game || !Number.isInteger(observation.minutes) || observation.minutes < 0 || observation.minutes > 2_147_483_647) return [];
    const hours = Math.round((observation.minutes / 60) * 10) / 10;
    if (hours < Number(game.hours_played)) return [];
    const exact = observation.last_played_at ? Date.parse(observation.last_played_at) : NaN;
    return [{ ...observation, last_played_at: Number.isFinite(exact) && exact > 0 && exact <= now + 300_000 ? observation.last_played_at : null }];
  });
}

/** No import, catalogue enrichment, duration queue, pin mutation or status write. */
export async function refreshPinnedPlaytime(userId: string, steamId: string): Promise<PinnedPlaytimeResult> {
  const supabase = getSupabaseAdmin();
  const { data: pins, error: pinsError } = await supabase.from("user_game_pins")
    .select("game_id")
    .eq("user_id", userId)
    .eq("scope", "library")
    .order("slot", { ascending: true })
    .limit(MAX_PINS);
  if (pinsError) throw new Error("Could not read pinned games.", { cause: pinsError });
  const pinIds = [...new Set((pins ?? []).map((pin) => String(pin.game_id)))];
  if (!pinIds.length) return { games: [], refreshed: 0, skipped: 0, refreshedAt: new Date().toISOString(), retryAfterSeconds: 0 };

  const { data, error } = await supabase.from(USER_GAMES_READ_MODEL)
    .select("*")
    .eq("user_id", userId)
    .eq("ownership", "Owned")
    .eq("is_quarantined", false)
    .in("id", pinIds);
  if (error) throw new Error("Could not read pinned playtime.", { cause: error });
  const games = ((data ?? []) as Game[]).filter((game) => steamAppId(game.steam_appid));
  if (!games.length) throw new PinnedPlaytimeError("There are no Steam games in these pins to refresh.", 409);
  if (!/^\d{17}$/.test(steamId)) throw new PinnedPlaytimeError("Your Steam profile could not be checked. Please reload and try again.", 409);
  const apiKey = process.env.STEAM_WEB_API_KEY;
  if (!apiKey) throw new Error("Missing required environment variable: STEAM_WEB_API_KEY");

  // A separate allowance from full imports. The Steam allowance also covers
  // multiple browser-only profiles pointing at the same public Steam library.
  for (const [bucket, identity] of [["pinned_playtime_account", userId], ["pinned_playtime_steam", steamId]]) {
    await enforceRateLimit({ bucket, identity, limit: 1, windowSeconds: PINNED_PLAYTIME_COOLDOWN_SECONDS,
      message: "Please wait a minute before refreshing pinned playtime again." });
  }
  let observations: SteamPlaytime[];
  try {
    observations = await fetchPinnedSteamPlaytime(steamId, apiKey, games.map((game) => String(game.steam_appid)));
  } catch (error) {
    if (error instanceof SteamLibraryUnavailableError) {
      throw new PinnedPlaytimeError("Steam did not share readable playtime for these pins. Check that Game details and playtime are public, then try again. Your saved playtime has not changed.", 422);
    }
    throw error;
  }
  if (!observations.length) throw new PinnedPlaytimeError("Steam did not return readable playtime for these pins. Your saved playtime has not changed. Please try again shortly.", 422);
  const readable = readablePinnedPlaytime(games, observations);
  const refreshedAt = new Date().toISOString();
  if (!readable.length) return { games: [], refreshed: 0, skipped: pinIds.length, refreshedAt, retryAfterSeconds: PINNED_PLAYTIME_COOLDOWN_SECONDS };

  // Shared with the background pin refresh. This single transaction locks the
  // account/pins and rechecks ownership/current pins before updating playtime,
  // so an overlapping import or unpin cannot race an app-side read/write pair.
  const { data: result, error: refreshError } = await supabase.rpc("refresh_pinned_steam_playtime", {
    p_user_id: userId,
    p_games: readable,
  });
  if (refreshError) throw new Error("Could not save pinned playtime.", { cause: refreshError });
  const matched = Number(result?.pinned_games_matched);
  if (!Number.isInteger(matched) || matched < 0 || matched > MAX_PINS) throw new Error("Invalid pinned refresh result.");

  const readableAppIds = new Set(readable.map((game) => game.steam_appid));
  const { data: currentPins, error: currentPinsError } = await supabase.from("user_game_pins")
    .select("game_id").eq("user_id", userId).eq("scope", "library").in("game_id", pinIds);
  if (currentPinsError) throw new Error("Could not read refreshed pins.", { cause: currentPinsError });
  const currentIds = new Set((currentPins ?? []).map((pin) => String(pin.game_id)));
  const refreshedGames = (await Promise.all(games
    .filter((game) => currentIds.has(game.id) && readableAppIds.has(String(game.steam_appid)))
    .map((game) => findGame(userId, game.id)))).filter((game): game is Game => Boolean(game));
  const refreshed = Math.min(matched, refreshedGames.length);
  return {
    games: refreshedGames,
    refreshed,
    skipped: pinIds.length - refreshed,
    refreshedAt,
    retryAfterSeconds: PINNED_PLAYTIME_COOLDOWN_SECONDS,
  };
}
