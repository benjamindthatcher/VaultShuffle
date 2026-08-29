import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse, SessionRequiredError } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchSteamAppDetails } from "@/lib/steam";

type RouteContext = {
  params: Promise<{ appid: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { user } = await requireSession();
    await enforceRateLimit({
      bucket: "steam_app_lookup",
      identity: `user:${user.id}`,
      limit: 30,
      windowSeconds: 60 * 60,
      message: "Steam app details have been requested too often. Please wait before requesting more."
    });
    const { appid } = await context.params;
    if (!/^\d{1,10}$/.test(appid)) {
      return NextResponse.json({ error: "Invalid Steam app ID." }, { status: 400 });
    }
    return NextResponse.json({ details: await fetchSteamAppDetails(appid) });
  } catch (error) {
    if (error instanceof SessionRequiredError) return unauthorizedResponse();
    return jsonError(error, 502);
  }
}
