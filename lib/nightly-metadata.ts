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
  let librariesRefreshed = 0;
  let gamesRefreshed = 0;
  const failures: Array<{ userId?: string; stage: string; error: string }> = [];

  for (const batch of chunks(users, 3)) {
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
    const metadataDeadline = Date.now() + 120_000;
    for (let batch = 0; batch < 3 && Date.now() < metadataDeadline; batch += 1) {
      const result = await processSteamMetadataQueue(40, false);
      steamMetadata.push(result);
      if (!result.remaining) break;
    }
  } catch (error) {
    failures.push({ stage: "steam-app-metadata", error: errorMessage(error) });
  }

  const durations = [];
  try {
    for (let batch = 0; batch < 3; batch += 1) {
      const result = await processDurationQueue(48);
      durations.push(result);
      if (!result.claimed) break;
    }
  } catch (error) {
    failures.push({ stage: "durations", error: errorMessage(error) });
  }

  return {
    users: users.length,
    librariesRefreshed,
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

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
