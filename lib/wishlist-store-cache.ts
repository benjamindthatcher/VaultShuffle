import type { WishlistGame } from "./wishlist.ts";

export type StoreCacheEntry = {
  game: WishlistGame | null;
  checked_at: string | null;
  expires_at: string;
  retry_after: string;
  lease_until: string;
  claimed?: boolean;
};
export interface WishlistStoreCache {
  claim(appId: number, country: string, token: string): Promise<StoreCacheEntry>;
  read(appId: number, country: string): Promise<StoreCacheEntry>;
  finish(appId: number, country: string, token: string, game: WishlistGame, checkedAt: string, expiresAt: string): Promise<void>;
  fail(appId: number, country: string, token: string, retryAfter: string): Promise<void>;
}

export const STORE_RETRY_MS = 120_000;
export function storeCacheLifetime(game: WishlistGame) {
  return game.price?.discount ? 30 * 60_000 : 6 * 60 * 60_000;
}

function cachedGame(entry: StoreCacheEntry, now: number): WishlistGame {
  if (!entry.game) throw new Error("Steam details are temporarily unavailable.");
  const fresh = Date.parse(entry.expires_at) > now;
  return {
    ...entry.game,
    // Preserve descriptions during an outage, never advertise an expired deal.
    price: fresh ? entry.game.price : undefined,
    storeStatus: fresh ? "available" : "unavailable",
    detailsCheckedAt: entry.checked_at ?? undefined,
    detailsExpiresAt: fresh ? entry.expires_at : new Date(Math.max(now + 30_000, Date.parse(entry.retry_after), Date.parse(entry.lease_until))).toISOString(),
  };
}

/** Only requested games are refreshed. Local promises and database leases
 * coalesce simultaneous requests; there is no catalogue scan or scheduled job. */
export function createWishlistStoreLoader(store: WishlistStoreCache, fetchGame: (id: number, country: string) => Promise<WishlistGame>, now = Date.now, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
  const inFlight = new Map<string, Promise<WishlistGame>>();
  async function load(appId: number, country: string) {
    const token = crypto.randomUUID();
    let entry = await store.claim(appId, country, token);
    if (!entry.claimed) {
      // Another instance may be filling a cold entry. Give it a bounded wait.
      for (let i = 0; !entry.game && Date.parse(entry.lease_until) > now() && i < 6; i++) {
        await sleep(500);
        entry = await store.read(appId, country);
      }
      return cachedGame(entry, now());
    }
    try {
      const game = await fetchGame(appId, country);
      const checkedAt = new Date(now()).toISOString();
      const expiresAt = new Date(now() + storeCacheLifetime(game)).toISOString();
      await store.finish(appId, country, token, game, checkedAt, expiresAt);
      return { ...game, detailsCheckedAt: checkedAt, detailsExpiresAt: expiresAt };
    } catch (error) {
      const retryAfter = new Date(now() + STORE_RETRY_MS).toISOString();
      await store.fail(appId, country, token, retryAfter);
      if (!entry.game) throw error;
      return cachedGame({ ...entry, retry_after: retryAfter, lease_until: new Date(0).toISOString() }, now());
    }
  }
  return (appId: number, country: string) => {
    const key = `${country}:${appId}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = load(appId, country).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  };
}
