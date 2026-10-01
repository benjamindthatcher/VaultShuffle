import { LIBRARY_SORTS, type LibraryQuery } from "../repositories/library-core.ts";
import { InvalidPageQueryError } from "../repositories/page-errors.ts";

const KEYS = ["cursor", "limit", "search", "access", "progress", "length", "genre", "section", "sort", "direction", "device", "deck_rating", "players", "release_age", "game_type", "hide_poorly_reviewed", "excluded", "exclude_pins", "exclude_collection"];

export function libraryQuery(params: URLSearchParams): LibraryQuery {
  if (params.toString().length > 4096) throw new InvalidPageQueryError();
  for (const key of params.keys()) {
    if (!KEYS.includes(key) || (key !== "genre" && key !== "excluded" && params.getAll(key).length > 1)) throw new InvalidPageQueryError();
  }
  const rawLimit = params.get("limit");
  if (rawLimit !== null && (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)) throw new InvalidPageQueryError();
  const search = params.get("search") ?? undefined;
  const cursor = params.get("cursor") ?? undefined;
  const genres = params.getAll("genre");
  if ((search?.length ?? 0) > 120 || (cursor !== undefined && (cursor.length === 0 || cursor.length > 2048))
    || genres.length > 18 || genres.some(value => value.trim().length < 1 || value.length > 80)) throw new InvalidPageQueryError();
  return {
    cursor, search, genres, limit: rawLimit === null ? undefined : Number(rawLimit),
    access: choice(params, "access", ["all", "owned", "family"]),
    progress: choice(params, "progress", ["any", "not-started", "in-progress"]),
    length: choice(params, "length", ["any", "under-10", "10-30", "over-30", "endless"]),
    section: choice(params, "section", ["active", "completed", "blacklisted", "all"]) ?? "active",
    sort: choice(params, "sort", LIBRARY_SORTS),
    direction: choice(params, "direction", ["asc", "desc"]),
    excludePins: flag(params, "exclude_pins"),
    excludeCollection: params.get("exclude_collection") ?? undefined,
    globalFilters: {
      device: choice(params, "device", ["all", "mac", "linux", "deck"]) ?? "all",
      deckRating: choice(params, "deck_rating", ["verified-playable", "verified"]) ?? "verified-playable",
      players: choice(params, "players", ["any", "single", "coop", "multi"]) ?? "any",
      releaseAge: choice(params, "release_age", ["any", "recent", "modern", "established", "classic"]) ?? "any",
      gameType: choice(params, "game_type", ["all", "finite", "endless"]) ?? "all",
      access: choice(params, "access", ["all", "owned", "family"]) ?? "all",
      hidePoorlyReviewed: flag(params, "hide_poorly_reviewed") ?? false,
      excluded: params.getAll("excluded"),
    },
  };
}

function flag(params: URLSearchParams, key: string) {
  const value = params.get(key);
  if (value === null) return undefined;
  if (value !== "0" && value !== "1") throw new InvalidPageQueryError();
  return value === "1";
}

function choice<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[]): T | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  const match = allowed.find(item => item === value);
  if (match === undefined) throw new InvalidPageQueryError();
  return match;
}

export function libraryGameId(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) throw new InvalidPageQueryError();
  return Number(value);
}
