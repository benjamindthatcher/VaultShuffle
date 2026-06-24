import { NextResponse } from "next/server";
import { attachSessionCookie, createSessionForSteamId } from "@/lib/auth";
import { siteBaseUrl, steamIdFromOpenId, verifySteamOpenId } from "@/lib/steam";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl = siteBaseUrl(request);

  try {
    const valid = await verifySteamOpenId(url.searchParams);
    const steamId = steamIdFromOpenId(url.searchParams);

    if (!valid || !steamId) {
      throw new Error("Steam sign-in could not be verified.");
    }

    const { token } = await createSessionForSteamId(steamId);
    const redirectUrl = new URL(`${baseUrl}/app`);
    redirectUrl.searchParams.set("steam_connected", "1");

    const response = NextResponse.redirect(redirectUrl);
    return attachSessionCookie(response, token);
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : "Steam sign-in failed.");
    return NextResponse.redirect(`${baseUrl}/login?error=${message}`);
  }
}
