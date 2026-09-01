import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { assertSameOrigin, jsonError } from "@/lib/http";
import { requestDiagnostics } from "@/lib/diagnostics-server";
import { SteamApiError } from "@/lib/steam-api-error";
import { PINNED_PLAYTIME_COOLDOWN_SECONDS, PinnedPlaytimeError, refreshPinnedPlaytime } from "@/lib/pinned-playtime";

export const maxDuration = 30;
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export async function POST(request: Request) {
  const diagnostics = requestDiagnostics(request, "pinned_playtime_refresh");
  try {
    assertSameOrigin(request);
    diagnostics.stage("session");
    const { user } = await requireSession();
    diagnostics.account(user.id, user.account_type);
    diagnostics.stage("refresh_pins");
    // No client-controlled account, Steam ID or list of games is accepted.
    const result = await refreshPinnedPlaytime(user.id, user.steam_id);
    diagnostics.event(result.skipped ? "warning" : "succeeded", { status: 200, game_count: result.refreshed, total: result.refreshed + result.skipped });
    return diagnostics.response(NextResponse.json(result, { headers: PRIVATE_HEADERS }));
  } catch (error) {
    if (error instanceof PinnedPlaytimeError || error instanceof SteamApiError) {
      const steamLimited = error instanceof SteamApiError && error.code === "steam_rate_limited";
      const status = error instanceof PinnedPlaytimeError ? error.status : steamLimited ? 429 : error.code === "steam_timeout" ? 504 : 502;
      const retryAfterSeconds = Math.max(PINNED_PLAYTIME_COOLDOWN_SECONDS, error instanceof SteamApiError ? error.retryAfterSeconds ?? 0 : 0);
      diagnostics.event(steamLimited ? "deferred" : "failed", { status, retry_after_seconds: retryAfterSeconds }, error);
      return diagnostics.response(NextResponse.json({ error: error.message, code: error.code, retry_after_seconds: retryAfterSeconds }, {
        status,
        headers: { ...PRIVATE_HEADERS, "Retry-After": String(retryAfterSeconds) },
      }));
    }
    const response = await jsonError(error);
    response.headers.set("Cache-Control", PRIVATE_HEADERS["Cache-Control"]);
    return diagnostics.response(response);
  }
}
