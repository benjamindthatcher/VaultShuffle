import { NextResponse } from "next/server";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { fetchSteamAppDetails } from "@/lib/steam";

type RouteContext = {
  params: Promise<{ appid: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    await requireSession();
    const { appid } = await context.params;
    if (!/^\d{1,10}$/.test(appid)) {
      return NextResponse.json({ error: "Invalid Steam app ID." }, { status: 400 });
    }
    return NextResponse.json({ details: await fetchSteamAppDetails(appid) });
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) return unauthorizedResponse();
    return jsonError(error, 502);
  }
}
