import {
  asObject, canonicalUuid, checkRowLimit, checkRowRunIdentity, ensureArray,
  enumValue, indexAccountMap, libraryFailure, requiredTimestamp, sourceCell,
  steamAppId, validateRunIdentity, type LibraryCell, type LibraryRunIdentity,
} from "./library-shared.ts";
import type { PgTimestamp } from "./scalars.ts";

export type WishlistSourceRow = Readonly<{
  user_id: LibraryCell;
  steam_appid: LibraryCell;
  source: LibraryCell;
  added_at: LibraryCell;
}>;
export type WishlistRecord = Readonly<{
  account_id: number;
  steam_app_id: bigint;
  source: "local" | "steam";
  added_at: PgTimestamp;
}>;

/** Saved AppIDs do not pass through the catalogue/game map. No stubs or
 * ownership are invented for upcoming, unavailable or unknown games. */
export function transformWishlist(input: Readonly<{
  runIdentity: LibraryRunIdentity;
  accountMap: unknown;
  rows: readonly WishlistSourceRow[];
}>): Readonly<{ wishlist_games: readonly WishlistRecord[] }> {
  const run = validateRunIdentity(input.runIdentity);
  const accounts = indexAccountMap(input.accountMap, run);
  const rows = ensureArray(input.rows, "user_wishlist");
  checkRowLimit(rows, "user_wishlist", 20_000_000);
  const seen = new Set<string>();
  const output = rows.map((raw) => {
    const row = asObject(raw, "user_wishlist");
    checkRowRunIdentity(row, run, "user_wishlist");
    const owner = canonicalUuid(sourceCell(row, "user_id", "user_wishlist"), "user_wishlist", "user_id");
    const account_id = accounts.lookup(owner.canonical);
    const steam_app_id = steamAppId(sourceCell(row, "steam_appid", "user_wishlist"), "user_wishlist", "steam_appid").target;
    const key = `${account_id}:${steam_app_id}`;
    if (seen.has(key)) libraryFailure("library_duplicate_identity", "user_wishlist");
    seen.add(key);
    return Object.freeze({
      account_id, steam_app_id,
      source: enumValue(sourceCell(row, "source", "user_wishlist"), ["local", "steam"], "user_wishlist", "source"),
      added_at: requiredTimestamp(sourceCell(row, "added_at", "user_wishlist"), "user_wishlist", "added_at"),
    });
  });
  output.sort((a, b) => a.account_id - b.account_id || (a.steam_app_id < b.steam_app_id ? -1 : a.steam_app_id > b.steam_app_id ? 1 : 0));
  return Object.freeze({ wishlist_games: Object.freeze(output) });
}
