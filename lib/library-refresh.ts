import { getSupabaseAdmin } from "@/lib/supabase";
import { upsertSteamGames } from "@/lib/games";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { SteamLibraryUnavailableError } from "@/lib/steam-owned-games";

/**
 * Re-imports the least recently refreshed Steam libraries.
 *
 * An import captures whatever Steam is willing to return at that moment, and
 * that is not always everything: playtime and last-played timestamps depend on
 * the account's Game details privacy setting, which people change after signing
 * up, and Steam occasionally rate limits mid-import. A library imported once is
 * therefore a snapshot, not a guarantee.
 *
 * The upsert RPC already coalesces last_played_at and only advances playtime, so
 * re-running an import fills gaps without ever overwriting good data with null.
 * That makes this safe to run repeatedly.
 */
export async function refreshStaleLibraries(userLimit = 5) {
  const apiKey = process.env.STEAM_WEB_API_KEY;
  if (!apiKey) return { refreshed: 0, skipped: 0, failed: 0, reason: "missing_api_key" as const };

  const supabase = getSupabaseAdmin();

  // Oldest-touched libraries first, so every account is reached in turn rather
  // than the same few being refreshed forever.
  const { data: staleUsers, error } = await supabase
    .rpc("list_stale_steam_libraries", { p_limit: userLimit });

  if (error) throw error;

  const targets = (staleUsers ?? []) as Array<{ user_id: string; steam_id: string }>;
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  const details: Array<Record<string, unknown>> = [];

  for (const target of targets) {
    if (!target.steam_id) {
      skipped += 1;
      continue;
    }

    try {
      const games = await fetchOwnedSteamGames(target.steam_id, apiKey);
      const saved = await upsertSteamGames(target.user_id, games);
      refreshed += 1;
      details.push({ user: target.user_id.slice(0, 8), games: saved.length });
    } catch (caught) {
      // A private library is an expected state, not a failure worth alerting on:
      // the person has simply not made their game details public.
      if (caught instanceof SteamLibraryUnavailableError) {
        skipped += 1;
        details.push({ user: target.user_id.slice(0, 8), skipped: "library_not_visible" });
        continue;
      }
      failed += 1;
      details.push({ user: target.user_id.slice(0, 8), error: caught instanceof Error ? caught.message : "unknown" });
    }
  }

  return { refreshed, skipped, failed, details };
}
