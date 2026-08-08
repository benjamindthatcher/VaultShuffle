import { NextResponse } from "next/server";
import { processSteamTagQueue, queueAllKnownSteamTags } from "@/lib/steam-tags";
import { withMetadataWorkerRun } from "@/lib/worker-runs";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await withMetadataWorkerRun("steam-tags", async () => {
      const queued = await queueAllKnownSteamTags();
      return { queued, ...await processSteamTagQueue(220, Date.now() + 275_000) };
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Steam community tag refresh failed.", error);
    return NextResponse.json({ error: "Steam community tag refresh failed." }, { status: 500 });
  }
}
