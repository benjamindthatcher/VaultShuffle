import type { GameDurationProvider, GameDurationResult } from "./duration-provider.ts";
import { secondsToMinutes } from "./duration-provider.ts";

type FetchLike = typeof fetch;
type Token = { value: string; expiresAt: number };

export class IgdbRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "IgdbRequestError";
    this.code = code;
    this.status = status;
  }
}

export class IgdbDurationProvider implements GameDurationProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetcher: FetchLike;
  private token: Token | null = null;
  private tokenPromise: Promise<Token> | null = null;
  private steamSourceId: number | null = null;
  private steamSourcePromise: Promise<number> | null = null;
  private lastIgdbRequestAt = 0;

  constructor(clientId: string, clientSecret: string, fetcher: FetchLike = fetch) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetcher = fetcher;
  }

  async findBySteamAppId(steamAppId: number): Promise<GameDurationResult> {
    if (!Number.isSafeInteger(steamAppId) || steamAppId <= 0) throw new IgdbRequestError("invalid_app_id", 400, "Invalid Steam AppID");
    const sourceId = await this.getSteamSourceId();
    const mappings = await this.igdb<Array<{ game?: number; uid?: string }>>(
      "external_games",
      `fields game,uid,external_game_source; where external_game_source = ${sourceId} & uid = "${steamAppId}"; limit 10;`
    );
    const gameIds = [...new Set(mappings.filter((item) => item.uid === String(steamAppId) && Number.isInteger(item.game)).map((item) => Number(item.game)))];
    if (!gameIds.length) return emptyResult(steamAppId, "not_found");
    if (gameIds.length !== 1) return emptyResult(steamAppId, "ambiguous");

    const rows = await this.igdb<Array<{ game?: number; hastily?: number; normally?: number; completely?: number; count?: number; updated_at?: number }>>(
      "game_time_to_beats",
      `fields game,hastily,normally,completely,count,updated_at; where game = ${gameIds[0]}; limit 2;`
    );
    if (rows.length > 1) return { ...emptyResult(steamAppId, "ambiguous"), providerGameId: gameIds[0] };
    if (!rows.length) return { ...emptyResult(steamAppId, "no_duration"), providerGameId: gameIds[0] };
    const row = rows[0];
    const mainStoryMinutes = secondsToMinutes(row.hastily);
    const mainExtraMinutes = secondsToMinutes(row.normally);
    const completionistMinutes = secondsToMinutes(row.completely);
    if (!mainStoryMinutes && !mainExtraMinutes && !completionistMinutes) {
      return { ...emptyResult(steamAppId, "no_duration"), providerGameId: gameIds[0], submissionCount: validCount(row.count) };
    }
    const submissionCount = validCount(row.count);
    return {
      steamAppId,
      provider: "igdb",
      providerGameId: gameIds[0],
      mainStoryMinutes,
      mainExtraMinutes,
      completionistMinutes,
      submissionCount,
      providerUpdatedAt: validTimestamp(row.updated_at),
      status: "matched",
      confidence: submissionCount == null ? "low" : submissionCount >= 25 ? "high" : submissionCount >= 5 ? "medium" : "low"
    };
  }

  private async getSteamSourceId() {
    if (this.steamSourceId) return this.steamSourceId;
    if (this.steamSourcePromise) return this.steamSourcePromise;
    this.steamSourcePromise = this.fetchSteamSourceId();
    try {
      this.steamSourceId = await this.steamSourcePromise;
      return this.steamSourceId;
    } finally {
      this.steamSourcePromise = null;
    }
  }

  private async fetchSteamSourceId() {
    const rows = await this.igdb<Array<{ id?: number; name?: string }>>(
      "external_game_sources",
      'fields id,name; where name = "Steam"; limit 2;'
    );
    const ids = [...new Set(rows.filter((row) => row.name === "Steam" && Number.isInteger(row.id)).map((row) => Number(row.id)))];
    if (ids.length !== 1) throw new IgdbRequestError("steam_source_unavailable", 502, "Steam source mapping is unavailable");
    return ids[0];
  }

  private async igdb<T>(endpoint: string, body: string, refreshed = false): Promise<T> {
    const token = await this.getToken();
    await this.paceIgdbRequest();
    const response = await this.fetcher(`https://api.igdb.com/v4/${endpoint}`, {
      method: "POST",
      headers: { "Client-ID": this.clientId, Authorization: `Bearer ${token.value}`, Accept: "application/json", "Content-Type": "text/plain" },
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 401 && !refreshed) {
      this.token = null;
      return this.igdb<T>(endpoint, body, true);
    }
    if (!response.ok) throw new IgdbRequestError(`igdb_${response.status}`, response.status, "IGDB request failed");
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new IgdbRequestError("malformed_response", 502, "IGDB returned an invalid response");
    return data as T;
  }

  private async paceIgdbRequest() {
    const waitMs = Math.max(0, 275 - (Date.now() - this.lastIgdbRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastIgdbRequestAt = Date.now();
  }

  private async getToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.fetchToken();
    try {
      this.token = await this.tokenPromise;
      return this.token;
    } finally {
      this.tokenPromise = null;
    }
  }

  private async fetchToken(): Promise<Token> {
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials" });
    const response = await this.fetcher("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new IgdbRequestError("twitch_auth_failed", response.status, "Provider authentication failed");
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") throw new IgdbRequestError("malformed_token", 502, "Provider authentication returned an invalid response");
    return { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  }
}

function emptyResult(steamAppId: number, status: GameDurationResult["status"]): GameDurationResult {
  return { steamAppId, provider: "igdb", providerGameId: null, mainStoryMinutes: null, mainExtraMinutes: null,
    completionistMinutes: null, submissionCount: null, providerUpdatedAt: null, status, confidence: "none" };
}
function validCount(value: unknown) { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
function validTimestamp(value: unknown) { return typeof value === "number" && value > 0 ? new Date(value * 1000).toISOString() : null; }
