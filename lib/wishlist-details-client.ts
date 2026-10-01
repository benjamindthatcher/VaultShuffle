import type { WishlistGame } from "./wishlist.ts";

export type WishlistDetails = Partial<WishlistGame> & { appId: number };

/** A page-local cache shared by cards and Budget picks. Prices keep the server's
 * expiry, and overlapping requests share the same work. */
export function createWishlistDetailsClient(fetchBatch: (ids: number[], country: string) => Promise<WishlistDetails[]>, now = Date.now) {
  const cache = new Map<string, { game: WishlistDetails; expires: number }>();
  const pending = new Map<string, Promise<WishlistDetails>>();
  const key = (id: number, country: string) => `${country}:${id}`;
  function peek(id: number, country: string) {
    const entry = cache.get(key(id, country));
    return entry && entry.expires > now() ? entry.game : undefined;
  }
  async function load(ids: number[], country: string) {
    const unique = [...new Set(ids)];
    const missing = unique.filter(id => !peek(id, country) && !pending.has(key(id, country)));
    for (let start = 0; start < missing.length; start += 16) {
      const batch = missing.slice(start, start + 16);
      const response = fetchBatch(batch, country);
      for (const appId of batch) {
        const id = key(appId, country);
        const request = response.then(games => {
          const game = games.find(game => game.appId === appId) ?? { appId, storeStatus: "unavailable" as const };
          cache.set(id, { game, expires: Date.parse(game.detailsExpiresAt ?? "") || now() + 120_000 });
          return game;
        }).catch(error => {
          // Retain descriptive data, but never retain a price after failure.
          cache.set(id, { game: { ...cache.get(id)?.game, appId, price: undefined, storeStatus: "unavailable" }, expires: now() + 120_000 });
          throw error;
        }).finally(() => pending.delete(id));
        pending.set(id, request);
      }
    }
    return Promise.all(unique.map(id => peek(id, country) ?? pending.get(key(id, country))!));
  }
  return { load, peek };
}
