import type { GamePayload } from "./types.ts";

export class SteamLibraryUnavailableError extends Error {
  constructor() {
    super(
      "Steam sign-in worked, but Steam returned no visible games. In Steam, open Profile > Edit Profile > Privacy Settings, set Game details to Public, then retry the library import."
    );
    this.name = "SteamLibraryUnavailableError";
  }
}

export function steamOwnedGamesFromPayload(
  payload: unknown,
  importedOn = new Date().toLocaleDateString("en-GB")
): GamePayload[] {
  const response = isRecord(payload) && isRecord(payload.response) ? payload.response : null;
  const games = response && Array.isArray(response.games) ? response.games : [];

  const importedGames = games.flatMap((item): GamePayload[] => {
    if (!isRecord(item)) return [];
    const appid = String(item.appid ?? "").trim();
    const title = String(item.name ?? "").trim();
    if (!appid || !title) return [];
    const hours = Math.round((Number(item.playtime_forever ?? 0) / 60) * 10) / 10;
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

  if (!importedGames.length) throw new SteamLibraryUnavailableError();
  return importedGames;
}

function steamLastPlayedDate(value: unknown) {
  const seconds = Number(value ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
