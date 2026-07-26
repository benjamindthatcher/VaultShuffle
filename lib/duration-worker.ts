import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import { IgdbDurationProvider } from "@/supabase/functions/_shared/igdb-duration-provider";

type DurationJob = { steam_app_id: number; attempts: number };

const MAX_ATTEMPTS = 5;

export async function processDurationQueue(limit = 8) {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Duration provider is not configured.");

  const supabase = getSupabaseAdmin();
  await supabase.rpc("queue_missing_game_durations", { p_limit: 250 });
  const workerId = `vercel-${crypto.randomUUID()}`;
  const { data, error } = await supabase.rpc("claim_game_duration_jobs", {
    p_limit: Math.max(1, Math.min(48, Math.floor(limit))),
    p_worker_id: workerId
  });
  if (error) throw error;

  const provider = new IgdbDurationProvider(clientId, clientSecret);
  const jobs = (data ?? []) as DurationJob[];
  const summary = { claimed: jobs.length, matched: 0, noDuration: 0, notFound: 0, ambiguous: 0, retried: 0, failed: 0 };

  for (const job of jobs) {
    try {
      const [{ data: catalogue }, { data: alias }] = await Promise.all([
        supabase.from("catalog_games").select("name,release_date").eq("steam_appid", job.steam_app_id).maybeSingle(),
        supabase.from("game_duration_aliases").select("search_title,release_year,review_status").eq("steam_app_id", job.steam_app_id).maybeSingle()
      ]);
      const result = await provider.findBySteamAppId(Number(job.steam_app_id), {
        title: alias?.review_status === "approved" ? alias.search_title : catalogue?.name,
        releaseYear: alias?.review_status === "approved"
          ? alias.release_year
          : catalogue?.release_date ? new Date(catalogue.release_date).getUTCFullYear() : null
      });
      const checkedAt = new Date();
      const { error: estimateError } = await supabase.from("game_duration_estimates").upsert({
        steam_app_id: result.steamAppId,
        provider: result.provider,
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

      if (result.status === "matched") summary.matched += 1;
      else if (result.status === "no_duration") summary.noDuration += 1;
      else if (result.status === "not_found") summary.notFound += 1;
      else summary.ambiguous += 1;
      const { error: completedError } = await supabase.from("game_duration_jobs").update({
        status: result.status === "ambiguous" ? "needs_review" : "completed",
        attempts: Number(job.attempts || 0) + 1,
        locked_at: null,
        locked_by: null,
        last_error_code: null,
        last_error_message: null,
        updated_at: new Date().toISOString()
      }).eq("steam_app_id", job.steam_app_id).eq("locked_by", workerId);
      if (completedError) throw completedError;
    } catch (caught) {
      const attempts = Number(job.attempts || 0) + 1;
      const retry = attempts < MAX_ATTEMPTS;
      const { error: retryError } = await supabase.from("game_duration_jobs").update({
        status: retry ? "retry" : "failed",
        attempts,
        next_attempt_at: retry ? new Date(Date.now() + Math.min(6 * 3_600_000, 60_000 * 2 ** attempts)).toISOString() : new Date().toISOString(),
        locked_at: null,
        locked_by: null,
        last_error_code: "provider_error",
        last_error_message: caught instanceof Error ? caught.message.slice(0, 500) : "Duration lookup failed",
        updated_at: new Date().toISOString()
      }).eq("steam_app_id", job.steam_app_id).eq("locked_by", workerId);
      if (retryError) throw retryError;
      retry ? summary.retried += 1 : summary.failed += 1;
    }
  }

  return summary;
}
