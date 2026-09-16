import { countPendingCatalogueJobs, processCatalogueQueue, queueStaleCatalogueMetadata } from "@/lib/catalogue";
import { runNightlyWorker } from "@/lib/nightly-worker";

export const maxDuration = 120;

export async function GET(request: Request) {
  return runNightlyWorker(request, "catalogue-metadata", async () => {
      // The route allows 120s; 105 leaves room for the run record and the response.
      const deadlineAt = Date.now() + 105_000;

      // Refreshing rows that already have metadata must not compete with games a
      // real user is currently staring at an empty card for. A large library can
      // queue well over a thousand first-time fetches, and topping the queue up
      // with stale refreshes every run kept it permanently ahead of the drain.
      const backlog = await countPendingCatalogueJobs();
      const queued = backlog > 400 ? 0 : await queueStaleCatalogueMetadata(40);
      const totals = { claimed: 0, processed: 0, accepted: 0, rejected: 0, failed: 0, deferred: 0, rateLimited: false };
      let batches = 0;

      // A game can require Store metadata plus Deck compatibility. Keep an
      // explicit game cap as well as a deadline; bulk backfills run locally.
      //
      // 40 was leaving most of the night unused: the cap was reached in a single
      // batch after 30s of a 90s budget, while 2,732 games sat pending, which is
      // 68 nights of draining. Store requests are paced 650ms apart
      // (STEAM_STORE_MIN_INTERVAL_MS), so 100 is about 65s of calls - bounded by
      // the deadline long before the cap if a game needs two of them.
      const STEAM_LOOKUPS_PER_RUN = 100;

      while (Date.now() + 12_000 < deadlineAt && totals.processed < STEAM_LOOKUPS_PER_RUN) {
        const remaining = STEAM_LOOKUPS_PER_RUN - totals.processed;
        const batch = await processCatalogueQueue(Math.min(50, remaining), undefined, deadlineAt);
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

      return { backlog, queued, batches, ...totals };
  });
}
