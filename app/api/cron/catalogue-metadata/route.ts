import { countPendingCatalogueJobs, processCatalogueQueue, queueStaleCatalogueMetadata } from "@/lib/catalogue";
import { runNightlyWorker } from "@/lib/nightly-worker";

export const maxDuration = 120;

export async function GET(request: Request) {
  return runNightlyWorker(request, "catalogue-metadata", async () => {
      const deadlineAt = Date.now() + 90_000;

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
      const STEAM_LOOKUPS_PER_RUN = 40;

      while (Date.now() + 20_000 < deadlineAt && totals.processed < STEAM_LOOKUPS_PER_RUN) {
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
