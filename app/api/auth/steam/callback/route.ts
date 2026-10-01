import { NextRequest, NextResponse } from "next/server";
import {
  attachSessionCookie,
  createSessionForSteamId,
} from "@/lib/auth";
import { enforceRateLimit, RateLimitExceededError, requestFingerprint } from "@/lib/rate-limit";
import { fetchSteamPlayerSummary, siteBaseUrl, steamIdFromOpenId, verifySteamOpenId } from "@/lib/steam";
import { requestDiagnostics } from "@/lib/diagnostics-server";
import { AUTH_TRACE_COOKIE, diagnosticId } from "@/lib/diagnostics";
import { SteamApiError } from "@/lib/steam-api-error";

const STEAM_IMPORT_COOKIE = "vault_steam_import";

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

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const baseUrl = siteBaseUrl(request);
  const diagnostics = requestDiagnostics(request, "steam_sign_in_callback");
  const flowId = diagnosticId(request.cookies.get(AUTH_TRACE_COOKIE)?.value);
  const finish = (response: NextResponse) => {
    response.cookies.set(AUTH_TRACE_COOKIE, "", { path: "/api/auth/steam/callback", maxAge: 0 });
    clearSecurityCookie(response);
    return diagnostics.response(response);
  };

  try {
    diagnostics.stage("callback_validation");
    await enforceRateLimit({
      bucket: "steam_auth_callback",
      identity: requestFingerprint(request),
      limit: 20,
      windowSeconds: 10 * 60,
      message: "Too many Steam sign-in responses were received from this connection. Please wait before trying again."
    });
    if (url.searchParams.get("openid.mode") === "cancel") {
      throw Object.assign(new Error("Steam sign-in was cancelled."), { code: "steam_sign_in_cancelled" });
    }

    if (!url.searchParams.get("openid.claimed_id")) {
      throw Object.assign(new Error("Steam did not return a claimed identity."), { code: "steam_identity_missing" });
    }

    diagnostics.stage("steam_identity_verification");
    const valid = await verifySteamOpenId(url.searchParams);
    const steamId = steamIdFromOpenId(url.searchParams);

    if (!valid || !steamId) {
      throw Object.assign(new Error("Steam sign-in could not be verified."), { code: "steam_identity_unverified" });
    }

    diagnostics.stage("steam_profile_metadata");
    // Verified ownership does not depend on an optional avatar/name fetch.
    const profile = process.env.STEAM_WEB_API_KEY
      ? await fetchSteamPlayerSummary(steamId, process.env.STEAM_WEB_API_KEY).catch((error) => {
          diagnostics.event("warning", { flow_id: flowId }, error);
          return null;
        }) : null;

    diagnostics.stage("account_and_session_create");
    const signedIn = await createSessionForSteamId(steamId, profile);
    const response = NextResponse.redirect(new URL("/dashboard", baseUrl));

    response.cookies.set({
      name: STEAM_IMPORT_COOKIE,
      value: "1",
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 5 * 60
    });

    diagnostics.account(signedIn.user.id, "steam");
    return finish(attachSessionCookie(response, signedIn.token));
  } catch (error) {
    const detailedMessage = describeError(error);
    const publicMessage = error instanceof SteamApiError
      ? error.retryAfterSeconds
        ? `${error.message} Try again in about ${Math.max(1, Math.ceil(error.retryAfterSeconds / 60))} minute${error.retryAfterSeconds > 60 ? "s" : ""}.`
        : error.message
      : error instanceof RateLimitExceededError
      ? `${error.message} Try again in about ${Math.max(1, Math.ceil(error.retryAfterSeconds / 60))} minute${error.retryAfterSeconds > 60 ? "s" : ""}.`
      : detailedMessage === "Steam sign-in was cancelled."
        ? detailedMessage
        : "Steam sign-in failed. Please try again.";
    const message = encodeURIComponent(publicMessage);

    diagnostics.event(error instanceof RateLimitExceededError || (error instanceof SteamApiError && error.code === "steam_rate_limited") ? "deferred" : "failed", { flow_id: flowId }, error);
    return finish(NextResponse.redirect(`${baseUrl}/?signin=${message}`));
  }
}

function clearSecurityCookie(response: NextResponse) {
  response.cookies.set({
    name: "vault_profile_security",
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    priority: "high",
    path: "/api/auth/steam/callback",
    maxAge: 0,
  });
}
