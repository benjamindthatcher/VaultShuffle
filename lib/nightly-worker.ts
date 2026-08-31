import "server-only";

import { enforceRateLimit, RateLimitExceededError } from "@/lib/rate-limit";
import { withMetadataWorkerRun } from "@/lib/worker-runs";
import { requestDiagnostics } from "@/lib/diagnostics-server";

type NightlyWorker = "nightly-metadata" | "catalogue-metadata" | "steam-tags" | "genre-preferences";

/** Authentication plus an atomic, shared daily budget. No in-memory lock or new table. */
export async function runNightlyWorker<T>(request: Request, name: NightlyWorker, task: () => Promise<T>) {
  const response = (body: unknown, status = 200) => Response.json(body, {
    status, headers: { "Cache-Control": "private, no-store" },
  });
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return response({ error: "Unauthorized" }, 401);
  }
  // Preview URLs must never consume production queues, even if an operator
  // accidentally supplies the production cron secret.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return response({ skipped: true, reason: "production_only" });
  }
  const diagnostics = requestDiagnostics(request, "nightly_worker");
  diagnostics.stage(name);
  try {
    await enforceRateLimit({
      bucket: "nightly_worker_daily",
      identity: `${name}:${new Date().toISOString().slice(0, 10)}`,
      limit: 1,
      windowSeconds: 86_400,
    });
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return diagnostics.response(response({ skipped: true, reason: "daily_budget_used", worker: name }));
    }
    // Fail closed: a coordination outage is not permission to run unbounded work.
    diagnostics.event("failed", { status: 503 }, error);
    return diagnostics.response(response({ error: "Nightly worker could not reserve its daily run." }, 503));
  }
  diagnostics.event("started");
  try {
    const result = await withMetadataWorkerRun(name, task);
    const counts = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
    const partial = Number(counts.failed ?? 0) > 0 || Number(counts.deferred ?? 0) > 0
      || Number(counts.librariesDeferred ?? 0) > 0 || counts.rateLimited === true;
    diagnostics.event(partial ? "warning" : "succeeded", { ...counts, status: 200 });
    return diagnostics.response(response(result));
  } catch (error) {
    // Deliberately retain the daily reservation after failure. Repeated manual
    // retries/backfills must not multiply Vercel spend. Resume next night.
    diagnostics.event("failed", { status: 500 }, error);
    return diagnostics.response(response({ error: "Nightly worker failed. See the request reference in server logs." }, 500));
  }
}
