import { NextResponse } from "next/server";
import { listCollectionsWithMemberships } from "@/lib/collections";
import { listGames } from "@/lib/games";
import { getSessionPayload } from "@/lib/session-payload";
import { getVaultState } from "@/lib/vault-state";

export async function GET() {
  const session = await getSessionPayload();

  if (!session.logged_in || !session.user_id) {
    return NextResponse.json({ session });
  }

  try {
    const [games, { collections, memberships }, vaultState] = await Promise.all([
      listGames(session.user_id),
      listCollectionsWithMemberships(session.user_id, { includeSmartCounts: false }),
      getVaultState(session.user_id)
    ]);

    return NextResponse.json({
      session,
      games,
      collections,
      memberships,
      vaultState
    });
  } catch (error) {
    console.error("Could not load app data.", error);
    return NextResponse.json({ session, data_error: true });
  }
}
