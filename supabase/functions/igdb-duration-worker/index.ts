import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { IgdbDurationProvider, IgdbRequestError } from "../_shared/igdb-duration-provider.ts";
import type { GameDurationResult } from "../_shared/duration-provider.ts";

type Job = { steam_app_id: number; attempts: number };
const MAX_ATTEMPTS = 5;

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!authorised(request)) return json({ error: "unauthorised" }, 401);

  const clientId = Deno.env.get("IGDB_CLIENT_ID");
  const clientSecret = Deno.env.get("IGDB_CLIENT_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!clientId || !clientSecret || !supabaseUrl || !serviceKey) return json({ error: "worker_not_configured" }, 503);

  const body = await safeBody(request);
  const batchSize = clamp(body.batchSize, 1, 8, 4);
  const workerId = `igdb-${crypto.randomUUID()}`;
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc("claim_game_duration_jobs", { p_limit: batchSize, p_worker_id: workerId });
  if (error) return json({ error: "job_claim_failed" }, 500);

  const jobs = (data ?? []) as Job[];
  const provider = new IgdbDurationProvider(clientId, clientSecret);
  const summary = { claimed: jobs.length, matched: 0, no_duration: 0, not_found: 0, needs_review: 0, retried: 0, failed: 0 };

  for (const job of jobs) {
    try {
      const result = await provider.findBySteamAppId(Number(job.steam_app_id));
      await persistResult(supabase, result);
      if (result.status === "matched") summary.matched += 1;
      else if (result.status === "no_duration") summary.no_duration += 1;
      else if (result.status === "not_found") summary.not_found += 1;
      else summary.needs_review += 1;
      await supabase.from("game_duration_jobs").update({
        status: result.status === "ambiguous" || result.status === "needs_review" ? "needs_review" : "completed",
        attempts: Number(job.attempts || 0) + 1, locked_at: null, locked_by: null,
        last_error_code: null, last_error_message: null, updated_at: new Date().toISOString()
      }).eq("steam_app_id", job.steam_app_id).eq("locked_by", workerId);
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const retryable = isRetryable(error) && attempts < MAX_ATTEMPTS;
      const delayMs = retryable ? backoff(attempts) : 0;
      const code = error instanceof IgdbRequestError ? error.code : "provider_error";
      const message = error instanceof Error ? error.message : "Duration lookup failed";
      await supabase.from("game_duration_jobs").update({
        status: retryable ? "retry" : "failed", attempts,
        next_attempt_at: retryable ? new Date(Date.now() + delayMs).toISOString() : new Date().toISOString(),
        locked_at: null, locked_by: null, last_error_code: code.slice(0, 80),
        last_error_message: sanitise(message), updated_at: new Date().toISOString()
      }).eq("steam_app_id", job.steam_app_id).eq("locked_by", workerId);
      retryable ? summary.retried += 1 : summary.failed += 1;
    }
  }
  return json(summary);
});

function authorised(request: Request) {
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied || supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
}

async function persistResult(supabase: ReturnType<typeof createClient>, result: GameDurationResult) {
  const checkedAt = new Date();
  const longCache = result.status === "matched" ? 365 : 150;
  const { error } = await supabase.from("game_duration_estimates").upsert({
    steam_app_id: result.steamAppId, provider: result.provider, provider_game_id: result.providerGameId,
    main_story_minutes: result.mainStoryMinutes, main_extra_minutes: result.mainExtraMinutes,
    completionist_minutes: result.completionistMinutes, submission_count: result.submissionCount,
    match_status: result.status, match_confidence: result.confidence,
    provider_updated_at: result.providerUpdatedAt, checked_at: checkedAt.toISOString(),
    next_refresh_at: new Date(checkedAt.getTime() + longCache * 86_400_000).toISOString(),
    last_error_code: null, updated_at: checkedAt.toISOString()
  }, { onConflict: "steam_app_id,provider" });
  if (error) throw new Error("Estimate persistence failed");
}

async function safeBody(request: Request) { try { return await request.json() as { batchSize?: number }; } catch { return {}; } }
function isRetryable(error: unknown) { return !(error instanceof IgdbRequestError) || error.status === 429 || error.status >= 500; }
function backoff(attempt: number) { return Math.min(6 * 3_600_000, 60_000 * 2 ** attempt) + Math.floor(Math.random() * 30_000); }
function sanitise(value: string) { return value.replace(/bearer\s+\S+/gi, "Bearer [redacted]").replace(/[?&](client_secret|client_id)=[^&\s]+/gi, "$1=[redacted]").slice(0, 500); }
function clamp(value: unknown, min: number, max: number, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback; }
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
