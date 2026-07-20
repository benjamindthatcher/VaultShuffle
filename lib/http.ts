import { NextResponse } from "next/server";
import { ZodError } from "zod";

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

export function jsonError(error: unknown, status = 500) {
  if (error instanceof ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  const message = error instanceof Error ? error.message : "Something went wrong.";
  const responseStatus = message === "Steam sign-in is required." ? 401 : status;
  if (responseStatus >= 500) {
    console.error("API request failed:", error);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: responseStatus });
  }
  return NextResponse.json({ error: message }, { status: responseStatus });
}
