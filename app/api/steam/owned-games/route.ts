import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, unauthorizedResponse } from "@/lib/auth";
import { jsonError, readJsonBody } from "@/lib/http";
import { enforceRateLimit } from "@/lib/rate-limit";
import { fetchOwnedSteamGames } from "@/lib/steam";
import { SteamLibraryUnavailableError } from "@/lib/steam-owned-games";
import { processCatalogueQueue } from "@/lib/catalogue";
import { getSteamImportProgress, processNextSteamImportBatch, stageSteamImport } from "@/lib/steam-import-jobs";

export const maxDuration = 60;

const requestSchema = z.object({ restart: z.boolean().optional() }).strict();

export async function GET() {
  try {
    const { user } = await requireSession();
    return NextResponse.json({ progress: await getSteamImportProgress(user.id) });
  } catch (error) {
    if (error instanceof Error && error.message.includes("sign-in")) return unauthorizedResponse();
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
      scheduleInitialEnrichment(result.progress.status, user.id);
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

    await enforceRateLimit({
      bucket: "steam_library_refresh",
      identity: `user:${user.id}`,
      limit: 1,
      windowSeconds: 5 * 60,
      message: "Your Steam library was refreshed recently. To protect your account and Steam, please wait before starting another refresh."
    });

    const importedGames = await fetchOwnedSteamGames(user.steam_id, apiKey);
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
    if (error instanceof Error && error.message.includes("sign-in")) {
      return unauthorizedResponse();
    }
    if (error instanceof SteamLibraryUnavailableError) {
      console.warn(JSON.stringify({
        level: "warning",
        message: "Steam returned no visible owned games",
        route: "/api/steam/owned-games",
        duration_ms: Date.now() - startedAt
      }));
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return jsonError(error, 502);
  }
}

function scheduleInitialEnrichment(status: string, userId: string) {
  if (status !== "complete") return;
  after(async () => {
    const deadlineAt = Date.now() + 45_000;
    // Queue claims are shared, and user imports are registered with elevated
    // priority. A small first pass helps without extending the ownership job.
    await processCatalogueQueue(20, undefined, deadlineAt).catch((error) => {
      console.warn("Initial catalogue enrichment did not complete", { userId, error });
    });
  });
}
