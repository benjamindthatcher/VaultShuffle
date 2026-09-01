import { getSupabaseAdmin } from "@/lib/supabase";
import { ensureCatalogueGameStubs, recordAutomaticSteamQuarantine } from "@/lib/catalogue";
import { USER_GAMES_TABLE } from "@/lib/game-tables";
import type { Game, GamePayload } from "@/lib/types";

/**
 * Writing family access into the library.
 *
 * Deliberately separate from lib/games.ts. The owned-import path treats Steam's
 * GetOwnedGames response as the whole truth and retires anything missing from
 * it; letting family games through that door would mean every Steam refresh
 * deleted them. Two doors, two sets of rules, one table.
 */

export type FamilyGameInput = {
  steam_appid: string;
  title: string;
  family_owner_steam_id?: string | null;
};

/** The RPC caps a batch at 500. Kept below it so a retry has room. */
const FAMILY_BATCH_SIZE = 400;

/**
 * Give the account access to these games.
 *
 * Catalogue stubs come first for the same reason they do on the owned path: a
 * game nobody has imported before has no catalog_games row, and the RPC refuses
 * a payload it cannot join. The stub also queues the metadata fetch that later
 * decides whether an inferred game was shareable after all.
 */
export async function upsertFamilyGames(userId: string, games: FamilyGameInput[]) {
  const unique = new Map<string, FamilyGameInput>();
  for (const game of games) {
    const appId = String(game.steam_appid ?? "").trim();
    const title = String(game.title ?? "").trim();
    if (!/^[1-9][0-9]*$/.test(appId) || !title) continue;
    unique.set(appId, { ...game, steam_appid: appId, title });
  }

  const rows = [...unique.values()];
  if (!rows.length) return [] as Game[];

  const stubPayloads = rows.map((game) => ({ steam_appid: game.steam_appid, title: game.title })) as GamePayload[];
  await ensureCatalogueGameStubs(stubPayloads);
  await recordAutomaticSteamQuarantine(stubPayloads);

  const supabase = getSupabaseAdmin();
  const saved: Game[] = [];
  for (let index = 0; index < rows.length; index += FAMILY_BATCH_SIZE) {
    const { data, error } = await supabase.rpc("upsert_user_family_games", {
      p_user_id: userId,
      p_games: rows.slice(index, index + FAMILY_BATCH_SIZE).map((game) => ({
        steam_appid: game.steam_appid,
        family_owner_steam_id: game.family_owner_steam_id ?? null
      }))
    });
    if (error) throw error;
    saved.push(...((data ?? []) as Game[]));
  }
  return saved;
}

/**
 * A family game the player has now bought becomes a game they own.
 *
 * This runs after every Steam import rather than inside upsert_user_steam_games,
 * because production has drifted from supabase/migrations and replacing a live
 * function from a file that may not match it is a worse risk than one extra
 * statement. The effect is the same: buying a game you had through the family
 * upgrades the row in place, so its notes, collections, pins and completion
 * history all survive the purchase.
 */
export async function promoteFamilyGamesToOwned(userId: string, steamAppIds: string[]) {
  const appIds = [...new Set(steamAppIds.map(String).filter((id) => /^[1-9][0-9]*$/.test(id)))];
  if (!appIds.length) return 0;

  const supabase = getSupabaseAdmin();
  let promoted = 0;
  for (let index = 0; index < appIds.length; index += 200) {
    const { data, error } = await supabase
      .from(USER_GAMES_TABLE)
      .update({
        access_source: "owned",
        family_owner_steam_id: null,
        family_verified_at: null,
        updated_at: new Date().toISOString()
      })
      .eq("user_id", userId)
      .neq("access_source", "owned")
      .in("catalog_steam_appid", appIds.slice(index, index + 200))
      .select("id");
    if (error) throw error;
    promoted += (data ?? []).length;
  }
  return promoted;
}

/** Every AppID this account can currently reach, owned or shared. */
export async function listAccessibleAppIds(userId: string) {
  const supabase = getSupabaseAdmin();
  const owned = new Set<string>();
  const family = new Set<string>();
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(USER_GAMES_TABLE)
      .select("catalog_steam_appid, access_source, family_owner_steam_id")
      .eq("user_id", userId)
      .eq("ownership", "Owned")
      .order("catalog_steam_appid", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;

    const page = (data ?? []) as Array<{ catalog_steam_appid: number | string; access_source: string | null }>;
    for (const row of page) {
      const appId = String(row.catalog_steam_appid);
      if ((row.access_source ?? "owned") === "owned") owned.add(appId);
      else family.add(appId);
    }
    if (page.length < pageSize) break;
  }

  return { owned, family };
}

/** Drops one member's shared games, keeping anything another member also shares. */
export async function removeFamilyMemberGames(
  userId: string,
  steamId: string,
  retainedAppIds: string[]
) {
  const { data, error } = await getSupabaseAdmin().rpc("remove_user_family_member_games", {
    p_user_id: userId,
    p_steam_id: steamId,
    p_retained_appids: [...new Set(retainedAppIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
  });
  if (error) throw error;
  return Number(data ?? 0);
}
