import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase";
import { isV2Authority } from "@/lib/database-authority";
import { fromCatalogue } from "@/lib/wishlist-server";
import { WISHLIST_CATALOGUE_LANES, WISHLIST_CATALOGUE_LIMITS, hasWishlistBudgetHint, selectWishlistCatalogue, type WishlistCatalogueLane, type WishlistDiscoveryRow } from "@/lib/wishlist-catalogue";
import type { WishlistGame } from "@/lib/wishlist";
import { getV2Runtime } from "@/lib/v2/runtime";

const COLUMNS = "steam_appid,name,header_url,genres,tags,main_story_minutes,duration_kind,review_positive,review_total,popularity_rank,price_currency,price_final";
// Scan the four lanes without downloading the same large tag map repeatedly.
const CANDIDATE_COLUMNS = "steam_appid,genres,main_story_minutes,duration_kind,review_positive,review_total,popularity_rank,price_currency,price_final";
const PAGE_SIZE = 1000;
type CandidateRow = Omit<WishlistDiscoveryRow, "name" | "header_url" | "tags">;
// One bounded shared snapshot per authority, coalesced locally. The public route
// also caches at the CDN. No account data or live regional prices enter this cache.
const snapshots = new Map<string, { expires: number; promise: Promise<WishlistGame[]> }>();

export function listWishlistCatalogueGames() {
  const authority = isV2Authority() ? "v2" : "legacy";
  const cached = snapshots.get(authority);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (authority === "v2" ? loadV2Catalogue() : loadCatalogue())
    .catch(error => { snapshots.delete(authority); throw error; });
  snapshots.set(authority, { expires: Date.now() + 3600000, promise });
  return promise;
}

async function loadV2Catalogue(): Promise<WishlistGame[]> {
  const rows = await (await getV2Runtime()).wishlistDiscovery.list();
  if (rows.length < 200) throw new Error("Wishlist discovery catalogue is unavailable.");
  return rows.map(row => ({ ...fromCatalogue(row), budgetHint: hasWishlistBudgetHint(row) }));
}

async function loadCatalogue(): Promise<WishlistGame[]> {
  const [results, excluded] = await Promise.all([
    Promise.all(WISHLIST_CATALOGUE_LANES.map(async lane => [lane, await loadLane(lane)] as const)),
    excludedLegacyGames(),
  ]);
  const ids = [...new Set(results.flatMap(([, rows]) => rows.filter(row => !excluded.has(Number(row.steam_appid))
    && (row.review_positive ?? 0) / Math.max(1, row.review_total ?? 0) >= 0.7).map(row => Number(row.steam_appid))))];
  const hydrated = await hydrateGames(ids);
  const byId = new Map(hydrated.map(row => [Number(row.steam_appid), row]));
  const lanes = Object.fromEntries(results.map(([lane, rows]) => [lane,
    rows.flatMap(row => { const full = byId.get(Number(row.steam_appid)); return full ? [full] : []; }),
  ])) as Record<WishlistCatalogueLane, WishlistDiscoveryRow[]>;
  const rows = selectWishlistCatalogue(lanes, excluded);
  if (rows.length < 200) throw new Error("Wishlist discovery catalogue is unavailable.");
  return rows.map(row => ({ ...fromCatalogue({ ...row, genres: row.genres ?? [], tags: row.tags ?? {} }), budgetHint: hasWishlistBudgetHint(row) }));
}

async function loadLane(lane: WishlistCatalogueLane): Promise<CandidateRow[]> {
  const rows: CandidateRow[] = [];
  for (let offset = 0; offset < WISHLIST_CATALOGUE_LIMITS[lane]; offset += PAGE_SIZE) {
    let query = getSupabaseAdmin().from("catalog_games").select(CANDIDATE_COLUMNS).eq("steam_type", "game")
      .not("genres", "is", null).not("tags", "is", null).not("header_url", "is", null)
      .gte("review_total", lane === "budget" || lane === "acclaimed" ? 500 : 50);
    if (lane === "short") query = query.gt("main_story_minutes", 0).lte("main_story_minutes", 600);
    if (lane === "budget") query = query.eq("price_currency", "USD").gt("price_final", 0).lte("price_final", 2600);
    if (lane === "discovery") query = query.order("popularity_rank", { ascending: true, nullsFirst: false });
    const { data, error } = await query.order("review_total", { ascending: false }).order("steam_appid")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data as CandidateRow[]);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function hydrateGames(ids: number[]) {
  const rows: WishlistDiscoveryRow[] = [];
  // Keep URLs and query concurrency bounded; each game's tag map is read once.
  for (let start = 0; start < ids.length; start += 2000) {
    const pages = await Promise.all(Array.from({ length: Math.min(4, Math.ceil((ids.length - start) / 500)) }, async (_, index) => {
      const batch = ids.slice(start + index * 500, start + (index + 1) * 500);
      const { data, error } = await getSupabaseAdmin().from("catalog_games").select(COLUMNS).in("steam_appid", batch);
      if (error) throw error;
      return data as WishlistDiscoveryRow[];
    }));
    rows.push(...pages.flat());
  }
  return rows;
}

async function excludedLegacyGames() {
  const excluded = new Set<number>();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await getSupabaseAdmin().from("catalog_game_quarantine").select("steam_appid")
      .eq("review_status", "excluded").order("steam_appid").range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data) excluded.add(Number(row.steam_appid));
    if (data.length < PAGE_SIZE) return excluded;
  }
}
