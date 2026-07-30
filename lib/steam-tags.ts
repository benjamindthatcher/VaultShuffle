import { getSupabaseAdmin } from "@/lib/supabase";

const STEAMSPY_MIN_INTERVAL_MS = 1_100;
const TAG_REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;
const FAILED_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const STALE_PROCESSING_AFTER_MS = 15 * 60 * 1_000;

type SteamTagQueueRow = {
  steam_appid: number;
  tags_failure_count: number | null;
};

let nextSteamSpyRequestAt = 0;

export async function queueAllKnownSteamTags() {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const refreshBefore = new Date(now.getTime() - TAG_REFRESH_AFTER_MS).toISOString();
  const retryBefore = new Date(now.getTime() - FAILED_RETRY_AFTER_MS).toISOString();

  const { error: refreshError } = await supabase
    .from("catalog_games")
    .update({
      tags_status: "pending",
      tags_next_attempt_at: now.toISOString(),
      tags_last_error: null,
      updated_at: now.toISOString()
    })
    .eq("tags_status", "ready")
    .or(`tags_fetched_at.is.null,tags_fetched_at.lt.${refreshBefore}`);
  if (refreshError) throw refreshError;

  const { error: retryError } = await supabase
    .from("catalog_games")
    .update({
      tags_status: "pending",
      tags_next_attempt_at: now.toISOString(),
      tags_last_error: null,
      updated_at: now.toISOString()
    })
    .eq("tags_status", "failed")
    .lt("updated_at", retryBefore);
  if (retryError) throw retryError;

  const { count, error: countError } = await supabase
    .from("catalog_games")
    .select("steam_appid", { count: "exact", head: true })
    .eq("tags_status", "pending");
  if (countError) throw countError;
  return count ?? 0;
}

export async function processSteamTagQueue(limit = 180, deadlineAt = Date.now() + 270_000) {
  const supabase = getSupabaseAdmin();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_AFTER_MS).toISOString();

  const { error: recoveryError } = await supabase
    .from("catalog_games")
    .update({
      tags_status: "pending",
      tags_processing_started_at: null,
      tags_next_attempt_at: now.toISOString(),
      tags_last_error: "Recovered an expired Steam tag worker lease.",
      updated_at: now.toISOString()
    })
    .eq("tags_status", "processing")
    .lt("tags_processing_started_at", staleBefore);
  if (recoveryError) throw recoveryError;

  const { data, error } = await supabase
    .from("catalog_games")
    .select("steam_appid, tags_failure_count")
    .eq("tags_status", "pending")
    .or(`tags_next_attempt_at.is.null,tags_next_attempt_at.lte.${now.toISOString()}`)
    .order("tags_fetched_at", { ascending: true, nullsFirst: true })
    .order("steam_appid", { ascending: true })
    .limit(clamp(limit, 1, 220));
  if (error) throw error;

  const candidates = (data ?? []) as SteamTagQueueRow[];
  const rows: SteamTagQueueRow[] = [];
  for (const candidate of candidates) {
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimError } = await supabase
      .from("catalog_games")
      .update({
        tags_status: "processing",
        tags_processing_started_at: claimedAt,
        updated_at: claimedAt
      })
      .eq("steam_appid", candidate.steam_appid)
      .eq("tags_status", "pending")
      .select("steam_appid, tags_failure_count")
      .maybeSingle();
    if (claimError) throw claimError;
    if (claimed) rows.push(claimed as SteamTagQueueRow);
  }

  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    if (Date.now() + STEAMSPY_MIN_INTERVAL_MS >= deadlineAt) {
      await releaseTagClaim(row.steam_appid);
      continue;
    }

    try {
      const tags = await fetchSteamCommunityTags(row.steam_appid);
      const checkedAt = new Date().toISOString();
      const { error: updateError } = await supabase
        .from("catalog_games")
        .update({
          tags,
          tags_source: "steamspy",
          tags_status: "ready",
          tags_fetched_at: checkedAt,
          tags_processing_started_at: null,
          tags_next_attempt_at: null,
          tags_failure_count: 0,
          tags_last_error: null,
          updated_at: checkedAt
        })
        .eq("steam_appid", row.steam_appid);
      if (updateError) throw updateError;
      updated += 1;
    } catch (error) {
      failed += 1;
      const failureCount = Number(row.tags_failure_count || 0) + 1;
      const terminal = failureCount >= 5;
      const checkedAt = new Date().toISOString();
      const { error: failureError } = await supabase
        .from("catalog_games")
        .update({
          tags_status: terminal ? "failed" : "pending",
          tags_processing_started_at: null,
          tags_next_attempt_at: terminal
            ? null
            : new Date(Date.now() + Math.min(2 ** failureCount * 60_000, 6 * 60 * 60_000)).toISOString(),
          tags_failure_count: failureCount,
          tags_last_error: errorMessage(error),
          updated_at: checkedAt
        })
        .eq("steam_appid", row.steam_appid);
      if (failureError) throw failureError;
    }
  }

  const { count, error: countError } = await supabase
    .from("catalog_games")
    .select("steam_appid", { count: "exact", head: true })
    .in("tags_status", ["pending", "processing"]);
  if (countError) throw countError;

  return {
    claimed: rows.length,
    updated,
    failed,
    remaining: count ?? 0
  };
}

async function fetchSteamCommunityTags(steamAppId: number) {
  await waitForSteamSpyRateLimit();
  const params = new URLSearchParams({
    request: "appdetails",
    appid: String(steamAppId)
  });
  const response = await fetch(`https://steamspy.com/api.php?${params.toString()}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "VaultShuffle metadata worker/1.0"
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000)
  });

  if (response.status === 429) {
    throw new Error("SteamSpy rate limit reached.");
  }
  if (!response.ok) {
    throw new Error(`SteamSpy returned HTTP ${response.status}.`);
  }

  const payload = await response.json() as Record<string, unknown>;
  if (Number(payload.appid) !== steamAppId) {
    throw new Error("SteamSpy returned metadata for a different AppID.");
  }
  return sanitizeSteamTags(payload.tags);
}

function sanitizeSteamTags(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([rawTag, rawWeight]) => {
    const tag = rawTag.trim().replace(/\s+/g, " ");
    const weight = Math.max(0, Math.round(Number(rawWeight)));
    return tag && tag.length <= 100 && Number.isFinite(weight) ? [[tag, weight] as const] : [];
  });
  return Object.fromEntries(entries);
}

async function waitForSteamSpyRateLimit() {
  const delay = Math.max(0, nextSteamSpyRequestAt - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  nextSteamSpyRequestAt = Date.now() + STEAMSPY_MIN_INTERVAL_MS;
}

async function releaseTagClaim(steamAppId: number) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("catalog_games")
    .update({
      tags_status: "pending",
      tags_processing_started_at: null,
      tags_next_attempt_at: now,
      updated_at: now
    })
    .eq("steam_appid", steamAppId)
    .eq("tags_status", "processing");
  if (error) throw error;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown Steam tag worker error";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.floor(Number(value) || min), max));
}
