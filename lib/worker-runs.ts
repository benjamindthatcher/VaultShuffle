import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase";

type WorkerRunStatus = "succeeded" | "partial" | "failed";

/**
 * Records one cron invocation without making the worker dependent on the
 * reporting table. This deliberately remains best-effort so a temporary
 * observability problem cannot prevent metadata from being refreshed.
 */
export async function withMetadataWorkerRun<T>(workerName: string, task: () => Promise<T>): Promise<T> {
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
      error_message: errorMessage(error)
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
  for (const key of ["failed", "failures", "retried", "deferred"]) {
    if (typeof record[key] === "number" && record[key] > 0) return true;
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

function errorMessage(error: unknown) {
  if (!error) return null;
  return error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000);
}

function logRunError(workerName: string, stage: "start" | "finish", error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  // Expected during a rolling deployment where code and migration can briefly
  // arrive in either order. All other errors stay visible in Vercel logs.
  if (code === "42P01" || code === "PGRST205") return;
  console.warn(`Could not ${stage} ${workerName} worker run record.`, error);
}
