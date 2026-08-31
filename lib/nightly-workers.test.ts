import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import * as diagnostics from "./diagnostics.ts";
import * as steamErrors from "./steam-api-error.ts";

const root = new URL("../", import.meta.url);
function load(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(path, root), "utf8");
  const compiled = ts.transpileModule(source, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const sourceModule = { exports: {} as Record<string, (...args: any[]) => any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  new Function("require", "module", "exports", ...Object.keys(globals), compiled)(
    (name: string) => {
      if (name === "server-only") return {};
      if (name in imports) return imports[name];
      throw new Error(`Unmocked dependency in isolated worker test: ${name}`);
    }, sourceModule, sourceModule.exports, ...Object.values(globals),
  );
  return sourceModule.exports;
}

test("Vercel retains the three daily Steam jobs and unchanged learning schedule, with no hosted duration entry points", () => {
  const { crons } = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
  assert.deepEqual(crons, [
    { path: "/api/cron/nightly-metadata", schedule: "0 3 * * *" },
    { path: "/api/cron/catalogue-metadata", schedule: "0 4 * * *" },
    { path: "/api/cron/steam-tags", schedule: "0 5 * * *" },
    { path: "/api/cron/genre-preferences", schedule: "0 6 * * *" },
  ]);
  const steamPaths = ["nightly-metadata", "catalogue-metadata", "steam-tags"].map((name) => `/api/cron/${name}`);
  for (const path of steamPaths) assert.ok(crons.some((cron: { path: string }) => cron.path === path));
  for (const cron of crons) {
    assert.ok([...steamPaths, "/api/cron/genre-preferences"].includes(cron.path));
    assert.match(cron.schedule, /^0 \d{1,2} \* \* \*$/);
    assert.ok(existsSync(new URL(`app${cron.path}/route.ts`, root)));
  }
  for (const path of ["app/api/cron/durations/route.ts", "app/api/durations/process/route.ts", "app/api/catalogue/process/route.ts"]) {
    assert.equal(existsSync(new URL(path, root)), false);
  }
  for (const path of steamPaths) {
    assert.match(readFileSync(new URL(`app${path}/route.ts`, root), "utf8"), /maxDuration = 120/);
  }
  // Prevent a future route from silently importing the retired worker again.
  function scan(directory: URL) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = new URL(entry.name, directory);
      if (entry.isDirectory()) scan(new URL(`${entry.name}/`, directory));
      else if (/\.tsx?$/.test(entry.name)) {
        assert.doesNotMatch(readFileSync(path, "utf8"), /processDurationQueue|duration-worker|igdb-duration-provider/);
      }
    }
  }
  scan(new URL("app/", root));
  assert.doesNotMatch(readFileSync(new URL("lib/nightly-metadata.ts", root), "utf8"), /processDurationQueue|duration-worker/);
  assert.doesNotMatch(readFileSync(new URL("app/api/steam/owned-games/route.ts", root), "utf8"), /processCatalogueQueue|scheduleInitialEnrichment|syncSteamRecentWindow/);
  assert.doesNotMatch(readFileSync(new URL("scripts/igdb/admin.ts", root), "utf8"), /functions\.invoke/);
});

function cronHarness(options: { env?: string; secret?: string; reservationFails?: boolean } = {}) {
  const reservations = new Set<string>();
  const outcomes: string[] = [];
  let runs = 0;
  class RateLimitExceededError extends Error {}
  const worker = load("lib/nightly-worker.ts", {
    "@/lib/rate-limit": { RateLimitExceededError, enforceRateLimit: async (input: { identity: string; limit: number; windowSeconds: number }) => {
      assert.equal(input.limit, 1); assert.equal(input.windowSeconds, 86400);
      if (options.reservationFails) throw new Error("Database unavailable");
      if (reservations.has(input.identity)) throw new RateLimitExceededError();
      reservations.add(input.identity);
    } },
    "@/lib/worker-runs": { withMetadataWorkerRun: async (_name: string, task: () => Promise<unknown>) => { runs++; return task(); } },
    "@/lib/diagnostics-server": { requestDiagnostics: () => ({ stage: () => undefined, event: (outcome: string) => outcomes.push(outcome), response: (response: Response) => response }) },
  }, { process: { env: { CRON_SECRET: options.secret ?? "test-secret", VERCEL_ENV: options.env ?? "production" } } });
  const request = (token = "test-secret") => new Request("https://example.test/api/cron/steam-tags", { headers: { authorization: `Bearer ${token}` } });
  return { runNightlyWorker: worker.runNightlyWorker, request, outcomes, get runs() { return runs; } };
}

test("cron authentication and preview protection run before any worker reservation or work", async () => {
  for (const options of [{ secret: "" }, {}]) {
    const h = cronHarness(options);
    const response = await h.runNightlyWorker(h.request("wrong"), "steam-tags", async () => assert.fail("must not run"));
    assert.equal(response.status, 401); assert.equal(h.runs, 0);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
  const preview = cronHarness({ env: "preview" });
  assert.equal((await (await preview.runNightlyWorker(preview.request(), "steam-tags", async () => assert.fail())).json()).reason, "production_only");
  assert.equal(preview.runs, 0);
});

test("concurrent and repeated cron invocations share one daily budget; failures do not refund it", async () => {
  const h = cronHarness();
  const responses = await Promise.all(Array.from({ length: 5 }, () => h.runNightlyWorker(h.request(), "steam-tags", async () => ({ updated: 1 }))));
  assert.equal(h.runs, 1);
  const payloads = await Promise.all(responses.map((response: Response) => response.json()));
  assert.equal(payloads.filter((body: { reason?: string }) => body.reason === "daily_budget_used").length, 4);
  const failed = cronHarness();
  assert.equal((await failed.runNightlyWorker(failed.request(), "steam-tags", async () => { throw new Error("upstream failed"); })).status, 500);
  assert.equal((await (await failed.runNightlyWorker(failed.request(), "steam-tags", async () => assert.fail())).json()).reason, "daily_budget_used");
  assert.equal(failed.runs, 1);
});

test("coordination failures stop work, and partial results produce a diagnostic warning", async () => {
  const failed = cronHarness({ reservationFails: true });
  assert.equal((await failed.runNightlyWorker(failed.request(), "steam-tags", async () => assert.fail())).status, 503);
  assert.equal(failed.runs, 0);
  const h = cronHarness();
  await h.runNightlyWorker(h.request(), "steam-tags", async () => ({ failed: 0, deferred: 12, rateLimited: true }));
  assert.deepEqual(h.outcomes, ["started", "warning"]);
});

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function libraryHarness(options: { cursor?: string; size?: number; limited?: boolean } = {}) {
  const accounts = Array.from({ length: options.size ?? 6 }, (_, index) => ({ id: id(index + 1), steam_id: `steam-${Math.floor(index / 2)}` }));
  const calls = { owned: 0, recent: 0, saved: [] as string[], limits: [] as number[] };
  function from(table: string) {
    let minimum: string | undefined; let maximum: string | undefined; let limit = Infinity;
    const query = {
      select: () => query, eq: () => query, in: () => query, order: () => query, not: () => query,
      gt: (_key: string, value: string) => { minimum = value; return query; },
      lte: (_key: string, value: string) => { maximum = value; return query; },
      limit: (value: number) => { limit = value; calls.limits.push(value); return query; },
      maybeSingle: async () => ({ data: { summary: { lastAccountId: options.cursor } }, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: accounts.filter((row, index) =>
        (table === "app_users" ? index % 2 === 0 : index % 2 === 1) && (!minimum || row.id > minimum) && (!maximum || row.id <= maximum)).slice(0, limit), error: null }),
    };
    return query;
  }
  const loaded = load("lib/nightly-metadata.ts", {
    "@/lib/supabase": { getSupabaseAdmin: () => ({ from }) },
    "@/lib/diagnostics": diagnostics, "@/lib/steam-api-error": steamErrors,
    "@/lib/steam": {
      fetchOwnedSteamGames: async () => { calls.owned++; if (options.limited) throw new steamErrors.SteamApiError("owned_games", "steam_rate_limited", 429, 60); return [{ steam_appid: "10" }]; },
      fetchRecentlyPlayedSteamAppIds: async () => { calls.recent++; return [10]; },
    },
    "@/lib/catalogue": { recordImportedSteamAppIds: async () => undefined },
    "@/lib/games": { recordSteamVisibility: async () => undefined, upsertSteamGames: async (accountId: string) => { calls.saved.push(accountId); return [1]; } },
    "@/lib/steam-owned-games": { steamVisibilityFromGames: () => ({}) },
    "@/lib/recency-sync": { syncSteamRecentWindow: async (_id: string, _steam: string, _key: string, result: Promise<number[]>) => { await result; return { error: null }; } },
    "@/lib/playtime-snapshots": { capturePlaytimeSnapshot: async () => undefined },
  }, { process: { env: { STEAM_WEB_API_KEY: "test-only" } } });
  return { refreshNightlyMetadata: loaded.refreshNightlyMetadata, calls };
}

test("nightly libraries share both Steam reads across manual/verified identities and resume around the cursor", async () => {
  const h = libraryHarness({ cursor: id(4) });
  const result = await h.refreshNightlyMetadata();
  assert.deepEqual(h.calls.saved, [id(5), id(6), id(1), id(2), id(3), id(4)]);
  assert.equal(result.lastAccountId, id(4)); assert.equal(result.librariesRefreshed, 6);
  assert.equal(h.calls.owned, 3); assert.equal(h.calls.recent, 3);
  assert.ok(h.calls.limits.every((value) => value <= 150));
  assert.equal("durations" in result, false);
});

test("nightly library population is bounded and a Steam 429 prevents starting the next batch", async () => {
  const h = libraryHarness({ size: 400, cursor: id(200) });
  const result = await h.refreshNightlyMetadata();
  assert.equal(result.librariesAttempted, 150); assert.equal(result.lastAccountId, id(350));
  const limited = libraryHarness({ size: 40, limited: true });
  const cooldown = await limited.refreshNightlyMetadata();
  assert.equal(cooldown.rateLimited, true); assert.equal(cooldown.librariesAttempted, 3);
  assert.equal(cooldown.librariesDeferred, 37); assert.equal(limited.calls.owned, 2);
  assert.equal(limited.calls.recent, 0); assert.equal(cooldown.lastAccountId, id(3));
});

function tagHarness(response: Response, deadlineExpired = false) {
  const writes: Array<{ values: Record<string, unknown>; ids: number[] }> = [];
  let requests = 0;
  const rows = [10, 20, 30].map((steam_appid) => ({ steam_appid, tags_failure_count: 0 }));
  const loaded = load("lib/steam-tags.ts", {
    "@/lib/steam-api-error": steamErrors,
    "@/lib/supabase": { getSupabaseAdmin: () => ({
      rpc: async () => ({ data: rows, error: null }),
      from: () => {
        let values: Record<string, unknown> | undefined; let ids: number[] = [];
        const query = { update: (input: Record<string, unknown>) => { values = input; return query; },
          select: () => query, eq: (_key: string, value: unknown) => { if (typeof value === "number") ids = [value]; return query; },
          in: (_key: string, value: number[]) => { ids = value; return query; },
          then: (resolve: (value: unknown) => unknown) => { if (values) writes.push({ values, ids }); return resolve({ error: null, count: 3 }); },
        }; return query;
      },
    }) },
  }, { fetch: async () => { requests++; return response.clone(); } });
  return { writes, get requests() { return requests; }, run: () => loaded.processSteamTagQueue(deadlineExpired ? 3 : 1, deadlineExpired ? Date.now() : Date.now() + 70_000) };
}

test("tag cooldown and time budgets release untouched claims together without touching durations", async () => {
  const h = tagHarness(new Response("rate limited", { status: 429, headers: { "Retry-After": "180" } }));
  const result = await h.run();
  assert.equal(h.requests, 1); assert.equal(result.rateLimited, true); assert.equal(result.deferred, 3);
  assert.deepEqual(h.writes[0].ids, [10, 20, 30]);
  assert.ok(Date.parse(String(h.writes[0].values.tags_next_attempt_at)) > Date.now() + 29 * 60_000);
  const expired = tagHarness(new Response("unused"), true);
  assert.equal((await expired.run()).deferred, 3); assert.equal(expired.requests, 0);
  assert.equal(expired.writes.length, 1);
  const tagsSource = readFileSync(fileURLToPath(new URL("lib/steam-tags.ts", root)), "utf8");
  assert.doesNotMatch(tagsSource, /duration_kind:|duration_status:|main_story_minutes:|game_duration_estimates/);
});
