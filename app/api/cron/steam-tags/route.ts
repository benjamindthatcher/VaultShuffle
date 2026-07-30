import { NextResponse } from "next/server";
import { processSteamTagQueue, queueAllKnownSteamTags } from "@/lib/steam-tags";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const queued = await queueAllKnownSteamTags();
    const result = await processSteamTagQueue(220, Date.now() + 275_000);
    return NextResponse.json({ queued, ...result });
  } catch (error) {
    console.error("Steam community tag refresh failed.", error);
    return NextResponse.json({ error: "Steam community tag refresh failed." }, { status: 500 });
  }
}
