import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchPinnedSteamPlaytime } from "@/lib/steam";
import { SteamApiError } from "@/lib/steam-api-error";
import { diagnosticId, diagnosticFailure } from "@/lib/diagnostics";

type Account = { id: string; steam_id: string; appids: string[] };
const ACCOUNT_LIMIT = 150;
const CONCURRENCY = 4;

/** Pins only. No imports, catalogue enrichment, library reconciliation or whole-library snapshots. */
export async function refreshPinnedPlaytime() {
  const key = process.env.STEAM_WEB_API_KEY;
  if (!key) throw new Error("STEAM_WEB_API_KEY is required for playtime refresh.");
  const deadline = Date.now() + 90_000;
  const db = getSupabaseAdmin();
  const { data: previous, error: cursorError } = await db.from("metadata_worker_runs")
    .select("summary").eq("worker_name", "pinned-playtime").in("status", ["succeeded", "partial"])
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (cursorError) throw cursorError;
  let lastAccountId = diagnosticId(previous?.summary?.lastAccountId) ?? null;
  const { data, error } = await db.rpc("get_pinned_playtime_candidates", { p_cursor: lastAccountId, p_limit: ACCOUNT_LIMIT });
  if (error) throw error;
  const accounts = ((data ?? []) as Account[]).slice(0, ACCOUNT_LIMIT);
  const fetches = new Map<string, ReturnType<typeof fetchPinnedSteamPlaytime>>();
  let accountsAttempted = 0, accountsRefreshed = 0, pinsChecked = 0, pinsUpdated = 0, pinsMissing = 0, failed = 0;
  let rateLimited = false;
  let consecutiveFailedBatches = 0;
  const failures: string[] = [];
  for (let index = 0; index < accounts.length; index += CONCURRENCY) {
    if (rateLimited || consecutiveFailedBatches >= 3 || Date.now() + 30_000 >= deadline) break;
    const batch = accounts.slice(index, index + CONCURRENCY);
    const results = await Promise.all(batch.map(async (account) => {
      try {
        const appids = [...new Set(account.appids)].sort();
        const cacheKey = `${account.steam_id}:${appids.join(",")}`;
        let pending = fetches.get(cacheKey);
        if (!pending) {
          pending = fetchPinnedSteamPlaytime(account.steam_id, key, appids);
          fetches.set(cacheKey, pending);
        }
        const games = await pending;
        const { data: saved, error: saveError } = await db.rpc("refresh_pinned_steam_playtime", {
          p_user_id: account.id, p_games: games,
        }).abortSignal(AbortSignal.timeout(15_000));
        if (saveError) throw saveError;
        pinsChecked += Number(saved?.pinned_games_matched ?? 0);
        pinsUpdated += Number(saved?.pinned_games_updated ?? 0);
        pinsMissing += Math.max(0, appids.length - Number(saved?.pinned_games_matched ?? 0));
        accountsRefreshed++;
        return true;
      } catch (error) {
        rateLimited ||= error instanceof SteamApiError && error.upstreamStatus === 429;
        failed++;
        if (failures.length < 20) failures.push(String(diagnosticFailure(error).error_code ?? "worker_error"));
        return false;
      }
    }));
    consecutiveFailedBatches = results.some(Boolean) ? 0 : consecutiveFailedBatches + 1;
    accountsAttempted += batch.length;
    lastAccountId = batch[batch.length - 1].id;
  }
  return { candidates: accounts.length, candidateLimitReached: accounts.length === ACCOUNT_LIMIT,
    accountsAttempted, accountsRefreshed, deferred: accounts.length - accountsAttempted,
    pinsChecked, pinsUpdated, pinsMissing, lastAccountId, rateLimited, failed, failures,
    stoppedAfterFailures: consecutiveFailedBatches >= 3 };
}
