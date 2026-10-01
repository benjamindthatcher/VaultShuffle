"use client";

import { useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import { WISHLIST_PICK_COUNT, type WishlistGame } from "@/lib/wishlist";
import { createWishlistDetailsClient, type WishlistDetails } from "@/lib/wishlist-details-client";

/** Visible cards, the next set and Budget picks share fresh regional details. */
export function useWishlistDetails(ids: number[], country: string) {
  const [client] = useState(() => createWishlistDetailsClient(async (ids, country) => {
    const response = await requestJson<{ games: WishlistDetails[] }>(`/api/wishlist/details?ids=${ids.join(",")}&country=${country}`);
    return response.games;
  }));
  const [, redraw] = useState(0);
  const [tick, setTick] = useState(0);
  const key = [...new Set(ids)].join(",");
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") setTick(value => value + 1); };
    const interval = setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const ids = key.split(",").filter(Boolean).map(Number);
    async function load() {
      for (let start = 0; start < ids.length; start += WISHLIST_PICK_COUNT) {
        if (cancelled) return;
        try { await client.load(ids.slice(start, start + WISHLIST_PICK_COUNT), country); }
        catch { /* The next freshness tick retries unavailable details. */ }
        if (!cancelled) redraw(value => value + 1);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [key, country, tick, client]);
  function enrich(game: WishlistGame): WishlistGame {
    const details = client.peek(game.appId, country);
    const suppliedFresh = game.price?.country === country && Date.parse(game.detailsExpiresAt ?? "") > Date.now();
    return { ...game, storeStatus: undefined, ...details, price: details ? details.price : suppliedFresh ? game.price : undefined, title: game.title, genres: game.genres.length ? game.genres : details?.genres ?? [] };
  }
  return { enrich, detailsClient: client };
}
