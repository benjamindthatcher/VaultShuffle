import { processDurationQueue } from "@/lib/duration-worker";
import { recordSteamVisibility, upsertSteamGames } from "@/lib/games";
import { recordImportedSteamAppIds } from "@/lib/catalogue";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { steamVisibilityFromGames } from "@/lib/steam-owned-games";
import { capturePlaytimeSnapshot } from "@/lib/playtime-snapshots";
import { getSupabaseAdmin } from "@/lib/supabase";
import { formatMetadataWorkerError } from "@/lib/worker-runs";

type SteamUser = {
  id: string;
  steam_id: string;
};

export async function refreshNightlyMetadata() {
  const apiKey = process.env.STEAM_WEB_API_KEY;
  if (!apiKey) throw new Error("STEAM_WEB_API_KEY is required for the nightly refresh.");

  const users = await loadSteamUsers();
  const deadlineAt = Date.now() + 275_000;
  const libraryDeadlineAt = Math.min(deadlineAt - 150_000, Date.now() + 90_000);
  let librariesRefreshed = 0;
  let librariesDeferred = 0;
  let gamesRefreshed = 0;
  const failures: Array<{ userId?: string; stage: string; error: string }> = [];

  for (let index = 0; index < users.length; index += 3) {
    if (Date.now() + 20_000 >= libraryDeadlineAt) {
      librariesDeferred = users.length - index;
      break;
    }

    const batch = users.slice(index, index + 3);
    await Promise.all(batch.map(async (user) => {
      try {
        const ownedGames = await fetchOwnedSteamGames(user.steam_id, apiKey);
        const appIds = ownedGames.flatMap((game) => game.steam_appid ? [String(game.steam_appid)] : []);
        try {
          await recordImportedSteamAppIds(user.id, appIds);
        } catch (error) {
          failures.push({
            userId: user.id,
            stage: "catalogue-registration",
            error: formatMetadataWorkerError(error, 500) ?? "Unknown worker error"
          });
        }
        const savedGames = await upsertSteamGames(user.id, ownedGames);
        // Recorded every night so a change in someone's Steam privacy settings
        // shows up on its own rather than being discovered by reading rows.
        await recordSteamVisibility(user.id, steamVisibilityFromGames(ownedGames)).catch(() => undefined);
        // Written from the library we already have in hand, so this costs no extra
        // Steam calls. Steam exposes only a running total, so a day that is not
        // recorded tonight can never be recovered.
        await capturePlaytimeSnapshot(user.id, ownedGames);
        librariesRefreshed += 1;
        gamesRefreshed += savedGames.length;
      } catch (error) {
        failures.push({
          userId: user.id,
          stage: "owned-library",
          error: formatMetadataWorkerError(error, 500) ?? "Unknown worker error"
        });
      }
    }));
  }

  const durations = [];
  try {
    while (Date.now() + 25_000 < deadlineAt) {
      const result = await processDurationQueue(16, deadlineAt);
      durations.push(result);
      if (!result.claimed || result.deferred) break;
    }
  } catch (error) {
    failures.push({
      stage: "durations",
      error: formatMetadataWorkerError(error, 500) ?? "Unknown worker error"
    });
  }

  return {
    users: users.length,
    librariesRefreshed,
    librariesDeferred,
    gamesRefreshed,
    durations,
    failures
  };
}

async function loadSteamUsers() {
  const supabase = getSupabaseAdmin();
  const users: SteamUser[] = [];
  const pageSize = 500;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("app_users")
      .select("id, steam_id")
      .not("steam_id", "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as SteamUser[];
    users.push(...page.filter((user) => Boolean(user.steam_id)));
    if (page.length < pageSize) break;
  }

  return users;
}
