import { recordSteamVisibility, upsertSteamGames } from "@/lib/games";
import { recordImportedSteamAppIds } from "@/lib/catalogue";
import { fetchOwnedSteamGames, fetchRecentlyPlayedSteamAppIds } from "@/lib/steam";
import { SteamApiError } from "@/lib/steam-api-error";
import { syncSteamRecentWindow } from "@/lib/recency-sync";
import { steamVisibilityFromGames } from "@/lib/steam-owned-games";
import { capturePlaytimeSnapshot } from "@/lib/playtime-snapshots";
import { getSupabaseAdmin } from "@/lib/supabase";
import { diagnosticFailure, diagnosticId } from "@/lib/diagnostics";

type SteamUser = {
  id: string;
  steam_id: string;
};

export async function refreshNightlyMetadata() {
  const apiKey = process.env.STEAM_WEB_API_KEY;
  if (!apiKey) throw new Error("STEAM_WEB_API_KEY is required for the nightly refresh.");

  const deadlineAt = Date.now() + 90_000;
  const previousCursor = await loadLibraryCursor();
  const users = await loadSteamUsers(previousCursor);
  // A verified account and one or more manual profiles can point at the same
  // public Steam library. Read that library once per run, then apply the answer
  // to each independent VaultShuffle account.
  const libraryFetches = new Map<string, ReturnType<typeof fetchOwnedSteamGames>>();
  const recentFetches = new Map<string, ReturnType<typeof fetchRecentlyPlayedSteamAppIds>>();
  let librariesRefreshed = 0;
  let librariesAttempted = 0;
  let gamesRefreshed = 0;
  let rateLimited = false;
  let lastAccountId = previousCursor;
  let failed = 0;
  const failures: Array<{ userId: string; stage: string; error: string }> = [];
  function recordFailure(userId: string, stage: string, error: unknown) {
    failed += 1;
    // Keep the existing one-row run summary small; no library contents or raw
    // upstream/SQL messages are retained in it.
    if (failures.length < 20) failures.push({ userId, stage, error: String(diagnosticFailure(error).error_code ?? "worker_error") });
  }

  for (let index = 0; index < users.length; index += 3) {
    if (rateLimited || Date.now() + 30_000 >= deadlineAt) break;

    const batch = users.slice(index, index + 3);
    await Promise.all(batch.map(async (user) => {
      try {
        let libraryFetch = libraryFetches.get(user.steam_id);
        if (!libraryFetch) {
          libraryFetch = fetchOwnedSteamGames(user.steam_id, apiKey);
          libraryFetches.set(user.steam_id, libraryFetch);
        }
        const ownedGames = await libraryFetch;
        const appIds = ownedGames.flatMap((game) => game.steam_appid ? [String(game.steam_appid)] : []);
        try {
          await recordImportedSteamAppIds(user.id, appIds);
        } catch (error) {
          recordFailure(user.id, "catalogue-registration", error);
        }
        // Runs before the upsert writes the new baseline, so window evidence is
        // judged against what we knew going in rather than what we just learned.
        let recentFetch = recentFetches.get(user.steam_id);
        if (!recentFetch) {
          recentFetch = rateLimited ? Promise.resolve([]) : fetchRecentlyPlayedSteamAppIds(user.steam_id, apiKey);
          recentFetches.set(user.steam_id, recentFetch);
        }
        const recentWindow = await syncSteamRecentWindow(user.id, user.steam_id, apiKey, recentFetch);
        if (recentWindow.error) {
          recordFailure(user.id, "recent-window", { code: recentWindow.failure?.error_code });
          rateLimited ||= recentWindow.failure?.upstream_status === 429;
        }
        const savedGames = await upsertSteamGames(user.id, ownedGames);
        // Record visibility when this account's turn in the nightly sweep arrives.
        await recordSteamVisibility(user.id, steamVisibilityFromGames(ownedGames))
          .catch((error) => recordFailure(user.id, "visibility", error));
        // Written from the library we already have in hand, so this costs no extra
        // Steam calls. Steam exposes only a running total, so a day that is not
        // recorded tonight can never be recovered.
        await capturePlaytimeSnapshot(user.id, ownedGames);
        librariesRefreshed += 1;
        gamesRefreshed += savedGames.length;
      } catch (error) {
        rateLimited ||= error instanceof SteamApiError && error.upstreamStatus === 429;
        recordFailure(user.id, "owned-library", error);
      }
    }));
    librariesAttempted += batch.length;
    lastAccountId = batch[batch.length - 1].id;
  }

  return {
    candidates: users.length,
    candidateLimitReached: users.length === 150,
    librariesAttempted,
    librariesRefreshed,
    librariesDeferred: users.length - librariesAttempted,
    gamesRefreshed,
    lastAccountId,
    rateLimited,
    failed,
    failures
  };
}

async function loadLibraryCursor() {
  const { data, error } = await getSupabaseAdmin()
    .from("metadata_worker_runs")
    .select("summary")
    .eq("worker_name", "nightly-metadata")
    .in("status", ["succeeded", "partial"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return diagnosticId(data?.summary?.lastAccountId) ?? null;
}

/** Bounded keyset scan across both identity tables, continuing next night. */
async function loadSteamUsers(cursor: string | null) {
  const supabase = getSupabaseAdmin();
  const limit = 150;

  async function loadIdentityTable(table: "app_users" | "manual_steam_profiles", wrap = false) {
    let query = supabase
      .from(table)
      .select("id, steam_id")
      .not("steam_id", "is", null)
      .order("id", { ascending: true })
      .limit(limit);
    if (cursor) query = wrap ? query.lte("id", cursor) : query.gt("id", cursor);
    const { data, error } = await query;
    if (error) throw error;
    return ((data ?? []) as SteamUser[]).filter((user) => Boolean(user.steam_id));
  }

  const pages = await Promise.all([
    loadIdentityTable("app_users"),
    loadIdentityTable("manual_steam_profiles"),
  ]);
  const byId = (a: SteamUser, b: SteamUser) => a.id.localeCompare(b.id);
  const users = pages.flat().sort(byId).slice(0, limit);
  if (cursor && users.length < limit) {
    const wrapped = await Promise.all([
      loadIdentityTable("app_users", true),
      loadIdentityTable("manual_steam_profiles", true),
    ]);
    users.push(...wrapped.flat().sort(byId).slice(0, limit - users.length));
  }
  return users;
}
