import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { listGames, upsertSteamGames } from "@/lib/games";
import { jsonError } from "@/lib/http";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { enrichSteamMetadataForUser } from "@/lib/steam-metadata";

export async function GET() {
  return importLibrary();
}

export async function POST() {
  return importLibrary();
}

async function importLibrary() {
  try {
    const { user } = await requireSession();
    const apiKey = process.env.STEAM_WEB_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Steam library sync is temporarily unavailable. Please try again later." }, { status: 400 });
    }
    const importedGames = await fetchOwnedSteamGames(user.steam_id, apiKey);
    const games = await upsertSteamGames(user.id, importedGames);
    await enrichSteamMetadataForUser(user.id, 50, true).catch(() => null);
    const refreshedGames = await listGames(user.id);
    return NextResponse.json({ imported: games.length, games: refreshedGames });
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) return unauthorizedResponse();
    return jsonError(error, 502);
  }
}
