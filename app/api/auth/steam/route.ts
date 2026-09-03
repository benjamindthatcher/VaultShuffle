import { NextResponse } from "next/server";
import { createManualProfileSecurityIntent, getCurrentSession } from "@/lib/auth";
import { MANUAL_PROFILE_SECURITY_COOKIE, ManualProfileSecurityError } from "@/lib/manual-profile-security";
import { siteBaseUrl, steamAuthUrl } from "@/lib/steam";
import { requestDiagnostics } from "@/lib/diagnostics-server";
import { AUTH_TRACE_COOKIE } from "@/lib/diagnostics";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl = siteBaseUrl(request);
  const diagnostics = requestDiagnostics(request, url.searchParams.get("flow") === "secure-profile" ? "steam_link_start" : "steam_sign_in_start");
  const flowId = crypto.randomUUID();
  function traced(response: NextResponse) {
    response.cookies.set(AUTH_TRACE_COOKIE, flowId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/steam/callback", maxAge: 15 * 60 });
    return diagnostics.response(response);
  }
  if (url.searchParams.get("flow") !== "secure-profile") {
    const response = NextResponse.redirect(steamAuthUrl(baseUrl));
    clearSecurityCookie(response);
    return traced(response);
  }

  try {
    diagnostics.stage("session_check");
    const session = await getCurrentSession();
    if (!session || session.user.account_type !== "manual") {
      throw new ManualProfileSecurityError("link_session_missing");
    }
    diagnostics.account(session.user.id, "manual");
    diagnostics.stage("link_intent_create");
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
    return traced(response);
  } catch (error) {
    const code = error instanceof ManualProfileSecurityError ? error.code : "link_intent_invalid";
    diagnostics.event("failed", { flow_id: flowId, error_code: code }, error);
    const response = NextResponse.redirect(`${baseUrl}/account/secure-profile?error=${code}`);
    clearSecurityCookie(response);
    return diagnostics.response(response);
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
