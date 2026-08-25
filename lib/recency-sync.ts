import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchRecentlyPlayedSteamAppIds } from "@/lib/steam";

/**
 * Fold Steam's recently-played list into a user's recency evidence.
 *
 * Strictly secondary to the library import: an account whose recently-played
 * list is private, empty, or momentarily unavailable must still import its
 * library and use the product. Every failure path here is swallowed and
 * reported, never thrown.
 *
 * Returns how many games the window actually taught us something new about,
 * which is usually far fewer than Steam returned - most of them we already knew
 * about from watching playtime rise.
 */
export async function syncSteamRecentWindow(
  userId: string,
  steamId: string,
  apiKey: string
): Promise<{ seen: number; applied: number; error: string | null }> {
  let appIds: number[] = [];
  try {
    appIds = await fetchRecentlyPlayedSteamAppIds(steamId, apiKey);
  } catch (error) {
    return { seen: 0, applied: 0, error: messageFor(error) };
  }
  if (!appIds.length) return { seen: 0, applied: 0, error: null };

  try {
    const { data, error } = await getSupabaseAdmin().rpc("apply_steam_recent_window", {
      p_user_id: userId,
      p_appids: appIds
    });
    if (error) throw error;
    return { seen: appIds.length, applied: Number(data ?? 0), error: null };
  } catch (error) {
    return { seen: appIds.length, applied: 0, error: messageFor(error) };
  }
}

function messageFor(error: unknown) {
  if (error instanceof Error) return error.message;
  // Supabase reports failures as plain objects, so instanceof is false and the
  // real message would otherwise be replaced with something useless.
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "Could not read Steam's recently-played list.";
}
