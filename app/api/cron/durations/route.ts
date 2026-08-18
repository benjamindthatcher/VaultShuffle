import { NextResponse } from "next/server";
import { processDurationQueue } from "@/lib/duration-worker";
import { withMetadataWorkerRun } from "@/lib/worker-runs";

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await withMetadataWorkerRun("durations", async () => {
      const deadlineAt = Date.now() + 275_000;
      const totals = { claimed: 0, matched: 0, noDuration: 0, notFound: 0, ambiguous: 0, retried: 0, failed: 0, deferred: 0 };
      let batches = 0;

      // The one-shot endpoint handles eight games per call, which is fine when
      // something else is driving it in a loop and useless on a daily schedule.
      // Duration data was the only pipeline with no cron at all, so it only ever
      // advanced when someone poked it by hand.
      while (Date.now() + 25_000 < deadlineAt) {
        const batch = await processDurationQueue(8);
        batches += 1;
        totals.claimed += batch.claimed;
        totals.matched += batch.matched;
        totals.noDuration += batch.noDuration;
        totals.notFound += batch.notFound;
        totals.ambiguous += batch.ambiguous;
        totals.retried += batch.retried;
        totals.failed += batch.failed;
        totals.deferred += batch.deferred;
        if (!batch.claimed || batch.deferred) break;
      }

      return { batches, ...totals };
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Duration refresh failed.", error);
    return NextResponse.json({ error: "Duration refresh failed." }, { status: 500 });
  }
}
