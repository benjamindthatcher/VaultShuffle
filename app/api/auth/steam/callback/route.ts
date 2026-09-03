import { after, NextRequest, NextResponse } from "next/server";
import {
  attachSessionCookie,
  completeManualProfileSecurity,
  createSessionForSteamId,
  getCurrentSession,
} from "@/lib/auth";
import {
  MANUAL_PROFILE_SECURITY_COOKIE,
  ManualProfileSecurityError,
  asManualProfileSecurityError,
} from "@/lib/manual-profile-security";
import { deliverPostHogAccountProfileMerge, retryPendingPostHogAccountProfileMerges } from "@/lib/posthog-server";
import { enforceRateLimit, RateLimitExceededError, requestFingerprint } from "@/lib/rate-limit";
import { fetchSteamPlayerSummary, siteBaseUrl, steamIdFromOpenId, verifySteamOpenId } from "@/lib/steam";
import { requestDiagnostics, reportServiceWarning } from "@/lib/diagnostics-server";
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
  const securityIntentToken = request.cookies.get(MANUAL_PROFILE_SECURITY_COOKIE)?.value ?? "";
  const isSecurityFlow = Boolean(securityIntentToken);
  const diagnostics = requestDiagnostics(request, isSecurityFlow ? "steam_link_callback" : "steam_sign_in_callback");
  const flowId = diagnosticId(request.cookies.get(AUTH_TRACE_COOKIE)?.value);
  const finish = (response: NextResponse) => {
    response.cookies.set(AUTH_TRACE_COOKIE, "", { path: "/api/auth/steam/callback", maxAge: 0 });
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
      if (isSecurityFlow) throw new ManualProfileSecurityError("steam_sign_in_cancelled");
      throw Object.assign(new Error("Steam sign-in was cancelled."), { code: "steam_sign_in_cancelled" });
    }

    if (!url.searchParams.get("openid.claimed_id")) {
      throw Object.assign(new Error("Steam did not return a claimed identity."), { code: "steam_identity_missing" });
    }

    diagnostics.stage("steam_identity_verification");
    const valid = await verifySteamOpenId(url.searchParams);
    const steamId = steamIdFromOpenId(url.searchParams);

    if (!valid || !steamId) {
      if (isSecurityFlow) throw new ManualProfileSecurityError("steam_identity_unverified");
      throw Object.assign(new Error("Steam sign-in could not be verified."), { code: "steam_identity_unverified" });
    }

    diagnostics.stage("steam_profile_metadata");
    // Verified ownership does not depend on an optional avatar/name fetch.
    const profile = process.env.STEAM_WEB_API_KEY
      ? await fetchSteamPlayerSummary(steamId, process.env.STEAM_WEB_API_KEY).catch((error) => {
          diagnostics.event("warning", { flow_id: flowId }, error);
          return null;
        }) : null;

    diagnostics.stage(isSecurityFlow ? "account_merge" : "account_and_session_create");
    const secured = isSecurityFlow
      ? await secureManualProfile({
          securityIntentToken,
          steamId,
          profile,
          openIdResponseNonce: url.searchParams.get("openid.response_nonce") ?? "",
        })
      : await createSessionForSteamId(steamId, profile);

    const destination = isSecurityFlow
      ? `/account/secure-profile?secured=1&merge_mode=${encodeURIComponent("mergeMode" in secured ? secured.mergeMode : "promoted")}`
      : "/dashboard";
    const response = NextResponse.redirect(new URL(destination, baseUrl));

    response.cookies.set({
      name: STEAM_IMPORT_COOKIE,
      value: "1",
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 5 * 60
    });

    clearSecurityCookie(response);
    const accountId = "accountId" in secured ? secured.accountId : secured.user.id;
    diagnostics.account(accountId, "steam");

    // Catches up a merge whose PostHog delivery failed at the time. This used to
    // run on every app bootstrap, which meant a query per product page load for
    // every Steam account against a table holding four rows, and it has never
    // once found work to do. Signing in is the only moment a new merge can have
    // been created, so retrying here keeps the safety net at a hundredth of the
    // cost - and a delivery that fails now is picked up at the next sign-in.
    after(async () => {
      try {
        await retryPendingPostHogAccountProfileMerges(accountId);
      } catch (error) {
        reportServiceWarning(error, "account_analytics_merge", "retry_delivery");
      }
    });

    return finish(attachSessionCookie(response, secured.token));
  } catch (error) {
    if (isSecurityFlow) {
      const securityError = asManualProfileSecurityError(error, "link_merge_failed");
      diagnostics.event("failed", { flow_id: flowId }, securityError);
      const response = NextResponse.redirect(
        `${baseUrl}/account/secure-profile?error=${encodeURIComponent(securityError.code)}`,
      );
      clearSecurityCookie(response);
      return finish(response);
    }

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

async function secureManualProfile(input: {
  securityIntentToken: string;
  steamId: string;
  profile: Awaited<ReturnType<typeof fetchSteamPlayerSummary>>;
  openIdResponseNonce: string;
}) {
  const session = await getCurrentSession();
  if (!session || session.user.account_type !== "manual") {
    throw new ManualProfileSecurityError("link_session_missing");
  }

  const secured = await completeManualProfileSecurity({
    intentToken: input.securityIntentToken,
    manualSessionId: session.sessionId,
    verifiedSteamId: input.steamId,
    profile: input.profile,
    openIdResponseNonce: input.openIdResponseNonce,
  });

  if (secured.mergeMode === "merged_existing") {
    try {
      await deliverPostHogAccountProfileMerge({
        targetAccountId: secured.accountId,
        sourceAccountId: secured.sourceAccountId,
        steamId: input.steamId,
      });
    } catch (error) {
      // Identity analytics must never roll back a verified, atomic account merge.
      reportServiceWarning(error, "account_analytics_merge", "initial_delivery");
    }
  }

  return secured;
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
