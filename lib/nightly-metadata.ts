import { processDurationQueue } from "@/lib/duration-worker";
import { upsertSteamGames } from "@/lib/games";
import { fetchOwnedSteamGames } from "@/lib/steam";
import {
  processSteamMetadataQueue,
  queueAllKnownSteamMetadata
} from "@/lib/steam-metadata";
import { getSupabaseAdmin } from "@/lib/supabase";

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
        const savedGames = await upsertSteamGames(user.id, ownedGames);
        librariesRefreshed += 1;
        gamesRefreshed += savedGames.length;
      } catch (error) {
        failures.push({ userId: user.id, stage: "owned-library", error: errorMessage(error) });
      }
    }));
  }

  let metadataQueued = 0;
  const steamMetadata = [];
  try {
    metadataQueued = await queueAllKnownSteamMetadata();
    const metadataDeadline = Math.min(deadlineAt - 35_000, Date.now() + 150_000);
    while (Date.now() + 5_000 < metadataDeadline) {
      const result = await processSteamMetadataQueue(60, false, metadataDeadline);
      steamMetadata.push(result);
      if (!result.claimed || !result.processed || !result.remaining || result.deferred) break;
    }
  } catch (error) {
    failures.push({ stage: "steam-app-metadata", error: errorMessage(error) });
  }

  const durations = [];
  try {
    while (Date.now() + 25_000 < deadlineAt) {
      const result = await processDurationQueue(16, deadlineAt);
      durations.push(result);
      if (!result.claimed || result.deferred) break;
    }
  } catch (error) {
    failures.push({ stage: "durations", error: errorMessage(error) });
  }

  return {
    users: users.length,
    librariesRefreshed,
    librariesDeferred,
    gamesRefreshed,
    metadataQueued,
    steamMetadata,
    durations,
    failures
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown worker error";
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
