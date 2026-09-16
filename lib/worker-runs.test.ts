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

/** Captures the row the run recorder writes when the task finishes. */
function harness() {
  const updates: Array<Record<string, unknown>> = [];
  const api = {
    insert: () => api,
    select: () => api,
    maybeSingle: async () => ({ data: { id: "00000000-0000-4000-8000-000000000001" }, error: null }),
    update: (values: Record<string, unknown>) => { updates.push(values); return api; },
    eq: async () => ({ error: null })
  };
  const loaded = load("lib/worker-runs.ts", {
    "@/lib/supabase": { getSupabaseAdmin: () => ({ from: () => api }) }
  }) as unknown as {
    withMetadataWorkerRun: <T>(name: string, task: () => Promise<T>) => Promise<T>;
  };
  return { updates, withMetadataWorkerRun: loaded.withMetadataWorkerRun };
}

async function statusOf(result: Record<string, unknown>) {
  const h = harness();
  await h.withMetadataWorkerRun("nightly-metadata", async () => result);
  return h.updates[0]?.status;
}

test("deferred work does not make a run partial", async () => {
  // Every deadline-bounded worker defers whatever it could not reach, and
  // nightly-metadata reads 150 candidates it never intends to finish in one night.
  // Counting that as partial made almost every run partial, so the status column
  // could not tell a bad night from an ordinary one.
  assert.equal(await statusOf({ deferred: 18, examined: 60 }), "succeeded");
  assert.equal(await statusOf({ librariesDeferred: 120, librariesRefreshed: 30 }), "succeeded");
  assert.equal(await statusOf({ skipped: 4, failed: 0 }), "succeeded");
});

test("real failures still make a run partial", async () => {
  assert.equal(await statusOf({ failed: 1 }), "partial");
  assert.equal(await statusOf({ retried: 2 }), "partial");
  assert.equal(await statusOf({ failures: [{ userId: "a", stage: "owned-library", error: "unexpected_error" }] }), "partial");
  // Nested, because several workers report per-batch totals inside the summary.
  assert.equal(await statusOf({ batches: { failed: 3 } }), "partial");
});

test("a thrown task is recorded as failed with its message", async () => {
  const h = harness();
  await assert.rejects(h.withMetadataWorkerRun("steam-tags", async () => {
    throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  }));

  assert.equal(h.updates[0].status, "failed");
  assert.match(String(h.updates[0].error_message), /statement timeout/);
});

test("only finite numbers reach the counts column", async () => {
  const h = harness();
  await h.withMetadataWorkerRun("nightly-metadata", async () => ({
    librariesRefreshed: 30, rateLimited: false, lastAccountId: "abc", ratio: Number.NaN
  }));

  assert.deepEqual(h.updates[0].counts, { librariesRefreshed: 30 });
});
