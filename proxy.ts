import { NextRequest, NextResponse } from "next/server";
import { diagnosticRoute } from "@/lib/diagnostics";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_API_BODY_BYTES = 64 * 1024;
const STEAM_IMPORT_COOKIE = "vault_steam_import";
const SESSION_COOKIE = "vault_session";
const INGEST_PREFIX = "/ingest";
const POSTHOG_API_HOST = "https://eu.i.posthog.com";
const POSTHOG_ASSET_HOST = "https://eu-assets.i.posthog.com";

function apiError(error: string, status: number, request: NextRequest) {
  const requestId = crypto.randomUUID();
  // Guard rejections stay in operational logs, not a potentially high-volume
  // PostHog stream of unauthenticated probes. Never log the submitted origin/body.
  console.warn(JSON.stringify({ event: "request_rejected", status, route: diagnosticRoute(request.nextUrl.pathname), method: request.method, request_id: requestId }));
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store, max-age=0", "X-Request-Id": requestId } }
  );
}

function allowedOrigins(request: NextRequest) {
  const origins = new Set([request.nextUrl.origin]);
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) {
    try {
      origins.add(new URL(configured).origin);
    } catch {
      // Invalid configuration is handled by the routes that require the site URL.
    }
  }
  return origins;
}

// PostHog is served through our own origin so that ad blockers do not drop product
// analytics. Same-origin requests carry every vaultshuffle.com cookie, including the
// httpOnly vault_session token, so the Cookie header is removed before the request is
// forwarded on. PostHog identifies events from the payload and never needs it.
function proxyPostHog(request: NextRequest) {
  const path = request.nextUrl.pathname.slice(INGEST_PREFIX.length) || "/";
  const isAsset = path.startsWith("/static/") || path.startsWith("/array/");
  const destination = new URL(
    `${path}${request.nextUrl.search}`,
    isAsset ? POSTHOG_ASSET_HOST : POSTHOG_API_HOST
  );

  const headers = new Headers(request.headers);
  headers.delete("cookie");

  return NextResponse.rewrite(destination, { request: { headers } });
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === INGEST_PREFIX || request.nextUrl.pathname.startsWith(`${INGEST_PREFIX}/`)) {
    return proxyPostHog(request);
  }

  if (
    request.method === "GET" &&
    request.nextUrl.searchParams.get("steam_connected") === "1"
  ) {
    const cleanUrl = request.nextUrl.clone();
    cleanUrl.searchParams.delete("steam_connected");

    const response = NextResponse.redirect(cleanUrl);
    response.cookies.set({
      name: STEAM_IMPORT_COOKIE,
      value: "1",
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 5 * 60
    });
    return response;
  }

  // A signed-in visitor has no use for the marketing page, so the landing route
  // belongs to signed-out people only. Signing out clears the session cookie,
  // which is what makes the landing page reachable again.
  //
  // Presence of the cookie is enough here. Verifying it would mean a database
  // round trip on every landing request, and the product routes already treat
  // an unusable session as a guest rather than bouncing back here, so a stale
  // cookie cannot produce a redirect loop.
  //
  // A failed Steam sign-in returns to "/?signin=<message>" to show the error,
  // so that case has to stay on the landing page.
  if (
    request.method === "GET" &&
    request.nextUrl.pathname === "/" &&
    !request.nextUrl.searchParams.has("signin") &&
    request.cookies.get(SESSION_COOKIE)?.value
  ) {
    return NextResponse.redirect(new URL("/dashboard", request.nextUrl.origin));
  }

  if (UNSAFE_METHODS.has(request.method) && request.nextUrl.pathname !== "/api/catalogue/process") {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite === "cross-site" || !origin || !allowedOrigins(request).has(origin)) {
      return apiError("Cross-site request blocked.", 403, request);
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_API_BODY_BYTES) {
      return apiError("Request body is too large.", 413, request);
    }

    if (contentLength > 0 && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return apiError("Content-Type must be application/json.", 415, request);
    }
  }

  const requestHeaders = new Headers(request.headers);
  // Overwrite, rather than trust, client-supplied routing/request metadata.
  const requestId = crypto.randomUUID();
  requestHeaders.set("x-vault-request-id", requestId);
  requestHeaders.set("x-vault-route", diagnosticRoute(request.nextUrl.pathname));
  requestHeaders.set("x-vault-method", request.method);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("X-Request-Id", requestId);
  if (request.nextUrl.pathname.startsWith("/api/")) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
  }
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export const config = {
  matcher: [
    "/",
    "/api/:path*",
    "/ingest/:path*",
    "/dashboard",
    "/stats",
    "/vault",
    "/library",
    "/purge",
    "/collections"
  ]
};
