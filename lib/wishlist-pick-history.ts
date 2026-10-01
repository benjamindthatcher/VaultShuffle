/** Bounded browser history, containing only shown AppIDs, never queued picks.
 * Each account has its own key. Storage failure leaves the in-memory deck usable.
 */
const HISTORY_LIMIT = 6000;
const MARKET_LIMIT = 12;
const validId = (id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0 && Number(id) <= 4294967295;

export function wishlistHistoryStorageKey(account: string) {
  return `vault-wishlist-pick-history-v1:${account}`;
}

export function readWishlistPickHistory(raw: string | null): Map<string, Set<number>> {
  const history = new Map<string, Set<number>>();
  try {
    const entries: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(entries)) return history;
    for (const entry of entries.slice(-MARKET_LIMIT)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, ids] = entry;
      if (typeof key !== "string" || !/^(for-you|short|acclaimed|cheap):[A-Z]{2}$/.test(key) || !Array.isArray(ids)) continue;
      history.set(key, new Set(ids.filter(validId).slice(-HISTORY_LIMIT)));
    }
  } catch { /* A corrupt/blocked preference must not prevent recommendations. */ }
  return history;
}

export function rememberWishlistPicks(history: Map<string, Set<number>>, key: string, ids: number[]) {
  const seen = history.get(key) ?? new Set<number>();
  for (const id of ids) {
    if (!validId(id)) continue;
    seen.delete(id); seen.add(id);
  }
  while (seen.size > HISTORY_LIMIT) seen.delete(seen.values().next().value!);
  // Maintain an LRU of price markets, without losing the current Set reference.
  history.delete(key); history.set(key, seen);
  while (history.size > MARKET_LIMIT) history.delete(history.keys().next().value!);
  return JSON.stringify([...history].map(([key, seen]) => [key, [...seen]]));
}
