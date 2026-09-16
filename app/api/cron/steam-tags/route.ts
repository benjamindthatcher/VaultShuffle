import { processSteamTagQueue, queueAllKnownSteamTags } from "@/lib/steam-tags";
import { processStoreTagQueue } from "@/lib/steam-store-tags";
import { sweepEndlessVerdicts } from "@/lib/endless-sync";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildGuestCataloguePool } from "@/lib/guest-catalogue";
import { runNightlyWorker } from "@/lib/nightly-worker";

// Two tag sources, an endless sweep and the guest pool in one request. 120 left no
// room for the store pass, and the pass is worth more than the cap was.
export const maxDuration = 300;

export async function GET(request: Request) {
  return runNightlyWorker(request, "steam-tags", async () => {
    const startedAt = Date.now();
    const queued = await queueAllKnownSteamTags();
    const tags = await processSteamTagQueue(60, startedAt + 70_000);
    // Second source, for the games the first one cannot answer for: SteamSpy lags
    // new releases and has nothing at all for delisted or superseded editions, and
    // 1,642 games somebody owns had no tags from it. After SteamSpy rather than
    // beside it so the two never write the same row at once, and before the sweep
    // below so a game tagged tonight is judged tonight.
    const storeTags = await processStoreTagQueue(180, startedAt + 180_000);
    // Judges every game whose tags or length changed in the last fortnight, by any
    // route - either worker above, a bulk import script, or the HLTB writeback.
    // Before the guest pool is materialised, so a game that flips tonight is
    // already endless when the pool is built from it.
    const endlessSweep = await sweepEndlessVerdicts(getSupabaseAdmin(), { deadlineAt: startedAt + 205_000 });
    // Materialise recommendations after the Steam enrichment stages, using
    // already-stored duration estimates. This does not fetch duration data.
    const guestPoolSize = await buildGuestCataloguePool();
    return { queued, ...tags, storeTags, endlessSweep, guestPoolSize };
  });
}
