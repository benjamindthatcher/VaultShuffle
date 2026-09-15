import { processSteamTagQueue, queueAllKnownSteamTags } from "@/lib/steam-tags";
import { sweepEndlessVerdicts } from "@/lib/endless-sync";
import { getSupabaseAdmin } from "@/lib/supabase";
import { buildGuestCataloguePool } from "@/lib/guest-catalogue";
import { runNightlyWorker } from "@/lib/nightly-worker";

export const maxDuration = 120;

export async function GET(request: Request) {
  return runNightlyWorker(request, "steam-tags", async () => {
    const deadlineAt = Date.now() + 70_000;
    const queued = await queueAllKnownSteamTags();
    const tags = await processSteamTagQueue(60, deadlineAt);
    // Judges every game whose tags or length changed in the last fortnight, by any
    // route - this worker, a bulk import script, or the HLTB writeback. Before the
    // guest pool is materialised, so a game that flips tonight is already endless
    // when the pool is built from it. Allowed until 95s in, which leaves the pool
    // the rest of the 120s budget.
    const endlessSweep = await sweepEndlessVerdicts(getSupabaseAdmin(), { deadlineAt: deadlineAt + 25_000 });
    // Materialise recommendations after the Steam enrichment stages, using
    // already-stored duration estimates. This does not fetch duration data.
    const guestPoolSize = await buildGuestCataloguePool();
    return { queued, ...tags, endlessSweep, guestPoolSize };
  });
}
