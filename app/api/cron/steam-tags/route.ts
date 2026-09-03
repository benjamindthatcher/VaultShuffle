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
    // Materialise recommendations after the Steam enrichment stages, using
    // already-stored duration estimates. This does not fetch duration data.
    // Catches the games HowLongToBeat resolved since the last run. The tag write
    // hook cannot see those: their tags did not change, only their length did.
    // Before the guest pool is materialised, so a game that flips to endless
    // tonight is already endless when the pool is built from it.
    const endlessSweep = await sweepEndlessVerdicts(getSupabaseAdmin());
    const guestPoolSize = await buildGuestCataloguePool();
    return { queued, ...tags, endlessSweep, guestPoolSize };
  });
}
