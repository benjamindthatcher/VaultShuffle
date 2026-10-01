import "server-only";

import { unstable_cache } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase";
import {fullyEnriched,hasRealGenres,hasTags,guestGameFromCatalogue,type GuestCatalogueRow} from "./guest-catalogue-model.ts";
import {isV2Authority} from "./database-authority.ts";
import {getV2Runtime} from "./v2/runtime.ts";
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

const FULL_ROW_COLUMNS =
  "steam_appid,name,genres,tags,short_description,capsule_url,header_url,review_positive,review_total,main_story_minutes,main_extras_minutes,completionist_minutes,duration_source,duration_source_updated_at,duration_confidence,duration_kind,popularity_rank,price_currency,price_initial,price_final,is_free,platform_windows,platform_mac,platform_linux,deck_compatibility,release_date,player_mode,categories";

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
  async (authority: "legacy"|"v2") => {
    if (authority === "v2") return (await getV2Runtime()).guest.list();
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
  // old shape for up to an hour and looks like it did not work. v7 separates
  // legacy and V2 authority; shared prices/filter metadata stay unchanged.
  ["guest-catalogue-v7-authority"],
  { revalidate: 60 * 60, tags: ["guest-catalogue"] }
);

/**
 * Below this the preview stops being a fair demonstration and the smaller
 * bundled fallback is the better answer.
 */
const GUEST_MINIMUM_USABLE = 200;

export async function listGuestCatalogueGames() {
  const games = await loadCachedGuestCatalogue(isV2Authority()?"v2":"legacy");
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
