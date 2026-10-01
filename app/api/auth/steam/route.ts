import { NextResponse } from "next/server";
import { siteBaseUrl, steamAuthUrl } from "@/lib/steam";
import { requestDiagnostics } from "@/lib/diagnostics-server";
import { AUTH_TRACE_COOKIE } from "@/lib/diagnostics";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const baseUrl = siteBaseUrl(request);
  const diagnostics = requestDiagnostics(request, "steam_sign_in_start");
  // Old bookmarks cannot start an account merge or an unexpected sign-in.
  const retiredFlow = url.searchParams.get("flow") === "secure-profile";
  const response = NextResponse.redirect(retiredFlow ? `${baseUrl}/dashboard` : steamAuthUrl(baseUrl));
  response.cookies.set("vault_profile_security", "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/steam/callback", maxAge: 0 });
  response.cookies.set(AUTH_TRACE_COOKIE, retiredFlow ? "" : crypto.randomUUID(), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/auth/steam/callback", maxAge: retiredFlow ? 0 : 15 * 60 });
  return diagnostics.response(response);
}
