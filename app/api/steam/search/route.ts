import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSubmissionRate, requestFingerprint, SubmissionRateLimitError } from "@/lib/communications";
import { jsonError } from "@/lib/http";
import { searchSteamStore } from "@/lib/steam";

export async function GET(request: Request) {
  try {
    assertSubmissionRate(`steam-search:${requestFingerprint(request)}`, 30, 5 * 60 * 1000);
    const query = z.string().trim().min(2).max(100).parse(new URL(request.url).searchParams.get("q") || "");
    return NextResponse.json({ results: await searchSteamStore(query) });
  } catch (error) {
    if (error instanceof SubmissionRateLimitError) {
      return NextResponse.json({ error: error.message }, { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } });
    }
    return jsonError(error, 502);
  }
}
