import { NextResponse } from "next/server";
import { listGuestCatalogueGames } from "@/lib/guest-catalogue";
import { reportServiceWarning } from "@/lib/diagnostics-server";

/**
 * The guest preview pool, on a public URL of its own so that the CDN can serve
 * it instead of a function rebuilding it for every visitor.
 *
 * This used to ride along inside /api/app-data, where two separate things made
 * caching impossible. The proxy stamps `private, no-store` on everything under
 * /api, and that same URL also answers signed-in requests - the CDN keys only
 * on the URL, so caching it there could hand one person's library to another.
 * Neither problem exists here: the response carries no session and is
 * byte-identical for everyone, which is exactly what a shared cache wants.
 *
 * Deliberately not under /api. Keeping it outside means "everything under /api
 * goes through the proxy" stays true, and this route needs no exemption from
 * the cross-site checks there. It answers GET only, so there is nothing for
 * those checks to protect.
 *
 * s-maxage matches the hour loadCachedGuestCatalogue already holds the pool
 * for, so the edge and the data cache expire together rather than one serving
 * a pool the other has already replaced.
 */
const CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=86400";

export async function GET() {
  try {
    const games = await listGuestCatalogueGames();
    return NextResponse.json(
      { games, guest_pool_source: "live_catalogue" },
      { headers: { "Cache-Control": CACHE_CONTROL } }
    );
  } catch (error) {
    reportServiceWarning(error, "guest_catalogue", "load");
    // Never cached. A cached failure would pin every guest to the bundled
    // fallback for the whole hour, long after the catalogue came back.
    return NextResponse.json(
      { guest_pool_source: "fallback" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
