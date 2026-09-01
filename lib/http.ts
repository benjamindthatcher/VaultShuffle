import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { ZodError } from "zod";
import { SessionRequiredError } from "@/lib/auth";
import { RateLimitExceededError } from "@/lib/rate-limit";
import { reportApiFailure, RequestDiagnostics } from "@/lib/diagnostics-server";
import { SteamApiError } from "@/lib/steam-api-error";

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function assertSameOrigin(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError("Cross-site requests are not allowed.", 403);
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError("Cross-site requests are not allowed.", 403);
  }
}

export async function readJsonBody<T = unknown>(request: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<T> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpError("Content-Type must be application/json.", 415);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError("Request body is too large.", 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError("Request body is too large.", 413);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError("Request body must contain valid JSON.", 400);
  }
}

export async function jsonError(error: unknown, status = 500, diagnostics?: RequestDiagnostics) {
  if (!diagnostics) {
    try {
      const context = await headers();
      diagnostics = new RequestDiagnostics(new Headers(context), "api_request", context.get("x-vault-route") ?? "/api/:id", context.get("x-vault-method") ?? "GET");
    } catch { /* Non-request callers still get console reporting below. */ }
  }
  const response = errorResponse(error, status);
  const requestId = diagnostics?.requestId ?? crypto.randomUUID();
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  if (diagnostics) diagnostics.event(response.status === 429 ? "deferred" : "failed", { status: response.status }, error);
  else reportApiFailure(error, response.status, requestId);
  return response;
}

function errorResponse(error: unknown, status: number) {
  if (error instanceof SteamApiError) {
    const status = error.code === "steam_rate_limited" ? 429 : error.code === "steam_timeout" ? 504 : 502;
    return NextResponse.json({ error: error.message, code: error.code, ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {}) },
      { status, headers: error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {} });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof RateLimitExceededError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        retry_after_seconds: error.retryAfterSeconds
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "Retry-After": String(error.retryAfterSeconds)
        }
      }
    );
  }

  const message = error instanceof Error ? error.message : "Something went wrong.";
  const responseStatus = error instanceof SessionRequiredError ? 401 : status;
  if (responseStatus >= 500) {
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: responseStatus });
  }
  return NextResponse.json({ error: message }, { status: responseStatus });
}
