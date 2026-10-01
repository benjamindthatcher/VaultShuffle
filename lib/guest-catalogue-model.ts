import type {Game} from "./types.ts";

export type GuestCatalogueRow = {
  steam_appid: number;
  name: string;
  genres: string[];
  tags: Record<string, number>;
  short_description: string | null;
  capsule_url: string | null;
  header_url: string | null;
  review_positive: number;
  review_total: number | null;
  main_story_minutes: number | null;
  main_extras_minutes: number | null;
  completionist_minutes: number | null;
  duration_source: string | null;
  duration_source_updated_at: string | null;
  duration_confidence: Game["duration_confidence"];
  duration_kind: Game["duration_kind"];
  popularity_rank: number | null;
  price_currency: string | null;
  price_initial: number | null;
  price_final: number | null;
  is_free: boolean | null;
  platform_windows: boolean | null;
  platform_mac: boolean | null;
  platform_linux: boolean | null;
  deck_compatibility: number | null;
  release_date: string | null;
  player_mode: string | null;
  categories: string[] | null;
};

/** An empty array is not null, and "Unknown" is not a genre. */
export function hasRealGenres(genres: string[] | null | undefined) {
  return (genres ?? []).some((genre) => genre && genre.toLowerCase() !== "unknown");
}

export function hasTags(tags: Record<string, number> | null | undefined) {
  return Boolean(tags && Object.keys(tags).length);
}

/**
 * The gates the SQL cannot express: an empty array is not null, "Unknown" is not
 * a genre, and artwork has to actually exist somewhere.
 */
export function fullyEnriched(row: GuestCatalogueRow) {
  if (!hasRealGenres(row.genres)) return false;
  if (!row.short_description?.trim()) return false;
  if (!hasTags(row.tags)) return false;
  if (!row.header_url && !row.capsule_url) return false;
  // A guest choosing by session length needs a length to choose by. Endless
  // games qualify because "no ending" is itself an answer.
  const hasDuration = row.main_story_minutes !== null || row.duration_kind === "endless";
  return hasDuration;
}

export function guestGameFromCatalogue(row: GuestCatalogueRow): Game {
  const appId = Number(row.steam_appid);
  const reviewTotal = Math.max(0, Number(row.review_total || 0));
  const rating = reviewTotal > 0
    ? Math.max(0, Math.min(10, Math.round(Number(row.review_positive || 0) * 10 / reviewTotal)))
    : 0;

  return {
    id: `guest-${appId}`,
    user_id: "",
    title: String(row.name || "").trim(),
    genre: row.genres.filter(Boolean).join(" / ") || "Unknown",
    store: "Steam",
    ownership: "Owned",
    status: "Not Started",
    rating,
    hours_played: 0,
    completion_percentage: 0,
    priority: "Medium",
    date_added: null,
    last_played_at: null,
    // A guest has no private notes. The Steam synopsis now travels in its own
    // field rather than borrowing this one.
    notes: "",
    short_description: String(row.short_description || "").trim(),
    steam_appid: String(appId),
    capsule_url: row.capsule_url,
    header_url: row.header_url,
    main_story_minutes: row.main_story_minutes,
    main_extras_minutes: row.main_extras_minutes,
    completionist_minutes: row.completionist_minutes,
    duration_source: row.duration_source,
    duration_source_updated_at: row.duration_source_updated_at,
    duration_confidence: row.duration_confidence,
    duration_kind: row.duration_kind,
    steam_tags: row.tags,
    price_currency: row.price_currency,
    price_initial: row.price_currency === "USD" ? row.price_initial : null,
    price_final: row.price_currency === "USD" ? row.price_final : null,
    is_free: row.is_free ?? false,
    platform_windows: row.platform_windows,
    platform_mac: row.platform_mac,
    platform_linux: row.platform_linux,
    deck_compatibility: row.deck_compatibility,
    release_date: row.release_date,
    player_mode: row.player_mode,
    steam_categories: row.categories,
    // Carried through, not just folded into the rating above. The reasoning
    // panel judges how a game is regarded from the raw counts - "Hidden gem",
    // "Everyone has played this" - and a rounded 0-10 cannot tell it whether 92%
    // came from four hundred people or four hundred thousand. Dropping these
    // silently cost guests one of the few reasons their session can produce.
    review_positive: Number(row.review_positive || 0),
    review_negative: Math.max(0, reviewTotal - Number(row.review_positive || 0)),
    review_total: reviewTotal,
    is_quarantined: false
  };
}
