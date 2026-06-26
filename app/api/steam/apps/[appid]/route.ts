import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { fetchSteamAppDetails } from "@/lib/steam";

type RouteContext = {
  params: Promise<{ appid: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { appid } = await context.params;
    return NextResponse.json({ details: await fetchSteamAppDetails(appid) });
  } catch (error) {
    return jsonError(error, 502);
  }
}
