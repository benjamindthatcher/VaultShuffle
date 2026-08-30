import { NextResponse } from "next/server";
import { createManualProfileSecurityIntent, getCurrentSession } from "@/lib/auth";
import { MANUAL_PROFILE_SECURITY_COOKIE, ManualProfileSecurityError } from "@/lib/manual-profile-security";
import { siteBaseUrl, steamAuthUrl } from "@/lib/steam";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl = siteBaseUrl(request);
  if (url.searchParams.get("flow") !== "secure-profile") {
    const response = NextResponse.redirect(steamAuthUrl(baseUrl));
    clearSecurityCookie(response);
    return response;
  }

  try {
    const session = await getCurrentSession();
    if (!session || session.user.account_type !== "manual") {
      throw new ManualProfileSecurityError("link_session_missing");
    }
    const intent = await createManualProfileSecurityIntent({
      accountId: session.user.id,
      manualSessionId: session.sessionId,
    });
    const response = NextResponse.redirect(steamAuthUrl(baseUrl));
    response.cookies.set({
      name: MANUAL_PROFILE_SECURITY_COOKIE,
      value: intent.token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      priority: "high",
      path: "/api/auth/steam/callback",
      maxAge: Math.max(1, Math.floor((intent.expiresAt.getTime() - Date.now()) / 1000)),
    });
    return response;
  } catch (error) {
    const code = error instanceof ManualProfileSecurityError ? error.code : "link_intent_invalid";
    console.error("Manual profile security start failed:", code);
    const response = NextResponse.redirect(`${baseUrl}/account/secure-profile?error=${code}`);
    clearSecurityCookie(response);
    return response;
  }
}

function clearSecurityCookie(response: NextResponse) {
  response.cookies.set({
    name: MANUAL_PROFILE_SECURITY_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    priority: "high",
    path: "/api/auth/steam/callback",
    maxAge: 0,
  });
}
