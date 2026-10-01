import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { enforceRateLimit, requestFingerprint } from "@/lib/rate-limit";
import { steamWishlistGame } from "@/lib/wishlist-server";
import type { WishlistGame } from "@/lib/wishlist";
import { isSteamStoreCountry } from "@/lib/steam-store-regions";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const ids = z.array(z.coerce.number().int().min(1).max(4294967295)).min(1).max(16).parse(params.get("ids")?.split(","));
    const country = z.string().refine(isSteamStoreCountry, "Choose a valid Steam store country.").parse(params.get("country") ?? "GB");
    await enforceRateLimit({ bucket: "wishlist_details", identity: requestFingerprint(request), limit: 120, windowSeconds: 300, message: "Please wait a moment before loading more Steam details." });
    const games: Array<Partial<WishlistGame> & { appId: number }> = [];
    for (let start = 0; start < ids.length; start += 4) {
      games.push(...await Promise.all(ids.slice(start, start + 4).map(async (appId) => {
        try { return await steamWishlistGame(appId, country); }
        catch { return { appId, storeStatus: "unavailable" as const }; }
      })));
    }
    return NextResponse.json({ games });
  } catch (error) { return jsonError(error); }
}
