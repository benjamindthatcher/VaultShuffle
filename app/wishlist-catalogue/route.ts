import { NextResponse } from "next/server";
import { listWishlistCatalogueGames } from "@/lib/wishlist-catalogue-server";

/** A broad public pool with dedicated depth for every wishlist tab. */
export async function GET() {
  try {
    const games = await listWishlistCatalogueGames();
    return NextResponse.json({ games }, { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
  } catch {
    return NextResponse.json({ error: "Recommendations are unavailable right now. You can still search Steam and use your wishlist." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
