import type { GamePayload } from "./types.ts";

export type CatalogueGameStub = {
  steam_appid: number;
  name: string;
  normalized_name: string;
  first_seen_reason: "user_import";
  metadata_fetched_at: string;
  updated_at: string;
};

const NEVER_FETCHED_AT = "1970-01-01T00:00:00.000Z";

export function catalogueGameStubRows(
  games: Array<Pick<GamePayload, "steam_appid" | "title">>,
  updatedAt = new Date().toISOString()
): CatalogueGameStub[] {
  const stubs = new Map<number, CatalogueGameStub>();

  for (const game of games) {
    const steamAppId = Number(game.steam_appid);
    const name = String(game.title || "").trim();
    if (!Number.isSafeInteger(steamAppId) || steamAppId <= 0 || !name) continue;

    stubs.set(steamAppId, {
      steam_appid: steamAppId,
      name,
      normalized_name: normalizeName(name),
      first_seen_reason: "user_import",
      // The catalogue worker must treat this as incomplete immediately. This
      // row exists only so a new Steam title cannot block the user's import.
      metadata_fetched_at: NEVER_FETCHED_AT,
      updated_at: updatedAt
    });
  }

  return [...stubs.values()];
}

function normalizeName(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
