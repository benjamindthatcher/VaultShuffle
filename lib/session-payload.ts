import { getCurrentSession, updateSteamUserProfile } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchSteamPlayerSummary } from "@/lib/steam";
import type { SessionPayload } from "@/lib/types";

export async function getSessionPayload(): Promise<SessionPayload> {
  const session = await getCurrentSession();
  let user = session?.user ?? null;
  const apiKey = process.env.STEAM_WEB_API_KEY;

  if (user && apiKey && (!user.display_name || !user.avatar_url)) {
    const profile = await fetchSteamPlayerSummary(user.steam_id, apiKey);
    if (profile) user = await updateSteamUserProfile(user.id, profile);
  }

  // What Steam is willing to share decides which features can honestly work, so
  // the app needs it at session level rather than only after an import.
  type SteamVisibilityRow = {
    steam_playtime_visible: boolean | null;
    steam_last_played_visible: boolean | null;
  };
  let visibility: SteamVisibilityRow | null = null;
  if (user) {
    const { data } = await getSupabaseAdmin()
      .from("app_users")
      .select("steam_playtime_visible, steam_last_played_visible")
      .eq("id", user.id)
      .maybeSingle();
    visibility = (data as SteamVisibilityRow | null) ?? null;
  }

  return {
    logged_in: Boolean(session),
    steam_playtime_visible: visibility?.steam_playtime_visible ?? null,
    steam_last_played_visible: visibility?.steam_last_played_visible ?? null,
    user_id: user?.id ?? "",
    steam_id: user?.steam_id ?? "",
    display_name: user?.display_name ?? "",
    avatar_url: user?.avatar_url ?? "",
    has_steam_key: Boolean(apiKey)
  };
}
