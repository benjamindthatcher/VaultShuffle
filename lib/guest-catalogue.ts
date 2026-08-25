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
const GUEST_QUERY_SIZE = 6000;

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
};

/**
 * The gates the SQL cannot express: an empty array is not null, "Unknown" is not
 * a genre, and artwork has to actually exist somewhere.
 */
function fullyEnriched(row: GuestCatalogueRow) {
  const genres = (row.genres ?? []).filter((genre) => genre && genre.toLowerCase() !== "unknown");
  if (!genres.length) return false;
  if (!row.short_description?.trim()) return false;
  if (!row.tags || !Object.keys(row.tags).length) return false;
  if (!row.header_url && !row.capsule_url) return false;
  // A guest choosing by session length needs a length to choose by. Endless
  // games qualify because "no ending" is itself an answer.
  const hasDuration = row.main_story_minutes !== null || row.duration_kind === "endless";
  return hasDuration;
}

const loadCachedGuestCatalogue = unstable_cache(
  async () => {
    const supabase = getSupabaseAdmin();
    // PostgREST caps a single response at 1,000 rows on this project, so a plain
    // .limit(6000) would silently return 1,000 and quietly produce a far narrower
    // pool than intended. Paged explicitly instead.
    const collected: GuestCatalogueRow[] = [];
    for (let offset = 0; offset < GUEST_QUERY_SIZE; offset += GUEST_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("catalog_games")
        .select("steam_appid,name,genres,tags,short_description,capsule_url,header_url,review_positive,review_total,main_story_minutes,main_extras_minutes,completionist_minutes,duration_source,duration_source_updated_at,duration_confidence,duration_kind,popularity_rank")
        .eq("steam_type", "game")
        // Nothing half-enriched reaches a guest. A first impression made of
        // "Unknown" genres and missing playthrough lengths is worse than a
        // smaller catalogue, and 16,881 games clear every one of these.
        .not("genres", "is", null)
        .not("short_description", "is", null)
        .not("tags", "is", null)
        .gte("review_total", GUEST_MIN_REVIEWS)
        .order("popularity_rank", { ascending: true, nullsFirst: false })
        .order("review_total", { ascending: false, nullsFirst: false })
        .order("steam_appid", { ascending: true })
        .range(offset, offset + GUEST_PAGE_SIZE - 1);

      if (error) throw error;
      const page = (data ?? []) as GuestCatalogueRow[];
      collected.push(...page);
      if (page.length < GUEST_PAGE_SIZE) break;
    }

    const rows = collected.filter(fullyEnriched);
    const appIds = rows.map((row) => row.steam_appid);
    const { data: quarantined, error: quarantineError } = appIds.length
      ? await supabase
          .from("catalog_game_quarantine")
          .select("steam_appid")
          .in("steam_appid", appIds)
          .eq("review_status", "excluded")
      : { data: [], error: null };

    if (quarantineError) throw quarantineError;
    const excluded = new Set((quarantined ?? []).map((row) => Number(row.steam_appid)));
    return selectGuestPool(rows.filter((row) => !excluded.has(Number(row.steam_appid))))
      .map(guestGameFromCatalogue);
  },
  ["guest-catalogue-v2"],
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
    is_quarantined: false
  };
}
