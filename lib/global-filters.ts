import type { DemoGame } from "./demo-data.ts";
import { isFamilyAccess } from "./family-sharing.ts";

/**
 * Global filters: the layer above everything else.
 *
 * These sit higher than status, higher than the Vault's session/mood/goal, higher
 * than what is finished. They answer "which games are even on the table for me,
 * ever" - a Mac owner has no use for a Windows-only game in any context, and
 * someone who never wants a live-service treadmill does not want one offered on a
 * Tuesday either.
 *
 * They exist because the average active library here is around five hundred
 * games. Deciding those one at a time through Purge is a thousand taps; saying
 * "nothing older than five years, single-player only" is four. One is a chore and
 * the other is a preference.
 */

/** Steam Deck and Mac, which used to live alone in the Steam player card. */
export type DeviceMode = "all" | "mac" | "linux" | "deck";

export type PlayerMode = "single" | "coop" | "multi";

export type ReleaseAge = "any" | "recent" | "modern" | "established" | "classic";

export type GameType = "all" | "finite" | "endless";

/**
 * Owned outright, or reachable through a Steam family.
 *
 * Belongs at this layer rather than in the Library toolbar for the same reason
 * device does: "I am not borrowing my partner's account tonight" is a standing
 * fact about what is on the table, not a way of looking at a list. Defaults to
 * "all" - somebody who went to the trouble of adding a family member wants the
 * games - and only appears at all once there is a family game to filter.
 */
export type AccessMode = "all" | "owned" | "family";

export type GlobalFilters = {
  device: DeviceMode;
  players: "any" | PlayerMode;
  releaseAge: ReleaseAge;
  gameType: GameType;
  access: AccessMode;
  /** Hide games the crowd has actually judged poorly. See matchesRating. */
  hidePoorlyReviewed: boolean;
};

export const DEFAULT_GLOBAL_FILTERS: GlobalFilters = {
  device: "all",
  players: "any",
  releaseAge: "any",
  gameType: "all",
  access: "all",
  hidePoorlyReviewed: false
};

/**
 * Boundaries picked from what these libraries actually hold, not from round
 * numbers. Across active owned games: 7.7% are under two years old, 25.9% under
 * five, 39.6% are ten years or older and 11.2% are fifteen or older.
 *
 * "Established" is deliberately the mirror of "modern" rather than a third slice,
 * so the four options cover the shelf without leaving a game in no bucket at all.
 */
const RECENT_YEARS = 2;
const MODERN_YEARS = 5;
const CLASSIC_YEARS = 15;

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Steam's own category strings. Crowd tags were the other candidate and cannot
 * carry this: Counter-Strike 2 has thirty thousand votes for "Co-op" and is not a
 * co-op game, so a tag-driven filter would hide the wrong things silently.
 */
const CO_OP_CATEGORIES = ["Co-op", "Online Co-op", "Shared/Split Screen", "LAN Co-op"];
const MULTI_CATEGORIES = ["Multi-player", "Online PvP", "PvP", "LAN PvP", "Shared/Split Screen PvP"];

export function playerModesFromCategories(categories: string[] | null | undefined): PlayerMode[] {
  if (!categories?.length) return [];
  const has = (name: string) => categories.includes(name);
  const modes: PlayerMode[] = [];
  if (has("Single-player")) modes.push("single");
  if (CO_OP_CATEGORIES.some(has)) modes.push("coop");
  if (MULTI_CATEGORIES.some(has)) modes.push("multi");
  return modes;
}

/**
 * Steam Deck compatibility, as Steam resolves it: 3 verified, 2 playable,
 * 1 unsupported, 0 unknown. Unknown is excluded rather than assumed playable -
 * the point of the mode is confidence that a pick will actually run.
 */
function matchesDevice(game: DemoGame, mode: DeviceMode) {
  if (mode === "all") return true;
  if (mode === "mac") return Boolean(game.platforms?.mac);
  // A native Linux build, which is a different question from Deck: the Deck
  // runs most Windows games through Proton, so "verified" and "has a Linux
  // build" are neither the same set nor one inside the other. Someone on a
  // desktop Linux machine wants this one.
  if (mode === "linux") return Boolean(game.platforms?.linux);
  return (game.deckCompatibility ?? 0) >= 2;
}

function matchesPlayers(game: DemoGame, want: GlobalFilters["players"]) {
  if (want === "any") return true;
  // No categories means we do not know how this one is played. A filter that
  // asks a factual question has to leave out what it cannot answer, rather than
  // guess and put a co-op-only game in front of someone playing alone.
  return (game.playerModes ?? []).includes(want);
}

function matchesReleaseAge(game: DemoGame, want: ReleaseAge, now: number) {
  if (want === "any") return true;

  const released = game.releaseDate ? Date.parse(game.releaseDate) : NaN;
  // Same reasoning as players: an undated game is not known to be recent and not
  // known to be a classic, so it sits out whenever the question is asked. That is
  // 3.3% of an average library.
  if (!Number.isFinite(released)) return false;

  const age = (now - released) / YEAR_MS;
  if (want === "recent") return age < RECENT_YEARS;
  if (want === "modern") return age < MODERN_YEARS;
  if (want === "established") return age >= MODERN_YEARS;
  return age >= CLASSIC_YEARS;
}

function matchesGameType(game: DemoGame, want: GameType) {
  if (want === "all") return true;
  const endless = Boolean(game.duration?.endless);
  // "Finite" means "not known to be endless" rather than "known to be finite".
  // Roughly 7% of owned games have no duration verdict, and hiding those over
  // missing metadata is a worse failure than including one treadmill by mistake.
  return want === "endless" ? endless : !endless;
}

/**
 * Poorly reviewed, and only where the crowd is actually saying so.
 *
 * The review count floor is the whole point. Plenty of good small games carry a
 * handful of reviews, and judging those on a ratio would cut exactly the hidden
 * gems this is meant to surface. Below the floor a game is not judged at all.
 */
const MIN_REVIEWS_TO_JUDGE = 50;
const POOR_RATIO = 0.6;

function matchesAccess(game: DemoGame, want: AccessMode) {
  if (want === "all") return true;
  const family = isFamilyAccess(game.accessSource);
  return want === "family" ? family : !family;
}

function matchesRating(game: DemoGame, hidePoorlyReviewed: boolean) {
  if (!hidePoorlyReviewed) return true;
  const total = game.reviewTotal ?? 0;
  if (total < MIN_REVIEWS_TO_JUDGE) return true;
  const positive = game.reviewPositive ?? 0;
  return positive / total >= POOR_RATIO;
}

export function matchesGlobalFilters(game: DemoGame, filters: GlobalFilters, now = Date.now()) {
  return matchesDevice(game, filters.device)
    && matchesPlayers(game, filters.players)
    && matchesReleaseAge(game, filters.releaseAge, now)
    && matchesGameType(game, filters.gameType)
    && matchesAccess(game, filters.access)
    && matchesRating(game, filters.hidePoorlyReviewed);
}

export function isDefaultGlobalFilters(filters: GlobalFilters) {
  return filters.device === "all"
    && filters.players === "any"
    && filters.releaseAge === "any"
    && filters.gameType === "all"
    && filters.access === "all"
    && !filters.hidePoorlyReviewed;
}

/** How many filters are doing something, for the "3 active" badge on the panel. */
export function activeGlobalFilterCount(filters: GlobalFilters) {
  let count = 0;
  if (filters.device !== "all") count += 1;
  if (filters.players !== "any") count += 1;
  if (filters.releaseAge !== "any") count += 1;
  if (filters.gameType !== "all") count += 1;
  if (filters.access !== "all") count += 1;
  if (filters.hidePoorlyReviewed) count += 1;
  return count;
}

/**
 * Read back what was stored, field by field.
 *
 * Anything unrecognised falls back to its default rather than throwing: this
 * comes out of a browser that may hold a shape written by an older release, and
 * a stale value must never be able to empty someone's library.
 */
export function parseGlobalFilters(raw: string | null | undefined): GlobalFilters {
  if (!raw) return DEFAULT_GLOBAL_FILTERS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_GLOBAL_FILTERS;
  }
  if (!parsed || typeof parsed !== "object") return DEFAULT_GLOBAL_FILTERS;

  const value = parsed as Record<string, unknown>;
  const pick = <T extends string>(field: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(field as T) ? (field as T) : fallback;

  return {
    device: pick(value.device, ["all", "mac", "linux", "deck"] as const, "all"),
    players: pick(value.players, ["any", "single", "coop", "multi"] as const, "any"),
    releaseAge: pick(value.releaseAge, ["any", "recent", "modern", "established", "classic"] as const, "any"),
    gameType: pick(value.gameType, ["all", "finite", "endless"] as const, "all"),
    access: pick(value.access, ["all", "owned", "family"] as const, "all"),
    hidePoorlyReviewed: value.hidePoorlyReviewed === true
  };
}
