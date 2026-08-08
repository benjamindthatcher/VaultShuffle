import { after, NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { upsertSteamWishlistGames } from "@/lib/games";
import { jsonError } from "@/lib/http";
import { fetchPublicSteamWishlist } from "@/lib/steam";
import { enrichSteamMetadataForUser } from "@/lib/steam-metadata";
import { processCatalogueQueue, recordImportedSteamAppIds } from "@/lib/catalogue";

export const maxDuration = 60;

export async function POST() {
  try {
    const { user } = await requireSession();
    const apiKey = process.env.STEAM_WEB_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Steam wishlist sync is temporarily unavailable. Please try again later." },
        { status: 400 }
      );
    }
    const wishlist = await fetchPublicSteamWishlist(user.steam_id, apiKey);
    const appIds = wishlist.flatMap((game) => game.steam_appid ? [String(game.steam_appid)] : []);

    const catalogue = await recordImportedSteamAppIds(user.id, appIds)
      .catch(() => ({ queued: 0 }));
    const result = await upsertSteamWishlistGames(user.id, wishlist);

    after(async () => {
      const deadlineAt = Date.now() + 45_000;
      await Promise.allSettled([
        processCatalogueQueue(20, appIds.map(Number), deadlineAt),
        enrichSteamMetadataForUser(user.id, 20, false, true, deadlineAt)
      ]);
    });

    return NextResponse.json({
      found: wishlist.length,
      imported: result.games.length,
      skipped_owned: result.skippedOwned,
      catalogue
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) {
      return unauthorizedResponse();
    }
    const message = error instanceof Error ? error.message : "";
    const userCorrectable = /private|public wishlist|limiting wishlist/i.test(message);
    return jsonError(error, userCorrectable ? 422 : 502);
  }
}
