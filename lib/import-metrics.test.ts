import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
function load(path: string, imports: Record<string, unknown>) {
  const source = readFileSync(new URL(path, root), "utf8");
  const compiled = ts.transpileModule(source, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  } }).outputText;
  const loaded = { exports: {} as Record<string, (...args: never[]) => never> };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (name === "server-only") return {};
      if (name in imports) return imports[name];
      throw new Error(`Unmocked dependency in isolated test: ${name}`);
    }, loaded, loaded.exports
  );
  return loaded.exports;
}

function harness(answer: { data?: unknown; error?: unknown }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const loaded = load("lib/import-metrics.ts", {
    "@/lib/supabase": { getSupabaseAdmin: () => ({
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { data: answer.data ?? null, error: answer.error ?? null };
      }
    }) }
  }) as unknown as { recountImportMetrics: () => Promise<Record<string, number>> };
  return { calls, recountImportMetrics: loaded.recountImportMetrics };
}

const ROW = { games_counted: 24832, sightings_written: 94, catalogue_rows_written: 94 };

test("the recount reports what the database counted", async () => {
  const { calls, recountImportMetrics } = harness({ data: [ROW] });
  const result = await recountImportMetrics();

  assert.deepEqual(result, { gamesCounted: 24832, sightingsWritten: 94, catalogueRowsWritten: 94 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "recount_catalog_import_metrics");
});

test("a scalar row is read the same way as a one-row array", async () => {
  const { recountImportMetrics } = harness({ data: ROW });
  assert.equal((await recountImportMetrics()).gamesCounted, 24832);
});

test("a missing row reads as zeroes rather than NaN", async () => {
  const { recountImportMetrics } = harness({ data: [] });
  assert.deepEqual(await recountImportMetrics(), {
    gamesCounted: 0, sightingsWritten: 0, catalogueRowsWritten: 0
  });
});

test("a database error is raised whole, not swallowed into a zero count", async () => {
  // Silence here would look exactly like a night with nothing to correct. The
  // PostgREST error is thrown as it arrives rather than wrapped: it is a plain
  // object, not an Error, and formatMetadataWorkerError reads message, details,
  // hint and code off it - so 57014, the timeout this whole change exists to
  // stop, has to survive into the run record.
  const { recountImportMetrics } = harness({
    error: { message: "canceling statement due to statement timeout", code: "57014" }
  });

  await assert.rejects(recountImportMetrics(), (thrown: unknown) => {
    const error = thrown as { message?: string; code?: string };
    assert.match(String(error.message), /statement timeout/);
    assert.equal(error.code, "57014");
    return true;
  });
});

test("no count is named so that a healthy run reports itself partial", async () => {
  // withMetadataWorkerRun marks a run `partial` when any key called failed,
  // failures or retried is above zero, so a normal night's counts must not be
  // named any of them. See lib/worker-runs.test.ts for that rule itself.
  const { recountImportMetrics } = harness({ data: [ROW] });
  const result = await recountImportMetrics();
  for (const key of Object.keys(result)) {
    assert.ok(!["failed", "failures", "retried"].includes(key), `${key} would be read as a failure`);
  }
});
