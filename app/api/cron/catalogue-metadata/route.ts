import { NextResponse } from "next/server";
import { processCatalogueQueue, queueStaleCatalogueMetadata } from "@/lib/catalogue";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Steam's store endpoint is intentionally processed sequentially. Keep a
    // conservative ceiling so one slow upstream response cannot consume the
    // whole function window or overlap the next worker lease.
    const queued = await queueStaleCatalogueMetadata(60);
    const result = await processCatalogueQueue(60);
    return NextResponse.json({ queued, ...result });
  } catch (error) {
    console.error("Shared Steam catalogue refresh failed.", error);
    return NextResponse.json({ error: "Shared Steam catalogue refresh failed." }, { status: 500 });
  }
}
