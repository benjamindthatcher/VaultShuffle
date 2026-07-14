import { NextResponse } from "next/server";
import { getCurrentSession, updateSteamUserProfile } from "@/lib/auth";
import { fetchSteamPlayerSummary } from "@/lib/steam";

export async function GET() {
  const session = await getCurrentSession();
  let user = session?.user ?? null;
  const apiKey = process.env.STEAM_WEB_API_KEY;

  if (user && apiKey && (!user.display_name || !user.avatar_url)) {
    const profile = await fetchSteamPlayerSummary(user.steam_id, apiKey);
    if (profile) user = await updateSteamUserProfile(user.id, profile);
  }

  return NextResponse.json({
    logged_in: Boolean(session),
    user_id: user?.id ?? "",
    steam_id: user?.steam_id ?? "",
    display_name: user?.display_name ?? "",
    avatar_url: user?.avatar_url ?? "",
    has_steam_key: Boolean(process.env.STEAM_WEB_API_KEY)
  });
}
