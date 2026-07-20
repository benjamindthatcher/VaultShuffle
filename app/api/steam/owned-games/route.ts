import { after, NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { upsertSteamGames } from "@/lib/games";
import { jsonError } from "@/lib/http";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { enrichSteamMetadataForUser } from "@/lib/steam-metadata";
import { processCatalogueQueue, recordImportedSteamAppIds } from "@/lib/catalogue";

export async function POST() {
  return importLibrary();
}

async function importLibrary() {
  try {
    const { user } = await requireSession();
    const apiKey = process.env.STEAM_WEB_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "Steam library sync is temporarily unavailable. Please try again later." },
        { status: 400 }
      );
    }

    const importedGames = await fetchOwnedSteamGames(user.steam_id, apiKey);
    const importedAppIds = importedGames.flatMap((game) =>
      game.steam_appid ? [String(game.steam_appid)] : []
    );

    const catalogue = await recordImportedSteamAppIds(user.id, importedAppIds)
      .catch(() => ({ queued: 0 }));
    const games = await upsertSteamGames(user.id, importedGames);

    // Metadata and catalogue enrichment are useful, but they must not delay the
    // sign-in/import response. They continue after the updated library is saved.
    after(async () => {
      await Promise.allSettled([
        processCatalogueQueue(50, importedAppIds.map(Number)),
        enrichSteamMetadataForUser(user.id, 50, false)
      ]);
    });

    return NextResponse.json({ imported: games.length, catalogue });
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) {
      return unauthorizedResponse();
    }
    return jsonError(error, 502);
  }
}
