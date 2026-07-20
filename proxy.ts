import { NextRequest, NextResponse } from "next/server";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_API_BODY_BYTES = 64 * 1024;

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

export function proxy(request: NextRequest) {
  if (UNSAFE_METHODS.has(request.method) && request.nextUrl.pathname !== "/api/catalogue/process") {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite === "cross-site" || !origin || !allowedOrigins(request).has(origin)) {
      return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_API_BODY_BYTES) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }

    if (contentLength > 0 && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
    }
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export const config = {
  matcher: "/api/:path*"
};
