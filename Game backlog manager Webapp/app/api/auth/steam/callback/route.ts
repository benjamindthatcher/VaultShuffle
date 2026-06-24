import { NextResponse } from "next/server";
import { attachSessionCookie, createSessionForSteamId } from "@/lib/auth";
import { upsertSteamGames } from "@/lib/games";
import { fetchOwnedSteamGames, siteBaseUrl, steamIdFromOpenId, verifySteamOpenId } from "@/lib/steam";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl = siteBaseUrl(request);

  try {
    const valid = await verifySteamOpenId(url.searchParams);
    const steamId = steamIdFromOpenId(url.searchParams);

    if (!valid || !steamId) {
      throw new Error("Steam sign-in could not be verified.");
    }

    const { token, user } = await createSessionForSteamId(steamId);
    const apiKey = process.env.STEAM_WEB_API_KEY;

    if (apiKey) {
      const steamGames = await fetchOwnedSteamGames(steamId, apiKey);
      await upsertSteamGames(user.id, steamGames);
    }

    const response = NextResponse.redirect(`${baseUrl}/app`);
    return attachSessionCookie(response, token);
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : "Steam sign-in failed.");
    return NextResponse.redirect(`${baseUrl}/login?error=${message}`);
  }
}
