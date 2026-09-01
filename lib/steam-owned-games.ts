import type { GamePayload } from "./types.ts";
import { SteamApiError } from "./steam-api-error.ts";

export class SteamLibraryUnavailableError extends Error {
  readonly code: "library_empty" | "library_unavailable" | "library_private";
  constructor(code: "library_empty" | "library_unavailable" | "library_private" = "library_unavailable") {
    super(code === "library_empty"
      ? "Steam reports no games available to import for this profile. Check that this is the right profile and that it owns games."
      : code === "library_private"
        ? "This Steam profile is restricted. Set My profile and Game details to Public in Steam’s Privacy Settings, then check again."
        : "Steam did not share a games list. This can happen when Game details are private or there are no visible games. Check the profile and Steam’s Privacy Settings, then try again.");
    this.name = "SteamLibraryUnavailableError";
    this.code = code;
  }
}

export function steamOwnedGamesFromPayload(
  payload: unknown,
  importedOn = new Date().toLocaleDateString("en-GB")
): GamePayload[] {
  const response = isRecord(payload) && isRecord(payload.response) ? payload.response : null;
  if (!response) throw new SteamApiError("owned_games", "steam_invalid_response");
  if (response.games !== undefined && !Array.isArray(response.games)) throw new SteamApiError("owned_games", "steam_invalid_response");
  const games = response && Array.isArray(response.games) ? response.games : [];

  const importedGames = games.flatMap((item): GamePayload[] => {
    if (!isRecord(item)) return [];
    const appid = String(item.appid ?? "").trim();
    const title = String(item.name ?? "").trim();
    if (!appid || !title) return [];
    const minutes = steamPlaytimeMinutes(item.playtime_forever);
    const hours = Math.round(((minutes ?? 0) / 60) * 10) / 10;
    return [{
      title,
      genre: "Unknown",
      store: "Steam",
      ownership: "Owned",
      status: hours > 0 ? "In Progress" : "Not Started",
      rating: 0,
      hours_played: hours,
      completion_percentage: 0,
      priority: "Medium",
      date_added: importedOn,
      last_played_at: steamLastPlayedDate(item.rtime_last_played),
      notes: "",
      steam_appid: appid
    }];
  });

  if (!importedGames.length) {
    if (games.length || Number(response.game_count) > 0) throw new SteamApiError("owned_games", "steam_invalid_response");
    throw new SteamLibraryUnavailableError(response.game_count === 0 ? "library_empty" : "library_unavailable");
  }
  return importedGames;
}

export type SteamPlaytime = { steam_appid: string; minutes: number; last_played_at: string | null };

/** Playtime-only responses need neither names nor Store metadata. Missing is not zero. */
export function steamPlaytimeFromPayload(payload: unknown): SteamPlaytime[] {
  const response = isRecord(payload) && isRecord(payload.response) ? payload.response : null;
  if (!response) throw new SteamApiError("owned_games", "steam_invalid_response");
  if (response.games === undefined) throw new SteamLibraryUnavailableError();
  if (!Array.isArray(response.games)) throw new SteamApiError("owned_games", "steam_invalid_response");
  const byAppId = new Map<string, SteamPlaytime>();
  for (const item of response.games) {
    if (!isRecord(item)) continue;
    const appid = String(item.appid ?? "");
    const minutes = steamPlaytimeMinutes(item.playtime_forever);
    if (!/^[1-9][0-9]*$/.test(appid) || !Number.isSafeInteger(Number(appid)) || Number(appid) > 4_294_967_295 || minutes === null) continue;
    if (!byAppId.has(appid) || minutes > byAppId.get(appid)!.minutes) {
      byAppId.set(appid, { steam_appid: appid, minutes, last_played_at: steamLastPlayedDate(item.rtime_last_played) });
    }
  }
  if (!byAppId.size) throw new SteamLibraryUnavailableError();
  return [...byAppId.values()];
}

function steamPlaytimeMinutes(value: unknown): number | null {
  // Steam sends integer minutes. Reject null, booleans, strings, negatives and overflow.
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : null;
}

/**
 * True when Steam returned a library but no play history whatsoever.
 *
 * The existing error only fires when Steam returns nothing at all. An account
 * with Game details restricted can still return the full games list with every
 * playtime and last-played value stripped, which imports cleanly and leaves the
 * product with nothing to work with: no progress, no dormancy, no session fit.
 * One real account arrived this way with 1,744 games and drew nothing.
 *
 * A brand new account genuinely has no playtime, so this is surfaced as a notice
 * rather than an error, and only for libraries large enough that having played
 * none of them is implausible.
 */
export function steamPlayHistoryMissing(games: GamePayload[]) {
  if (games.length < 25) return false;
  return games.every((game) => !game.hours_played && !game.last_played_at);
}

export type SteamVisibility = {
  libraryVisible: boolean;
  playtimeVisible: boolean;
  lastPlayedVisible: boolean;
  gamesSeen: number;
};

/**
 * What Steam was willing to share about this account.
 *
 * These are three separate permissions in practice, not one. A library can come
 * back complete with playtime but no last-played timestamps at all, which is the
 * state every account here is currently in, and knowing that is the difference
 * between "this person has not played anything" and "Steam did not tell us".
 */
export function steamVisibilityFromGames(games: GamePayload[]): SteamVisibility {
  return {
    libraryVisible: games.length > 0,
    playtimeVisible: games.some((game) => Number(game.hours_played) > 0),
    lastPlayedVisible: games.some((game) => Boolean(game.last_played_at)),
    gamesSeen: games.length
  };
}

function steamLastPlayedDate(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value * 1000 > Date.now() + 300_000) return null;
  const seconds = value;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
