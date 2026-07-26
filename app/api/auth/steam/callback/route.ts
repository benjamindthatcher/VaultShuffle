import { NextResponse } from "next/server";
import { attachSessionCookie, createSessionForSteamId } from "@/lib/auth";
import { getPostHogClient } from "@/lib/posthog-server";
import { fetchSteamPlayerSummary, siteBaseUrl, steamIdFromOpenId, verifySteamOpenId } from "@/lib/steam";

const STEAM_IMPORT_COOKIE = "vault_steam_import";
const ANALYTICS_CONSENT_COOKIE = "vault_analytics_consent";

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

    const profile = process.env.STEAM_WEB_API_KEY
      ? await fetchSteamPlayerSummary(steamId, process.env.STEAM_WEB_API_KEY)
      : null;

    const { token, user } = await createSessionForSteamId(steamId, profile);

    const posthog = requestCookie(request, ANALYTICS_CONSENT_COOKIE) === "accepted"
      ? getPostHogClient()
      : null;
    if (posthog) {
      posthog.identify({
        distinctId: user.id,
        properties: {
          steam_id: user.steam_id,
          ...(user.display_name ? { display_name: user.display_name } : {}),
          ...(user.avatar_url ? { $avatar: user.avatar_url } : {}),
        },
      });
      posthog.capture({ distinctId: user.id, event: 'user_signed_in' });
      await posthog.flush();
    }

    const response = NextResponse.redirect(new URL("/vault", baseUrl));

    response.cookies.set({
      name: STEAM_IMPORT_COOKIE,
      value: "1",
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 5 * 60
    });

    return attachSessionCookie(response, token);
  } catch (error) {
    const detailedMessage = describeError(error);
    const publicMessage = detailedMessage === "Steam sign-in was cancelled."
      ? detailedMessage
      : "Steam sign-in failed. Please try again.";
    const message = encodeURIComponent(publicMessage);

    console.error("Steam callback failed:", detailedMessage);
    return NextResponse.redirect(`${baseUrl}/login?error=${message}`);
  }
}

function requestCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie")
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}
