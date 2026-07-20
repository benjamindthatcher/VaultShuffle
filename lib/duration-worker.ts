import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";

type DurationJob = { steam_app_id: number; attempts: number };
type DurationResult = {
  steamAppId: number;
  providerGameId: number | null;
  mainStoryMinutes: number | null;
  mainExtraMinutes: number | null;
  completionistMinutes: number | null;
  submissionCount: number | null;
  providerUpdatedAt: string | null;
  status: "matched" | "no_duration" | "not_found" | "ambiguous";
  confidence: "none" | "low" | "medium" | "high";
};

const MAX_ATTEMPTS = 5;

export async function processDurationQueue(limit = 8) {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Duration provider is not configured.");

  const supabase = getSupabaseAdmin();
  await supabase.rpc("queue_missing_game_durations", { p_limit: 250 });
  const workerId = `vercel-${crypto.randomUUID()}`;
  const { data, error } = await supabase.rpc("claim_game_duration_jobs", {
    p_limit: Math.max(1, Math.min(8, Math.floor(limit))),
    p_worker_id: workerId
  });
  if (error) throw error;

  const provider = new IgdbDurationProvider(clientId, clientSecret);
  const jobs = (data ?? []) as DurationJob[];
  const summary = { claimed: jobs.length, matched: 0, noDuration: 0, notFound: 0, ambiguous: 0, retried: 0, failed: 0 };

  for (const job of jobs) {
    try {
      const result = await provider.findBySteamAppId(Number(job.steam_app_id));
      const checkedAt = new Date();
      const { error: estimateError } = await supabase.from("game_duration_estimates").upsert({
        steam_app_id: result.steamAppId,
        provider: "igdb",
        provider_game_id: result.providerGameId,
        main_story_minutes: result.mainStoryMinutes,
        main_extra_minutes: result.mainExtraMinutes,
        completionist_minutes: result.completionistMinutes,
        submission_count: result.submissionCount,
        match_status: result.status,
        match_confidence: result.confidence,
        provider_updated_at: result.providerUpdatedAt,
        checked_at: checkedAt.toISOString(),
        next_refresh_at: new Date(checkedAt.getTime() + (result.status === "matched" ? 365 : 150) * 86_400_000).toISOString(),
        last_error_code: null,
        updated_at: checkedAt.toISOString()
      }, { onConflict: "steam_app_id,provider" });
      if (estimateError) throw estimateError;

      summary[result.status === "no_duration" ? "noDuration" : result.status === "not_found" ? "notFound" : result.status] += 1;
      await supabase.from("game_duration_jobs").update({
        status: result.status === "ambiguous" ? "needs_review" : "completed",
        attempts: Number(job.attempts || 0) + 1,
        locked_at: null,
        locked_by: null,
        last_error_code: null,
        last_error_message: null,
        updated_at: new Date().toISOString()
      }).eq("steam_app_id", job.steam_app_id).eq("locked_by", workerId);
    } catch (caught) {
      const attempts = Number(job.attempts || 0) + 1;
      const retry = attempts < MAX_ATTEMPTS;
      await supabase.from("game_duration_jobs").update({
        status: retry ? "retry" : "failed",
        attempts,
        next_attempt_at: retry ? new Date(Date.now() + Math.min(6 * 3_600_000, 60_000 * 2 ** attempts)).toISOString() : new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        last_error_code: "provider_error",
        last_error_message: caught instanceof Error ? caught.message.slice(0, 500) : "Duration lookup failed",
        updated_at: new Date().toISOString()
      }).eq("steam_app_id", job.steam_app_id).eq("locked_by", workerId);
      retry ? summary.retried += 1 : summary.failed += 1;
    }
  }

  return summary;
}

class IgdbDurationProvider {
  private token: { value: string; expiresAt: number } | null = null;
  private steamSourceId: number | null = null;

  constructor(private readonly clientId: string, private readonly clientSecret: string) {}

  async findBySteamAppId(steamAppId: number): Promise<DurationResult> {
    const sourceId = await this.getSteamSourceId();
    const mappings = await this.request<Array<{ game?: number; uid?: string }>>(
      "external_games",
      `fields game,uid; where external_game_source = ${sourceId} & uid = "${steamAppId}"; limit 10;`
    );
    const gameIds = [...new Set(mappings.filter((row) => row.uid === String(steamAppId) && Number.isInteger(row.game)).map((row) => Number(row.game)))];
    if (!gameIds.length) return emptyResult(steamAppId, "not_found");
    if (gameIds.length !== 1) return emptyResult(steamAppId, "ambiguous");

    const rows = await this.request<Array<{ hastily?: number; normally?: number; completely?: number; count?: number; updated_at?: number }>>(
      "game_time_to_beats",
      `fields hastily,normally,completely,count,updated_at; where game = ${gameIds[0]}; limit 2;`
    );
    if (rows.length !== 1) return { ...emptyResult(steamAppId, rows.length ? "ambiguous" : "no_duration"), providerGameId: gameIds[0] };
    const row = rows[0];
    const mainStoryMinutes = toMinutes(row.hastily);
    const mainExtraMinutes = toMinutes(row.normally);
    const completionistMinutes = toMinutes(row.completely);
    const count = Number.isInteger(row.count) && Number(row.count) >= 0 ? Number(row.count) : null;
    if (!mainStoryMinutes && !mainExtraMinutes && !completionistMinutes) {
      return { ...emptyResult(steamAppId, "no_duration"), providerGameId: gameIds[0], submissionCount: count };
    }
    return {
      steamAppId,
      providerGameId: gameIds[0],
      mainStoryMinutes,
      mainExtraMinutes,
      completionistMinutes,
      submissionCount: count,
      providerUpdatedAt: Number(row.updated_at) > 0 ? new Date(Number(row.updated_at) * 1000).toISOString() : null,
      status: "matched",
      confidence: count == null ? "low" : count >= 25 ? "high" : count >= 5 ? "medium" : "low"
    };
  }

  private async getSteamSourceId() {
    if (this.steamSourceId) return this.steamSourceId;
    const rows = await this.request<Array<{ id?: number; name?: string }>>("external_game_sources", 'fields id,name; where name = "Steam"; limit 2;');
    const ids = rows.filter((row) => row.name === "Steam" && Number.isInteger(row.id)).map((row) => Number(row.id));
    if (ids.length !== 1) throw new Error("Steam source mapping is unavailable.");
    this.steamSourceId = ids[0];
    return ids[0];
  }

  private async request<T>(endpoint: string, body: string, refreshed = false): Promise<T> {
    const token = await this.getToken();
    const response = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: "POST",
      headers: { "Client-ID": this.clientId, Authorization: `Bearer ${token.value}`, Accept: "application/json", "Content-Type": "text/plain" },
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 401 && !refreshed) {
      this.token = null;
      return this.request<T>(endpoint, body, true);
    }
    if (!response.ok) throw new Error(`IGDB request failed (${response.status}).`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw new Error("IGDB returned an invalid response.");
    return data as T;
  }

  private async getToken() {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token;
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: "client_credentials" });
    const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Duration provider authentication failed.");
    const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") throw new Error("Duration provider authentication returned an invalid response.");
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token;
  }
}

function emptyResult(steamAppId: number, status: DurationResult["status"]): DurationResult {
  return { steamAppId, providerGameId: null, mainStoryMinutes: null, mainExtraMinutes: null, completionistMinutes: null, submissionCount: null, providerUpdatedAt: null, status, confidence: "none" };
}

function toMinutes(seconds: unknown) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value / 60)) : null;
}
