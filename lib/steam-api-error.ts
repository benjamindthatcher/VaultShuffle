export type SteamOperation = "owned_games" | "player_summary" | "resolve_vanity" | "openid_verify" | "recent_games";
export type SteamApiErrorCode = "steam_rate_limited" | "steam_timeout" | "steam_network_error" | "steam_http_error" | "steam_invalid_response";

export function steamRetryAfter(value: string | null, now = Date.now()) {
  const seconds = value && /^\d+$/.test(value.trim()) ? Number(value) : value ? Math.ceil((Date.parse(value) - now) / 1000) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : 60;
}

export class SteamApiError extends Error {
  readonly code: SteamApiErrorCode;
  readonly operation: SteamOperation;
  readonly upstreamStatus?: number;
  readonly retryAfterSeconds?: number;
  constructor(operation: SteamOperation, code: SteamApiErrorCode, status?: number, retryAfterSeconds?: number) {
    super(code === "steam_rate_limited"
      ? "Steam is asking us to wait before checking again. Your profile has not been rejected. Please wait a moment before trying again."
      : code === "steam_timeout" ? "Steam took too long to respond. Please try again shortly."
        : "Steam is temporarily unavailable. Please try again shortly.");
    this.name = "SteamApiError"; this.operation = operation; this.code = code;
    this.upstreamStatus = status; this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Never retains the request URL (it contains a Steam ID/API key) or upstream body. */
export async function fetchSteamResponse(operation: SteamOperation, url: string, init: RequestInit = {}, send: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await send(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(12_000) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new SteamApiError(operation, name === "TimeoutError" || name === "AbortError" ? "steam_timeout" : "steam_network_error");
  }
  if (!response.ok) throw new SteamApiError(operation, response.status === 429 ? "steam_rate_limited" : "steam_http_error", response.status,
    response.status === 429 ? steamRetryAfter(response.headers.get("Retry-After")) : undefined);
  return response;
}

export async function readSteamJson(response: Response, operation: SteamOperation): Promise<unknown> {
  try { return await response.json(); }
  catch (error) { throw new SteamApiError(operation, error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name) ? "steam_timeout" : "steam_invalid_response"); }
}
