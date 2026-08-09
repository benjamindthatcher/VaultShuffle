import { NextResponse } from "next/server";
import { processCatalogueQueue, queueStaleCatalogueMetadata } from "@/lib/catalogue";
import { withMetadataWorkerRun } from "@/lib/worker-runs";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await withMetadataWorkerRun("catalogue-metadata", async () => {
      const deadlineAt = Date.now() + 275_000;
      const queued = await queueStaleCatalogueMetadata(250);
      const totals = { claimed: 0, processed: 0, accepted: 0, rejected: 0, failed: 0, deferred: 0, rateLimited: false };
      let batches = 0;

      // Steam's store endpoint remains sequential, but the cron now claims
      // another batch whenever time remains instead of stopping after 60.
      while (Date.now() + 20_000 < deadlineAt) {
        const batch = await processCatalogueQueue(50, undefined, deadlineAt);
        batches += 1;
        totals.claimed += batch.claimed;
        totals.processed += batch.processed;
        totals.accepted += batch.accepted;
        totals.rejected += batch.rejected;
        totals.failed += batch.failed;
        totals.deferred += batch.deferred;
        totals.rateLimited ||= batch.rateLimited;
        if (!batch.claimed || !batch.processed || batch.deferred || batch.rateLimited) break;
      }

      return { queued, batches, ...totals };
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Shared Steam catalogue refresh failed.", error);
    return NextResponse.json({ error: "Shared Steam catalogue refresh failed." }, { status: 500 });
  }
}
