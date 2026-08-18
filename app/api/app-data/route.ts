import { NextResponse } from "next/server";
import { listCollectionsWithMemberships } from "@/lib/collections";
import { listGames } from "@/lib/games";
import { getSessionPayload } from "@/lib/session-payload";
import { getVaultState } from "@/lib/vault-state";
import { listGenrePreferences } from "@/lib/genre-preference-worker";
import { listGuestCatalogueGames } from "@/lib/guest-catalogue";

export async function GET() {
  const session = await getSessionPayload();

  if (!session.logged_in || !session.user_id) {
    try {
      return NextResponse.json({
        session,
        games: await listGuestCatalogueGames(),
        guest_pool_source: "live_catalogue"
      });
    } catch (error) {
      console.error("Could not load the live guest catalogue.", error);
      return NextResponse.json({ session, data_error: true, guest_pool_source: "fallback" });
    }
  }

  try {
    const [games, { collections, memberships }, vaultState, genrePreferences] = await Promise.all([
      listGames(session.user_id),
      listCollectionsWithMemberships(session.user_id, { includeSmartCounts: false }),
      getVaultState(session.user_id),
      listGenrePreferences(session.user_id)
    ]);

    return NextResponse.json({
      session,
      games,
      collections,
      memberships,
      vaultState,
      genrePreferences
    });
  } catch (error) {
    console.error("Could not load app data.", error);
    return NextResponse.json({ session, data_error: true });
  }
}
