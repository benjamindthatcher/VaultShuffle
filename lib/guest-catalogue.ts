import "server-only";

import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { Game } from "@/lib/types";
import { GUEST_POOL_SIZE, selectGuestPool } from "@/lib/guest-pool";

/**
 * Candidates pulled before selection. Comfortably more than the pool so
 * selectGuestPool has enough of every niche to choose from; the query is cached
 * for an hour, so the cost is one read per hour rather than per guest.
 */
const GUEST_QUERY_SIZE = 3000;

/**
 * Minimum reviews to be worth recommending to someone who has never used the
 * product. Not a quality judgement so much as evidence that enough people have
 * played it for the recommendation to mean anything.
 */
const GUEST_MIN_REVIEWS = 50;

/** PostgREST caps responses at 1,000 rows on this project. */
const GUEST_PAGE_SIZE = 1000;

type GuestCatalogueRow = {
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
  categories: string[] | null;
  release_date: string | null;
  platform_windows: boolean | null;
  platform_mac: boolean | null;
  platform_linux: boolean | null;
  deck_compatibility: number | null;
};

/** An empty array is not null, and "Unknown" is not a genre. */
function hasRealGenres(genres: string[] | null | undefined) {
  return (genres ?? []).some((genre) => genre && genre.toLowerCase() !== "unknown");
}

function hasTags(tags: Record<string, number> | null | undefined) {
  return Boolean(tags && Object.keys(tags).length);
}

/**
 * The gates the SQL cannot express: an empty array is not null, "Unknown" is not
 * a genre, and artwork has to actually exist somewhere.
 */
function fullyEnriched(row: GuestCatalogueRow) {
  if (!hasRealGenres(row.genres)) return false;
  if (!row.short_description?.trim()) return false;
  if (!hasTags(row.tags)) return false;
  if (!row.header_url && !row.capsule_url) return false;
  // A guest choosing by session length needs a length to choose by. Endless
  // games qualify because "no ending" is itself an answer.
  const hasDuration = row.main_story_minutes !== null || row.duration_kind === "endless";
  return hasDuration;
}

// release_date, categories and the platform columns are here for the global
// filters. Without them every filter reads "no" for every guest game and empties
// the catalogue on the dashboard - which is the first thing a visitor sees.
const FULL_ROW_COLUMNS =
  "steam_appid,name,genres,categories,tags,short_description,capsule_url,header_url,review_positive,review_total,main_story_minutes,main_extras_minutes,completionist_minutes,duration_source,duration_source_updated_at,duration_confidence,duration_kind,popularity_rank,release_date,platform_windows,platform_mac,platform_linux,deck_compatibility";

/** Only what selection needs. See the note in loadCachedGuestCatalogue. */
const CANDIDATE_COLUMNS = "steam_appid,genres,tags,popularity_rank,review_total";

type GuestCandidateRow = Pick<GuestCatalogueRow, "steam_appid" | "genres" | "tags" | "popularity_rank" | "review_total">;

/**
 * Work out which games belong in the guest pool.
 *
 * Expensive: it scans and sorts every eligible game in the catalogue. Exported
 * so the nightly worker can run it once and store the answer, rather than a
 * guest paying for it. See buildGuestCataloguePool.
 */
export async function selectGuestCatalogueAppIds(): Promise<number[]> {
  const supabase = getSupabaseAdmin();

  // Two phases, because fetching every column for thousands of candidates is
  // what matters here - descriptions and tag maps are most of the payload, and
  // pulling 6,000 of them took 16 seconds and failed outright, dropping guests
  // onto the bundled fallback.
  //
  // Phase one reads only the columns selection actually reasons about. Phase
  // two fetches the full rows for the thousand games that survive. Measured
  // against the real catalogue, 3,000 candidates cover exactly as many niches
  // as 6,000 did, so the smaller scan costs nothing in variety.
  //
  // PostgREST caps a response at 1,000 rows on this project, so both phases
  // page explicitly. A plain .limit(3000) returns 1,000 rows without error.
  const candidates: GuestCandidateRow[] = [];
  for (let offset = 0; offset < GUEST_QUERY_SIZE; offset += GUEST_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("catalog_games")
      .select(CANDIDATE_COLUMNS)
      .eq("steam_type", "game")
      // Nothing half-enriched reaches a guest. A first impression made of
      // "Unknown" genres and missing playthrough lengths is worse than a
      // smaller catalogue, and 16,881 games clear every one of these.
      .not("genres", "is", null)
      .not("short_description", "is", null)
      .not("tags", "is", null)
      .gte("review_total", GUEST_MIN_REVIEWS)
      .or("header_url.not.is.null,capsule_url.not.is.null")
      .or("main_story_minutes.not.is.null,duration_kind.eq.endless")
      .order("popularity_rank", { ascending: true, nullsFirst: false })
      .order("review_total", { ascending: false, nullsFirst: false })
      .order("steam_appid", { ascending: true })
      .range(offset, offset + GUEST_PAGE_SIZE - 1);

    if (error) throw error;
    const page = (data ?? []) as GuestCandidateRow[];
    candidates.push(...page);
    if (page.length < GUEST_PAGE_SIZE) break;
  }

  const { data: quarantined, error: quarantineError } = await supabase
    .from("catalog_game_quarantine")
    .select("steam_appid")
    .eq("review_status", "excluded");
  if (quarantineError) throw quarantineError;
  const excluded = new Set((quarantined ?? []).map((row) => Number(row.steam_appid)));

  const eligible = candidates.filter((row) =>
    !excluded.has(Number(row.steam_appid)) && hasRealGenres(row.genres) && hasTags(row.tags));

  return selectGuestPool(eligible).map((row) => Number(row.steam_appid));
}

/** Fetch and shape the given games, preserving the order they are asked for. */
async function loadGuestGamesByAppId(appIds: number[]) {
  if (!appIds.length) return [];
  const supabase = getSupabaseAdmin();
  const order = new Map(appIds.map((appId, index) => [appId, index]));

  const full: GuestCatalogueRow[] = [];
  for (let offset = 0; offset < appIds.length; offset += GUEST_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("catalog_games")
      .select(FULL_ROW_COLUMNS)
      .in("steam_appid", appIds.slice(offset, offset + GUEST_PAGE_SIZE));
    if (error) throw error;
    full.push(...((data ?? []) as GuestCatalogueRow[]));
  }

  // fullyEnriched should be a no-op after the SQL gates; it stays as the
  // backstop for the conditions SQL cannot express.
  return full
    .filter(fullyEnriched)
    .sort((left, right) =>
      (order.get(Number(left.steam_appid)) ?? Infinity) - (order.get(Number(right.steam_appid)) ?? Infinity))
    .map(guestGameFromCatalogue);
}

/**
 * Recompute the stored pool. Run nightly, so no guest ever pays for selection.
 */
export async function buildGuestCataloguePool(): Promise<number> {
  const appIds = await selectGuestCatalogueAppIds();
  if (!appIds.length) throw new Error("Guest pool selection returned no games.");
  const { data, error } = await getSupabaseAdmin().rpc("replace_guest_catalogue_pool", { p_appids: appIds });
  if (error) throw error;
  return Number(data ?? 0);
}

const loadCachedGuestCatalogue = unstable_cache(
  async () => {
    const supabase = getSupabaseAdmin();

    // The fast path: one indexed read of the pool the worker already chose.
    const stored: number[] = [];
    for (let offset = 0; offset < GUEST_POOL_SIZE; offset += GUEST_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("guest_catalogue_pool")
        .select("steam_appid")
        .order("position", { ascending: true })
        .range(offset, offset + GUEST_PAGE_SIZE - 1);
      if (error) throw error;
      const page = data ?? [];
      stored.push(...page.map((row) => Number(row.steam_appid)));
      if (page.length < GUEST_PAGE_SIZE) break;
    }

    if (stored.length) return loadGuestGamesByAppId(stored);

    // Nothing stored yet - a fresh deploy before the worker has run. Do it the
    // slow way once rather than showing a guest the bundled fallback.
    console.warn(JSON.stringify({
      level: "warning",
      message: "Guest catalogue pool is empty; selecting inline",
    }));
    return loadGuestGamesByAppId(await selectGuestCatalogueAppIds());
  },
  // What is cached is the mapped games, not the rows, so the key has to move
  // whenever their shape does - otherwise a deploy that adds a field serves the
  // old shape for up to an hour and looks like it did not work. v5 adds the
  // review counts the reasoning panel needs.
  ["guest-catalogue-v5"],
  { revalidate: 60 * 60, tags: ["guest-catalogue"] }
);

/**
 * Below this the preview stops being a fair demonstration and the smaller
 * bundled fallback is the better answer.
 */
const GUEST_MINIMUM_USABLE = 200;

export async function listGuestCatalogueGames() {
  const games = await loadCachedGuestCatalogue();
  if (games.length < GUEST_MINIMUM_USABLE) {
    throw new Error(`Guest catalogue returned ${games.length} games; expected at least ${GUEST_MINIMUM_USABLE}.`);
  }
  // Falling short of the target is worth knowing about - it means enrichment has
  // regressed - but it is not worth denying every guest a working catalogue over.
  if (games.length < GUEST_POOL_SIZE) {
    console.warn(JSON.stringify({
      level: "warning",
      message: "Guest catalogue is below its target size",
      returned: games.length,
      target: GUEST_POOL_SIZE
    }));
  }
  return games;
}

function guestGameFromCatalogue(row: GuestCatalogueRow): Game {
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
    steam_categories: row.categories ?? null,
    release_date: row.release_date ?? null,
    platform_windows: row.platform_windows ?? null,
    platform_mac: row.platform_mac ?? null,
    platform_linux: row.platform_linux ?? null,
    deck_compatibility: row.deck_compatibility ?? null,
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
