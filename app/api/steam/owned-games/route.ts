import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, unauthorizedResponse, SessionRequiredError } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { enforceRateLimit, releaseRateLimit } from "@/lib/rate-limit";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { SteamLibraryUnavailableError } from "@/lib/steam-owned-games";
import { getSteamImportProgress, processNextSteamImportBatch, stageSteamImport } from "@/lib/steam-import-jobs";

export const maxDuration = 60;

const requestSchema = z.object({ restart: z.boolean().optional() }).strict();

export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json({ progress: await getSteamImportProgress(user.id) });
  } catch (error) {
    if (error instanceof SessionRequiredError) return unauthorizedResponse();
    return jsonError(error, 502);
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const { user } = await requireSession();
    const body = requestSchema.parse(await readJsonBody(request, 1024));
    const restart = body.restart !== false;

    const existing = await getSteamImportProgress(user.id);
    const resumable = existing.total > existing.imported && (existing.status === "importing" || existing.status === "failed");
    if (!restart || resumable) {
      await enforceRateLimit({
        bucket: "steam_import_batch",
        identity: `user:${user.id}`,
        limit: 45,
        windowSeconds: 5 * 60,
        message: "This Steam import is receiving too many batch requests. Please let the current import settle before resuming."
      });
      const result = await processNextSteamImportBatch(user.id);
      // Metadata misses stay queued for the bounded nightly workers.
      return NextResponse.json(
        {
          progress: result.progress,
          ...(result.retryAfterSeconds ? { retry_after_seconds: result.retryAfterSeconds } : {})
        },
        { status: result.retryAfterSeconds ? 202 : 200 }
      );
    }

    console.log(JSON.stringify({ level: "info", message: "Steam library staging started", route: "/api/steam/owned-games" }));
    const apiKey = process.env.STEAM_WEB_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "Steam library sync is temporarily unavailable. Please try again later." },
        { status: 400 }
      );
    }

    // Importing is not refreshing. The one-per-five-minutes rule exists to stop
    // someone re-reading a library they already have; charging a first import
    // against it locked new accounts out of the product on the screen where they
    // had just signed in. A first import never touches that bucket, so a
    // cooldown can only ever follow a library that already exists.
    //
    // It still gets a bucket of its own, several times looser and never phrased
    // as a refresh, so that a retry loop cannot sit on Steam's API unattended.
    const firstImport = existing.status === "idle" && existing.total === 0 && !existing.completedAt;
    const refreshLimit = firstImport
      ? { bucket: "steam_first_import", identity: `user:${user.id}` }
      : { bucket: "steam_library_refresh", identity: `user:${user.id}` };
    await enforceRateLimit({
      ...refreshLimit,
      limit: firstImport ? 10 : 1,
      windowSeconds: 5 * 60,
      message: firstImport
        ? "That import has been started several times over. Give the current one a moment to finish."
        : "Your Steam library was refreshed recently. To protect your account and Steam, please wait before starting another refresh."
    });

    let importedGames;
    try {
      importedGames = await fetchOwnedSteamGames(user.steam_id, apiKey);
    } catch (error) {
      // The reservation paid for a library we never received. Charging for it
      // would leave the next attempt refused for a failure that was ours.
      await releaseRateLimit(refreshLimit);
      throw error;
    }
    const progress = await stageSteamImport(user.id, importedGames);

    console.log(JSON.stringify({
      level: "info",
      message: "Steam library staged for bounded import",
      route: "/api/steam/owned-games",
      total: progress.total,
      duration_ms: Date.now() - startedAt
    }));
    return NextResponse.json({ progress });
  } catch (error) {
    if (error instanceof SessionRequiredError) {
      return unauthorizedResponse();
    }
    if (error instanceof SteamLibraryUnavailableError) {
      console.warn(JSON.stringify({
        level: "warning",
        message: "Steam returned no visible owned games",
        route: "/api/steam/owned-games",
        duration_ms: Date.now() - startedAt
      }));
      // A code, so the browser never has to read the sentence to know what
      // this is. Reading messages to make decisions is what sent this whole
      // condition to a 401 in the first place.
      return NextResponse.json(
        { error: error.message, code: "steam_library_private" },
        { status: 409 }
      );
    }
    return jsonError(error, 502);
  }
}
