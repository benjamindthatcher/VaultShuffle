import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as steamErrors from "./steam-api-error.ts";

/**
 * Loaded the way the nightly workers are tested: `steam-tags.ts` imports through
 * the `@/` alias, which bare node cannot resolve. Transpiling it and injecting its
 * imports keeps the real worker in play while the Supabase client and SteamSpy are
 * stand-ins.
 */
const root = new URL("../", import.meta.url);
function load(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(path, root), "utf8");
  const compiled = ts.transpileModule(source, { fileName: path, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  } }).outputText;
  const loaded = { exports: {} as Record<string, (...args: never[]) => never> };
  new Function("require", "module", "exports", ...Object.keys(globals), compiled)(
    (name: string) => {
      if (name === "server-only") return {};
      if (name in imports) return imports[name];
      throw new Error(`Unmocked dependency in isolated test: ${name}`);
    }, loaded, loaded.exports, ...Object.values(globals)
  );
  return loaded.exports;
}

type Call = { method: string; args: unknown[] };
type CatalogueRow = { steam_appid: number; tags: Record<string, number> | null; tags_source: string | null };

/** Records every filter and write, and answers the catalogue read from what it is given. */
function tagHarness(options: {
  claimed: Array<{ steam_appid: number; tags_failure_count: number }>;
  catalogue: CatalogueRow[];
  steamspy: (appid: number) => unknown;
}) {
  const writes: Array<{ values: Record<string, unknown>; calls: Call[] }> = [];
  const requested: number[] = [];

  const supabase = {
    rpc: async () => ({ data: options.claimed, error: null }),
    from() {
      const calls: Call[] = [];
      let values: Record<string, unknown> | undefined;
      const builder: object = new Proxy({}, {
        get(_target, property) {
          if (typeof property !== "string") return undefined;
          if (property === "then") {
            return (resolve: (value: unknown) => unknown) => {
              if (values) {
                writes.push({ values, calls });
                return resolve({ error: null });
              }
              const selected = String(calls.find((call) => call.method === "select")?.args[0] ?? "");
              if (selected.includes("tags_source")) return resolve({ data: options.catalogue, error: null });
              return resolve({ error: null, count: options.catalogue.length });
            };
          }
          return (...args: unknown[]) => {
            calls.push({ method: property, args });
            if (property === "update") values = args[0] as Record<string, unknown>;
            return builder;
          };
        }
      });
      return builder;
    }
  };

  return {
    writes,
    requested,
    loaded: load("lib/steam-tags.ts", {
      "@/lib/steam-api-error": steamErrors,
      "@/lib/endless-sync": { promoteIfEndless: async () => ({ promoted: false, witnesses: [] }) },
      "@/lib/supabase": { getSupabaseAdmin: () => supabase }
    }, {
      fetch: async (url: string) => {
        const appid = Number(new URL(String(url)).searchParams.get("appid"));
        requested.push(appid);
        return new Response(JSON.stringify({ appid, tags: options.steamspy(appid) }), { status: 200 });
      }
    }) as unknown as {
      processSteamTagQueue: (limit: number, deadlineAt: number) => Promise<Record<string, number>>;
      queueAllKnownSteamTags: () => Promise<number>;
      tagWriteDecision: (
        current: { hasTags: boolean; source: string | null } | undefined,
        fetched: Record<string, number>
      ) => string;
    }
  };
}

const writeFor = (writes: Array<{ values: Record<string, unknown>; calls: Call[] }>, appid: number) =>
  writes.find((write) => write.calls.some((call) =>
    call.method === "eq" && call.args[0] === "steam_appid" && call.args[1] === appid))!;

test("SteamSpy fills in a game that has no tags", async () => {
  const harness = tagHarness({
    claimed: [{ steam_appid: 10, tags_failure_count: 0 }],
    catalogue: [{ steam_appid: 10, tags: {}, tags_source: null }],
    steamspy: () => ({ Roguelike: 400, Action: 200 })
  });
  const result = await harness.loaded.processSteamTagQueue(60, Date.now() + 70_000);

  assert.equal(result.updated, 1);
  assert.equal(result.kept, 0);
  const write = writeFor(harness.writes, 10);
  assert.deepEqual(write.values.tags, { Roguelike: 400, Action: 200 });
  assert.equal(write.values.tags_source, "steamspy");
  assert.ok(write.values.tags_fetched_at);
});

test("an empty SteamSpy answer never wipes tags a game already has", async () => {
  // SteamSpy returns `tags: []` for newer games, which used to be written straight
  // through as `{}` and marked ready.
  const harness = tagHarness({
    claimed: [{ steam_appid: 20, tags_failure_count: 0 }],
    catalogue: [{ steam_appid: 20, tags: { Roguelike: 400 }, tags_source: "steamspy" }],
    steamspy: () => []
  });
  const result = await harness.loaded.processSteamTagQueue(60, Date.now() + 70_000);

  assert.equal(result.updated, 0);
  assert.equal(result.kept, 1);
  const write = writeFor(harness.writes, 20);
  assert.ok(!("tags" in write.values));
  assert.ok(!("tags_source" in write.values));
  assert.equal(write.values.tags_status, "ready");
  // Its own clock still moves, so an untaggable game does not come straight back
  // to the front of a queue ordered oldest-fetched first.
  assert.ok(write.values.tags_fetched_at);
});

test("SteamSpy never overwrites store-page tags, even when it has an answer", async () => {
  const harness = tagHarness({
    claimed: [{ steam_appid: 30, tags_failure_count: 0 }],
    catalogue: [{ steam_appid: 30, tags: { "Extraction Shooter": 5000 }, tags_source: "steam-store" }],
    steamspy: () => ({ Action: 12 })
  });
  const result = await harness.loaded.processSteamTagQueue(60, Date.now() + 70_000);

  assert.equal(result.kept, 1);
  const write = writeFor(harness.writes, 30);
  assert.ok(!("tags" in write.values));
  assert.ok(!("tags_source" in write.values));
  // Not SteamSpy's clock to move.
  assert.ok(!("tags_fetched_at" in write.values));
});

test("the 30-day refresh only re-queues rows SteamSpy wrote", async () => {
  const harness = tagHarness({ claimed: [], catalogue: [], steamspy: () => ({}) });
  await harness.loaded.queueAllKnownSteamTags();

  const refresh = harness.writes.find((write) => write.values.tags_status === "pending"
    && write.calls.some((call) => call.method === "eq" && call.args[0] === "tags_status" && call.args[1] === "ready"));
  assert.ok(refresh, "expected the 30-day refresh update");
  assert.deepEqual(
    refresh.calls.find((call) => call.method === "eq" && call.args[0] === "tags_source")?.args,
    ["tags_source", "steamspy"]
  );
});

test("the decision, stated plainly", () => {
  const { tagWriteDecision } = tagHarness({ claimed: [], catalogue: [], steamspy: () => ({}) }).loaded;
  const tags = { Action: 1 };

  assert.equal(tagWriteDecision(undefined, tags), "write");
  assert.equal(tagWriteDecision({ hasTags: false, source: null }, {}), "write");
  assert.equal(tagWriteDecision({ hasTags: true, source: "steamspy" }, tags), "write");
  assert.equal(tagWriteDecision({ hasTags: true, source: "steamspy" }, {}), "keep-existing");
  assert.equal(tagWriteDecision({ hasTags: true, source: "steam-store" }, tags), "keep-other-source");
  assert.equal(tagWriteDecision({ hasTags: true, source: "steam-store" }, {}), "keep-other-source");
});
