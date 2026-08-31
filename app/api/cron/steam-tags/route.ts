import { processSteamTagQueue, queueAllKnownSteamTags } from "@/lib/steam-tags";
import { buildGuestCataloguePool } from "@/lib/guest-catalogue";
import { runNightlyWorker } from "@/lib/nightly-worker";

export const maxDuration = 120;

export async function GET(request: Request) {
  return runNightlyWorker(request, "steam-tags", async () => {
    const deadlineAt = Date.now() + 70_000;
    const queued = await queueAllKnownSteamTags();
    const tags = await processSteamTagQueue(60, deadlineAt);
    // Materialise recommendations after the Steam enrichment stages, using
    // already-stored duration estimates. This does not fetch duration data.
    const guestPoolSize = await buildGuestCataloguePool();
    return { queued, ...tags, guestPoolSize };
  });
}
