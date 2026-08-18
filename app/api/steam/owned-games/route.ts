import { after, NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { recordSteamVisibility, upsertSteamGames } from "@/lib/games";
import { jsonError } from "@/lib/http";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { SteamLibraryUnavailableError, steamPlayHistoryMissing, steamVisibilityFromGames } from "@/lib/steam-owned-games";
import { processCatalogueQueue, recordImportedSteamAppIds } from "@/lib/catalogue";

export const maxDuration = 60;

export async function POST() {
  return importLibrary();
}

async function importLibrary() {
  const startedAt = Date.now();
  console.log(JSON.stringify({ level: "info", message: "Steam library import started", route: "/api/steam/owned-games" }));
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
    await recordSteamVisibility(user.id, steamVisibilityFromGames(importedGames)).catch(() => undefined);

    // Metadata and catalogue enrichment are useful, but they must not delay the
    // sign-in/import response. They continue after the updated library is saved.
    after(async () => {
      const deadlineAt = Date.now() + 45_000;
      await processCatalogueQueue(20, importedAppIds.map(Number), deadlineAt).catch(() => undefined);
    });

    console.log(JSON.stringify({
      level: "info",
      message: "Steam library import completed",
      route: "/api/steam/owned-games",
      imported: games.length,
      duration_ms: Date.now() - startedAt
    }));
    return NextResponse.json({
      imported: games.length,
      catalogue,
      play_history_missing: steamPlayHistoryMissing(importedGames)
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) {
      return unauthorizedResponse();
    }
    if (error instanceof SteamLibraryUnavailableError) {
      console.warn(JSON.stringify({
        level: "warning",
        message: "Steam returned no visible owned games",
        route: "/api/steam/owned-games",
        duration_ms: Date.now() - startedAt
      }));
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return jsonError(error, 502);
  }
}
