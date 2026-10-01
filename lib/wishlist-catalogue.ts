import { selectGuestPool } from "./guest-pool.ts";

export const WISHLIST_CATALOGUE_LANES = ["discovery", "short", "acclaimed", "budget"] as const;
export type WishlistCatalogueLane = typeof WISHLIST_CATALOGUE_LANES[number];
export const WISHLIST_CATALOGUE_LIMITS = { discovery: 6000, short: 3000, acclaimed: 3000, budget: 3000 } as const;
export type WishlistDiscoveryRow = {
  steam_appid: number; name: string; header_url: string | null; genres: string[] | null;
  tags: Record<string, number> | null; main_story_minutes: number | null; duration_kind: string | null;
  review_positive: number | null; review_total: number | null; popularity_rank?: number | null;
  price_currency?: string | null; price_final?: number | null;
};

/** A stored USD price is only a search hint, never a displayed regional price. */
export function hasWishlistBudgetHint(row: WishlistDiscoveryRow) {
  return row.price_currency === "USD" && typeof row.price_final === "number" && row.price_final > 0 && row.price_final <= 2600;
}

/** Reserve depth for each tab instead of letting blockbusters fill every slot. */
export function selectWishlistCatalogue(lanes: Record<WishlistCatalogueLane, WishlistDiscoveryRow[]>, excluded: ReadonlySet<number>) {
  const chosen = new Map<number, WishlistDiscoveryRow>();
  for (const lane of WISHLIST_CATALOGUE_LANES) {
    const eligible = lanes[lane].filter(row => {
      const total = row.review_total ?? 0;
      const quality = (row.review_positive ?? 0) / Math.max(1, total);
      if (excluded.has(Number(row.steam_appid)) || !Number.isSafeInteger(Number(row.steam_appid)) || Number(row.steam_appid) < 1) return false;
      if (!row.name?.trim() || !row.genres?.some(genre => genre && genre.toLowerCase() !== "unknown") || !row.tags || !Object.keys(row.tags).length || total < 50 || quality < 0.7) return false;
      if (lane === "short") return !!row.main_story_minutes && row.main_story_minutes <= 600 && row.duration_kind !== "endless";
      if (lane === "acclaimed" || lane === "budget") return total >= 500 && quality >= 0.84;
      return true;
    });
    for (const row of selectGuestPool(eligible, WISHLIST_CATALOGUE_LIMITS[lane])) chosen.set(Number(row.steam_appid), row);
  }
  return [...chosen.values()];
}
