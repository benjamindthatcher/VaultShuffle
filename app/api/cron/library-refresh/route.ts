import { NextResponse } from "next/server";
import { refreshStaleLibraries } from "@/lib/library-refresh";
import { withMetadataWorkerRun } from "@/lib/worker-runs";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await withMetadataWorkerRun("library-refresh", () => refreshStaleLibraries(5)));
  } catch (error) {
    console.error("Steam library refresh failed.", error);
    return NextResponse.json({ error: "Steam library refresh failed." }, { status: 500 });
  }
}
