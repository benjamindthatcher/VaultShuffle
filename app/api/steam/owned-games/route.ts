import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, SessionRequiredError } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { enforceRateLimit, releaseRateLimit } from "@/lib/rate-limit";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { SteamLibraryUnavailableError } from "@/lib/steam-owned-games";
import { getSteamImportProgress, processNextSteamImportBatch, stageSteamImport } from "@/lib/steam-import-jobs";
import { requestDiagnostics } from "@/lib/diagnostics-server";

export const maxDuration = 60;

const requestSchema = z.object({ restart: z.boolean().optional() }).strict();

export async function GET(request: Request) {
  const diagnostics = requestDiagnostics(request, "steam_import_status");
  try {
    const { user } = await requireSession();
    diagnostics.account(user.id, user.account_type);
    return diagnostics.response(NextResponse.json({ progress: await getSteamImportProgress(user.id) }));
  } catch (error) {
    return jsonError(error, 502, diagnostics);
  }
}

export async function POST(request: Request) {
  const diagnostics = requestDiagnostics(request, "steam_library_import");
  try {
    diagnostics.stage("session_check");
    const { user } = await requireSession();
    diagnostics.account(user.id, user.account_type);
    diagnostics.stage("import_state");
    const body = requestSchema.parse(await readJsonBody(request, 1024));
    const restart = body.restart !== false;

    const existing = await getSteamImportProgress(user.id);
    const resumable = existing.total > existing.imported && (existing.status === "importing" || existing.status === "failed");
    if (!restart || resumable) {
      diagnostics.stage("batch_rate_limit");
      await enforceRateLimit({
        bucket: "steam_import_batch",
        identity: `user:${user.id}`,
        limit: 45,
        windowSeconds: 5 * 60,
        message: "This Steam import is receiving too many batch requests. Please let the current import settle before resuming."
      });
      diagnostics.stage("save_import_batch");
      const result = await processNextSteamImportBatch(user.id);
      // Import registration queues metadata misses. Only the nightly workers
      // enrich catalogue/recent activity; completing an import starts no worker.
      // No per-game or status-poll events. Keep batch completion and errors.
      if (result.progress.status === "complete") diagnostics.event("succeeded", { imported: result.progress.imported, total: result.progress.total, status: 200 });
      return diagnostics.response(NextResponse.json(
        {
          progress: result.progress,
          ...(result.retryAfterSeconds ? { retry_after_seconds: result.retryAfterSeconds } : {})
        },
        { status: result.retryAfterSeconds ? 202 : 200 }
      ));
    }

    diagnostics.stage("steam_library_fetch");
    diagnostics.event("started");
    const apiKey = process.env.STEAM_WEB_API_KEY;

    if (!apiKey) {
      throw Object.assign(new Error("Steam API is not configured."), { code: "configuration_missing" });
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
    diagnostics.stage("stage_import_job");
    const progress = await stageSteamImport(user.id, importedGames);

    diagnostics.event("succeeded", { total: progress.total, status: 200 });
    return diagnostics.response(NextResponse.json({ progress }));
  } catch (error) {
    if (error instanceof SessionRequiredError) {
      return jsonError(error, 401, diagnostics);
    }
    if (error instanceof SteamLibraryUnavailableError) {
      diagnostics.event("failed", { status: 409 }, error);
      // A code, so the browser never has to read the sentence to know what
      // this is. Reading messages to make decisions is what sent this whole
      // condition to a 401 in the first place.
      return diagnostics.response(NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409 }
      ));
    }
    return jsonError(error, 502, diagnostics);
  }
}
