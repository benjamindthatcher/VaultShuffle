import { NextResponse } from "next/server";
import { rebuildGenrePreferences } from "@/lib/genre-preference-worker";
import { withMetadataWorkerRun } from "@/lib/worker-runs";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Unlike the metadata workers this has no external API to pace against and no
    // queue to drain, so it runs as a single full rebuild rather than in batches.
    const result = await withMetadataWorkerRun("genre-preferences", () => rebuildGenrePreferences());
    return NextResponse.json(result);
  } catch (error) {
    console.error("Genre preference rebuild failed.", error);
    return NextResponse.json({ error: "Genre preference rebuild failed." }, { status: 500 });
  }
}
