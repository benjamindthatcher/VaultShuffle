import { NextResponse } from "next/server";
import { attachSessionCookie, createSessionForSteamId } from "@/lib/auth";
import { siteBaseUrl, steamIdFromOpenId, verifySteamOpenId } from "@/lib/steam";

function describeError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error) {
    const details = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    return [details.message, details.details, details.hint, details.code]
      .filter(Boolean)
      .map(String)
      .join(" | ") || "Steam sign-in failed.";
  }
  return typeof error === "string" ? error : "Steam sign-in failed.";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl = siteBaseUrl(request);

  try {
    if (url.searchParams.get("openid.mode") === "cancel") {
      throw new Error("Steam sign-in was cancelled.");
    }

    if (!url.searchParams.get("openid.claimed_id")) {
      throw new Error("Steam did not return a claimed identity.");
    }

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
    const message = encodeURIComponent(describeError(error));
    console.error("Steam callback failed:", describeError(error));
    return NextResponse.redirect(`${baseUrl}/login?error=${message}`);
  }
}
