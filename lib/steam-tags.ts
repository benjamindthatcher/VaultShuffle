import { getSupabaseAdmin } from "@/lib/supabase";
import { steamRetryAfter } from "@/lib/steam-api-error";
import { promoteIfEndless } from "@/lib/endless-sync";

const STEAMSPY_MIN_INTERVAL_MS = 1_100;
const TAG_REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;
const FAILED_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

type SteamTagQueueRow = {
  steam_appid: number;
  tags_failure_count: number | null;
};

class SteamTagRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super("SteamSpy rate limit reached."); }
}

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
    // Only what SteamSpy wrote is on SteamSpy's refresh clock. Without this the
    // 30-day sweep re-queued every row whatever its source, so the 18,312 rows
    // carrying Steam store-page tags were due to be handed to SteamSpy from
    // 2026-09-23 and overwritten one by one - with nothing at all for the newer
    // games those tags were fetched for in the first place.
    .eq("tags_source", "steamspy")
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

export async function processSteamTagQueue(limit = 60, deadlineAt = Date.now() + 70_000) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("claim_steam_tag_jobs", {
    p_limit: clamp(limit, 1, 220)
  });
  if (error) throw error;
  const rows = (data ?? []) as SteamTagQueueRow[];
  const held = await loadHeldTags(supabase, rows.map((row) => row.steam_appid));

  let updated = 0;
  let kept = 0;
  let endlessPromotions = 0;
  let failed = 0;
  let deferred = 0;
  let rateLimited = false;
  let consecutiveFailures = 0;
  for (const [index, row] of rows.entries()) {
    // Reserve a full request timeout and pacing interval, then release untouched
    // claims together. Do not burn one DB round trip per deferred game.
    if (Date.now() + 15_000 + STEAMSPY_MIN_INTERVAL_MS >= deadlineAt) {
      const pending = rows.slice(index).map((entry) => entry.steam_appid);
      await releaseTagClaims(pending);
      deferred += pending.length;
      break;
    }

    try {
      const tags = await fetchSteamCommunityTags(row.steam_appid);
      const checkedAt = new Date().toISOString();
      const current = held.get(row.steam_appid);
      const decision = tagWriteDecision(current, tags);
      // Whatever we decide about the tags, the queue state is settled: the row has
      // been looked at, so it must not come straight back to the front tomorrow.
      const settled = {
        tags_status: "ready",
        tags_processing_started_at: null,
        tags_next_attempt_at: null,
        tags_failure_count: 0,
        tags_last_error: null,
        updated_at: checkedAt
      };
      // tags_fetched_at is SteamSpy's own clock, so it only moves for rows SteamSpy
      // owns. Moving it is what stops a game it can never tag being re-claimed every
      // night ahead of everything else - the queue is ordered oldest-fetched first.
      const ownedBySteamSpy = !current?.source || current.source === "steamspy";
      const values = decision === "write"
        ? { ...settled, tags, tags_source: "steamspy", tags_fetched_at: checkedAt }
        : ownedBySteamSpy ? { ...settled, tags_fetched_at: checkedAt } : settled;

      const { error: updateError } = await supabase
        .from("catalog_games")
        .update(values)
        .eq("steam_appid", row.steam_appid);
      if (updateError) throw updateError;
      if (decision === "write") updated += 1; else kept += 1;
      consecutiveFailures = 0;

      // Fresh tags are the one input the endless verdict really turns on, so this
      // is where it gets re-asked. Never allowed to fail the tag write: the tags
      // are the job, and a length verdict is an enhancement on top of them.
      // Nothing to re-ask when the tags did not change.
      if (decision === "write") {
        try {
          const verdict = await promoteIfEndless(supabase, row.steam_appid, tags);
          if (verdict.promoted) endlessPromotions += 1;
        } catch (error) {
          console.error(JSON.stringify({
            level: "warning",
            message: "Could not re-check the endless verdict after storing tags.",
            steamAppId: row.steam_appid,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      }
    } catch (error) {
      if (error instanceof SteamTagRateLimitError) {
        const pending = rows.slice(index).map((entry) => entry.steam_appid);
        await releaseTagClaims(pending, new Date(Date.now() + Math.max(30 * 60, error.retryAfterSeconds) * 1000).toISOString());
        deferred += pending.length;
        rateLimited = true;
        break;
      }
      failed += 1;
      consecutiveFailures += 1;
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
      if (consecutiveFailures >= 3) {
        const pending = rows.slice(index + 1).map((entry) => entry.steam_appid);
        await releaseTagClaims(pending);
        deferred += pending.length;
        break;
      }
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
    kept,
    endlessPromotions,
    failed,
    deferred,
    rateLimited,
    remaining: count ?? 0
  };
}

export type TagWriteDecision = "write" | "keep-existing" | "keep-other-source";

/**
 * Whether SteamSpy's answer should replace what a game already has.
 *
 * SteamSpy is not the only source of tags and is the weaker one for anything
 * recent: it returns `tags: []` for newer games - Metro Exodus, ARC Raiders, PEAK
 * all came back empty - which sanitizeSteamTags turns into `{}`. Written straight
 * through, that marks a game tagged with nothing, and every filter that reads tags
 * goes blind on exactly the games people are most likely to be looking for.
 */
export function tagWriteDecision(
  current: { hasTags: boolean; source: string | null } | undefined,
  fetched: Record<string, number>
): TagWriteDecision {
  // Nothing to protect. Even an empty answer is worth recording: it is what
  // SteamSpy knows, and the row held nothing before.
  if (!current?.hasTags) return "write";
  // Store-page tags carry real vote weights for games SteamSpy has never heard of.
  // SteamSpy does not get to replace them, whatever it returns.
  if (current.source && current.source !== "steamspy") return "keep-other-source";
  // SteamSpy refreshing its own row, with nothing to say this time.
  if (!Object.keys(fetched).length) return "keep-existing";
  return "write";
}

/** What the claimed rows already hold, read once rather than per game. */
async function loadHeldTags(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  steamAppIds: number[]
) {
  const held = new Map<number, { hasTags: boolean; source: string | null }>();
  if (!steamAppIds.length) return held;

  const { data, error } = await supabase
    .from("catalog_games")
    .select("steam_appid, tags, tags_source")
    .in("steam_appid", steamAppIds);
  if (error) throw error;

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const tags = row.tags as Record<string, number> | null;
    held.set(Number(row.steam_appid), {
      hasTags: Boolean(tags && Object.keys(tags).length),
      source: (row.tags_source as string | null) ?? null
    });
  }
  return held;
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
    throw new SteamTagRateLimitError(steamRetryAfter(response.headers.get("Retry-After")));
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

async function releaseTagClaims(steamAppIds: number[], retryAt = new Date().toISOString()) {
  if (!steamAppIds.length) return;
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("catalog_games")
    .update({
      tags_status: "pending",
      tags_processing_started_at: null,
      tags_next_attempt_at: retryAt,
      updated_at: now
    })
    .in("steam_appid", steamAppIds)
    .eq("tags_status", "processing");
  if (error) throw error;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown Steam tag worker error";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.floor(Number(value) || min), max));
}
