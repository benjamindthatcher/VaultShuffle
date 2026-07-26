import { processCatalogueQueue } from "@/lib/catalogue";
import { processDurationQueue } from "@/lib/duration-worker";
import { upsertSteamGames } from "@/lib/games";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { enrichSteamMetadataForUser } from "@/lib/steam-metadata";
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
  let wishlistListingsRefreshed = 0;
  const failures: Array<{ userId: string; stage: string }> = [];

  for (const batch of chunks(users, 3)) {
    await Promise.all(batch.map(async (user) => {
      try {
        const ownedGames = await fetchOwnedSteamGames(user.steam_id, apiKey);
        const savedGames = await upsertSteamGames(user.id, ownedGames);
        librariesRefreshed += 1;
        gamesRefreshed += savedGames.length;
      } catch {
        failures.push({ userId: user.id, stage: "owned-library" });
      }

      try {
        const wishlist = await enrichSteamMetadataForUser(user.id, 50, true, true);
        wishlistListingsRefreshed += wishlist.updated;
      } catch {
        failures.push({ userId: user.id, stage: "wishlist-store-metadata" });
      }
    }));
  }

  const catalogue = await processCatalogueQueue(100);
  const durations = [];
  for (let batch = 0; batch < 3; batch += 1) {
    durations.push(await processDurationQueue(48));
  }

  return {
    users: users.length,
    librariesRefreshed,
    gamesRefreshed,
    wishlistListingsRefreshed,
    catalogue,
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

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
