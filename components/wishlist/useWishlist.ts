"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "@/lib/api-client";
import { readGuestWishlist, type WishlistGame, type WishlistInteractionContext } from "@/lib/wishlist";
import { ANALYTICS_EVENTS, trackEvent } from "@/lib/analytics";

const GUEST_KEY = "vault-wishlist-guest-v1";
type WishlistPayload = { games: WishlistGame[]; appIds: number[]; total: number };
type WishlistOperation = "save" | "remove" | "import" | "load_more";

export function useWishlist(isLive: boolean) {
  const [games, setGames] = useState<WishlistGame[]>([]);
  const [appIds, setAppIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ operation: WishlistOperation; appId?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [importSummary, setImportSummary] = useState("");
  const lock = useRef(false);
  const [ready, setReady] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      if (isLive) {
        const data = await requestJson<WishlistPayload>("/api/wishlist", { signal });
        setGames(data.games);
        setAppIds(data.appIds);
      } else {
        const stored = readGuestWishlist(localStorage.getItem(GUEST_KEY));
        setGames(stored);
        setAppIds(stored.map((game) => game.appId));
      }
      setReady(true);
      return true;
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load your wishlist. Please try again.");
      return false;
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [isLive]);

  useEffect(() => {
    const controller = new AbortController();
    // Hydrate from external account/browser storage after SSR. This effect
    // synchronizes persisted state; it does not derive state from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function mutate(action: () => Promise<void>, operation: WishlistOperation, context?: WishlistInteractionContext, appId?: number) {
    if (lock.current || !ready) return;
    lock.current = true;
    setBusy(true); setError(null); setNotice("");
    setPending({ operation, appId });
    try { await action(); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update your wishlist. Please try again.");
      trackEvent(operation === "import" ? ANALYTICS_EVENTS.wishlistImport : ANALYTICS_EVENTS.wishlistAction, {
        action: operation === "import" ? "import" : "update_failed", operation, outcome: "failed", storage: isLive ? "account" : "browser", ...context,
      });
    }
    finally { lock.current = false; setBusy(false); setPending(null); }
  }

  async function toggle(game: WishlistGame, context: WishlistInteractionContext) {
    const exists = appIds.includes(game.appId);
    await mutate(async () => {
      if (!isLive && !exists && games.length >= 1000) throw new Error("Your browser wishlist has reached 1,000 games. Remove a saved game before adding another.");
      let savedGame = game;
      if (isLive) {
        const response = await requestJson<{ game?: WishlistGame }>("/api/wishlist", { method: exists ? "DELETE" : "POST", body: JSON.stringify({ appId: game.appId }) });
        if (response.game) savedGame = { ...game, ...response.game };
      }
      const updated = exists ? games.filter((item) => item.appId !== game.appId) : [{ ...savedGame, source: "local" as const, addedAt: new Date().toISOString() }, ...games];
      if (!isLive) localStorage.setItem(GUEST_KEY, JSON.stringify(updated));
      setGames(updated);
      setAppIds((ids) => exists ? ids.filter((id) => id !== game.appId) : [game.appId, ...ids]);
      setNotice(exists ? `${game.title} removed from your wishlist.` : `${game.title} added to your wishlist.`);
      trackEvent(exists ? ANALYTICS_EVENTS.wishlistGameRemoved : ANALYTICS_EVENTS.wishlistGameSaved, {
        ...context, steam_appid: game.appId, storage: isLive ? "account" : "browser", wishlist_count: appIds.length + (exists ? -1 : 1),
      });
    }, exists ? "remove" : "save", context, game.appId);
  }

  async function importSteam() {
    await mutate(async () => {
      setImportSummary("");
      trackEvent(ANALYTICS_EVENTS.wishlistImport, { outcome: "started", wishlist_count: appIds.length });
      const result = await requestJson<{ imported: number }>("/api/wishlist/import", { method: "POST", body: "{}" });
      trackEvent(ANALYTICS_EVENTS.wishlistImport, { outcome: "completed", steam_entry_count: result.imported });
      const refreshed = await load();
      const summary = result.imported ? `Read ${result.imported} Steam wishlist ${result.imported === 1 ? "entry" : "entries"} and saved any missing entries. Existing saves are kept; duplicates are skipped.` : "Your public Steam wishlist is empty. Your saved games are still here.";
      setImportSummary(refreshed ? summary : `${summary} The list could not refresh; use Reload wishlist to see the result.`);
      setNotice(refreshed ? summary : "Import saved. Reload your wishlist to see the result.");
    }, "import");
  }

  async function loadMore() {
    await mutate(async () => {
      const data = await requestJson<WishlistPayload>(`/api/wishlist?offset=${games.length}`);
      setGames((previous) => [...previous, ...data.games.filter((game) => !previous.some((item) => item.appId === game.appId))]);
      setAppIds(data.appIds);
      trackEvent(ANALYTICS_EVENTS.wishlistAction, { action: "saved_page_loaded", loaded_count: data.games.length, wishlist_count: data.total });
    }, "load_more");
  }

  return { games, appIds, loading, ready, busy, pending, error, notice, importSummary, toggle, importSteam, loadMore, reload: load };
}
