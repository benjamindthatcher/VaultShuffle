import { getCurrentSession, updateSteamUserProfile } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchSteamPlayerSummary } from "@/lib/steam";
import type { SessionPayload } from "@/lib/types";

export async function getSessionPayload(): Promise<SessionPayload> {
  const session = await getCurrentSession();
  let user = session?.user ?? null;
  const apiKey = process.env.STEAM_WEB_API_KEY;

  // What Steam is willing to share decides which features can honestly work, so
  // the app needs it at session level rather than only after an import.
  type SteamVisibilityRow = {
    steam_playtime_visible: boolean | null;
  };
  const initialUser = user;
  const [updatedUser, visibility] = await Promise.all([
    initialUser && apiKey && (!initialUser.display_name || !initialUser.avatar_url)
      ? fetchSteamPlayerSummary(initialUser.steam_id, apiKey).then((profile) => (
          profile
            ? updateSteamUserProfile(initialUser.id, initialUser.account_type, profile)
            : initialUser
        ))
      : Promise.resolve(initialUser),
    initialUser
      ? getSupabaseAdmin()
          .from("app_accounts")
          .select("steam_playtime_visible")
          .eq("id", initialUser.id)
          .maybeSingle()
          .then(({ data }) => (data as SteamVisibilityRow | null) ?? null)
      : Promise.resolve(null),
  ]);
  user = updatedUser;

  return {
    logged_in: Boolean(session),
    account_type: user?.account_type ?? "guest",
    identity_verified: user?.account_type === "steam",
    steam_playtime_visible: visibility?.steam_playtime_visible ?? null,
    user_id: user?.id ?? "",
    steam_id: user?.steam_id ?? "",
    display_name: user?.display_name ?? "",
    steam_display_name: user?.steam_display_name ?? user?.display_name ?? "",
    avatar_url: user?.avatar_url ?? "",
    has_steam_key: Boolean(apiKey)
  };
}
