import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";
import {isV2Authority} from "@/lib/database-authority";
import {workerDatabase} from "@/lib/v2/owned-worker";

type WorkerRunStatus = "succeeded" | "partial" | "failed";

/**
 * Records one cron invocation without making the worker dependent on the
 * reporting table. This deliberately remains best-effort so a temporary
 * observability problem cannot prevent metadata from being refreshed.
 */
export async function withMetadataWorkerRun<T>(workerName: string, task: () => Promise<T>): Promise<T> {
  if (isV2Authority()) {
    const started = new Date().toISOString();
    const record = async (summary: Record<string, number | boolean>, failed: boolean) => {
      try {
        const database = await workerDatabase();
        await database.sql.begin(async sql => {
          await sql`select set_config('statement_timeout','5000',true),set_config('lock_timeout','2000',true)`;
          await sql`select ops.record_worker_run(${workerName},${started}::text::timestamptz,${sql.json(summary)},${failed})`;
        });
      } catch { console.warn(`Could not finish ${workerName} worker run record.`); }
    };
    try {
      const result = await task();
      const summary = Object.fromEntries(Object.entries(serialisableRecord(result)).filter(([,value]) =>
        typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))) as Record<string, number | boolean>;
      await record(summary, containsPartialResult(result));
      return result;
    } catch (error) { await record({}, true); throw error; }
  }
  const supabase = getSupabaseAdmin();
  const startedAt = Date.now();
  let runId: string | null = null;

  try {
    const { data, error } = await supabase
      .from("metadata_worker_runs")
      .insert({ worker_name: workerName })
      .select("id")
      .maybeSingle();
    if (error) logRunError(workerName, "start", error);
    runId = typeof data?.id === "string" ? data.id : null;
  } catch (error) {
    logRunError(workerName, "start", error);
  }

  try {
    const result = await task();
    await finishRun(runId, workerName, classifyResult(result), startedAt, result);
    return result;
  } catch (error) {
    await finishRun(runId, workerName, "failed", startedAt, null, error);
    throw error;
  }
}

async function finishRun(
  runId: string | null,
  workerName: string,
  status: WorkerRunStatus,
  startedAt: number,
  result: unknown,
  error?: unknown
) {
  if (!runId) return;

  const summary = serialisableRecord(result);
  const { error: updateError } = await getSupabaseAdmin()
    .from("metadata_worker_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      duration_ms: Math.max(0, Date.now() - startedAt),
      counts: numericCounts(summary),
      summary,
      error_message: formatMetadataWorkerError(error)
    })
    .eq("id", runId);

  if (updateError) logRunError(workerName, "finish", updateError);
}

function classifyResult(result: unknown): WorkerRunStatus {
  const record = serialisableRecord(result);
  return containsPartialResult(record) ? "partial" : "succeeded";
}

function containsPartialResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPartialResult);
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.failures) && record.failures.length > 0) return true;
  for (const [key, count] of Object.entries(record)) {
    // Deliberately not `deferred`, nor anything ending in it. Every deadline-bounded
    // worker here defers whatever it could not reach, which is the design rather than
    // a problem, and treating it as one marked almost every run partial - leaving the
    // status column unable to distinguish a bad night from an ordinary one.
    const partialCount = ["failed", "failures", "retried"].includes(key);
    if (partialCount && typeof count === "number" && count > 0) return true;
  }
  return Object.values(record).some(containsPartialResult);
}

function numericCounts(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
      .map(([key, value]) => [key, value])
  );
}

function serialisableRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function formatMetadataWorkerError(error: unknown, maxLength = 1_000) {
  if (!error) return null;
  if (error instanceof Error) return error.message.slice(0, maxLength);
  if (typeof error === "string") return error.slice(0, maxLength);

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const details = [
      typeof record.message === "string" ? record.message : null,
      typeof record.details === "string" ? record.details : null,
      typeof record.hint === "string" ? `Hint: ${record.hint}` : null,
      typeof record.code === "string" ? `Code: ${record.code}` : null
    ].filter((value): value is string => Boolean(value));

    if (details.length > 0) return details.join(" · ").slice(0, maxLength);

    try {
      return JSON.stringify(record).slice(0, maxLength);
    } catch {
      // Fall through to String() for non-serialisable error-like values.
    }
  }

  return String(error).slice(0, maxLength);
}

function logRunError(workerName: string, stage: "start" | "finish", error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  // Expected during a rolling deployment where code and migration can briefly
  // arrive in either order. All other errors stay visible in Vercel logs.
  if (code === "42P01" || code === "PGRST205") return;
  console.warn(`Could not ${stage} ${workerName} worker run record.`, error);
}
