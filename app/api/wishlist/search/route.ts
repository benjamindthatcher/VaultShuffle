import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { searchSteamWishlist } from "@/lib/wishlist-server";
import { enforceRateLimit, requestFingerprint } from "@/lib/rate-limit";

export async function GET(request: Request) {
  try {
    const query = z.string().trim().min(2).max(100).parse(new URL(request.url).searchParams.get("q"));
    await enforceRateLimit({ bucket: "wishlist_search", identity: requestFingerprint(request), limit: 60, windowSeconds: 300, message: "Too many searches. Please wait a moment and try again." });
    return NextResponse.json({ games: await searchSteamWishlist(query) });
  } catch (error) { return jsonError(error); }
}
