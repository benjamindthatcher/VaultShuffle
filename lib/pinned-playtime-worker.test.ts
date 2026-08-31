import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as errors from "./steam-api-error.ts";
import * as parser from "./steam-owned-games.ts";
import * as diagnostics from "./diagnostics.ts";

function load(path: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as Record<string, (...args: any[]) => any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  new Function("require", "module", "exports", ...Object.keys(globals), compiled)((name: string) => {
    if (name === "server-only") return {};
    if (name in imports) return imports[name];
    throw new Error(`Unexpected dependency: ${name}`);
  }, mod, mod.exports, ...Object.values(globals));
  return mod.exports;
}

test("playtime parser accepts nameless pins and true zero, rejects hidden/malformed minutes, deduplicates", () => {
  const games = parser.steamPlaytimeFromPayload({ response: { games: [
    { appid: 10, playtime_forever: 60 }, { appid: 10, playtime_forever: 90 },
    { appid: 20, playtime_forever: 0 }, { appid: 30 }, { appid: 40, playtime_forever: null },
    { appid: 50, playtime_forever: -1 }, { appid: 60, playtime_forever: "123" },
    { appid: 70, playtime_forever: NaN }, { appid: "bad", playtime_forever: 90 },
  ] } });
  assert.deepEqual(games, [{ steam_appid: "10", minutes: 90, last_played_at: null }, { steam_appid: "20", minutes: 0, last_played_at: null }]);
  for (const payload of [{ response: {} }, { response: { games: [{ appid: 10 }] } }, { response: { games: [] } }]) {
    assert.throws(() => parser.steamPlaytimeFromPayload(payload), { code: "library_unavailable" });
  }
});

test("Steam request is uncached, explicitly pin-filtered, and rejects unrelated response games", async () => {
  let requests = 0;
  const steam = load("./steam.ts", {
    "@/lib/images": {}, "@/lib/genres": {}, "@/lib/steam-owned-games": parser, "@/lib/steam-recent": {},
    "@/lib/steam-api-error": { ...errors, fetchSteamResponse: async (_operation: string, url: string, init: RequestInit) => {
      requests++;
      assert.equal(init.cache, "no-store");
      const args = JSON.parse(new URL(url).searchParams.get("input_json")!);
      assert.deepEqual(args.appids_filter, [10,20]); assert.equal(args.include_appinfo, false);
      return Response.json({ response: { games: [{ appid: 10, playtime_forever: 600 }, { appid: 999, playtime_forever: 700 }] } });
    } },
  });
  assert.deepEqual(await steam.fetchPinnedSteamPlaytime("steam-test", "test-key", ["10", "20", "10"]), [{ steam_appid: "10", minutes: 600, last_played_at: null }]);
  assert.deepEqual(await steam.fetchPinnedSteamPlaytime("steam-test", "test-key", []), []);
  assert.equal(requests, 1);
});

test("invalid or future last-played values cannot become recency evidence", () => {
  for (const value of [true,"123",Infinity,Date.now()/1000+100000,1e100]) {
    assert.equal(parser.steamPlaytimeFromPayload({response:{games:[{appid:10,playtime_forever:600,rtime_last_played:value}]}})[0].last_played_at,null);
  }
});

test("pin cron routes through production authentication/daily budget rather than running directly", async () => {
  const task=async()=>({pinsUpdated:0});
  const req=new Request("https://example.test/api/cron/pinned-playtime");
  const route=load("../app/api/cron/pinned-playtime/route.ts",{
    "@/lib/pinned-playtime-worker":{refreshPinnedPlaytime:task},
    "@/lib/nightly-worker":{runNightlyWorker:async(request:Request,name:string,run:unknown)=>{
      assert.equal(request,req);assert.equal(name,"pinned-playtime");assert.equal(run,task);
      return Response.json({guarded:true});
    }},
  });
  assert.deepEqual(await (await route.GET(req)).json(),{guarded:true});
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function harness(options: { size?: number; errorAt?: number; limited?: boolean; allFail?: boolean; expire?: boolean; shared?: boolean } = {}) {
  let fetched = 0, saved = 0;
  const accounts = Array.from({ length: options.size ?? 8 }, (_, i) => ({ id: id(i+1), steam_id: `steam-${options.shared ? 0 : i}`, appids: [String(options.shared ? 10 : i+10)] }));
  const cursor = id(500);
  const query = { select: () => query, eq: () => query, in: () => query, order: () => query, limit: () => query,
    maybeSingle: async () => ({ data: { summary: { lastAccountId: cursor } }, error: null }) };
  const worker = load("./pinned-playtime-worker.ts", {
    "@/lib/diagnostics": diagnostics, "@/lib/steam-api-error": errors,
    "@/lib/supabase": { getSupabaseAdmin: () => ({ from: (table: string) => { assert.equal(table,"metadata_worker_runs"); return query; },
      rpc: (name: string, args: Record<string, unknown>) => {
        if (name === "get_pinned_playtime_candidates") {
          assert.equal(args.p_cursor,cursor); assert.equal(args.p_limit,150);
          return Promise.resolve({ data: accounts, error: null });
        }
        assert.equal(name,"refresh_pinned_steam_playtime");
        assert.ok(Array.isArray(args.p_games)); saved++;
        return { abortSignal: async () => ({ data: { pinned_games_updated: 1, pinned_games_matched: 1 }, error: null }) };
      } }) },
    "@/lib/steam": { fetchPinnedSteamPlaytime: async (_steam: string, _key: string, appids: string[]) => {
      fetched++; assert.equal(appids.length,1);
      if (options.allFail || fetched===options.errorAt) throw new errors.SteamApiError("owned_games", options.limited ? "steam_rate_limited" : "steam_timeout", options.limited ? 429 : undefined);
      return [{ steam_appid: appids[0], minutes: 120, last_played_at: null }];
    } },
  }, { process: { env: { STEAM_WEB_API_KEY: "test-only" } }, ...(options.expire ? { Date: { now: (() => { let calls=0; return () => ++calls===1 ? 0 : 100000; })() } } : {}) });
  return { run: worker.refreshPinnedPlaytime, get fetched(){return fetched;}, get saved(){return saved;} };
}

test("pin worker makes only pin reads/writes, preserves cursor, and never invokes enrichment or snapshots", async () => {
  const h=harness(); const result=await h.run();
  assert.equal(h.fetched,8); assert.equal(h.saved,8); assert.equal(result.pinsUpdated,8);
  assert.equal(result.lastAccountId,id(8)); assert.equal(result.failed,0);
  // Every unexpected dependency/table/RPC fails in the harness above.
});
test("failed pins are attempted once then skipped; Steam 429 stops the next batch", async () => {
  const h=harness({errorAt:1}); const result=await h.run();
  assert.equal(h.fetched,8); assert.equal(h.saved,7); assert.equal(result.failed,1);
  const limited=harness({errorAt:1,limited:true}); const stopped=await limited.run();
  assert.equal(limited.fetched,4); assert.equal(stopped.deferred,4); assert.equal(stopped.rateLimited,true);
  assert.equal(stopped.lastAccountId,id(4));
});
test("identical Steam pin requests are shared, while each independent account is saved separately",async()=>{
  const shared=harness({shared:true}); await shared.run();
  assert.equal(shared.fetched,1);assert.equal(shared.saved,8);
  const capped=harness({size:400});const result=await capped.run();
  assert.equal(capped.fetched,150);assert.equal(result.candidateLimitReached,true);
});
test("empty queue, elapsed budget and widespread failures are bounded", async () => {
  const empty=harness({size:0}); assert.equal((await empty.run()).accountsAttempted,0); assert.equal(empty.fetched,0);
  const expired=harness({expire:true}); assert.equal((await expired.run()).deferred,8); assert.equal(expired.fetched,0);
  const failed=harness({size:30,allFail:true}); assert.equal((await failed.run()).stoppedAfterFailures,true); assert.equal(failed.fetched,12);
});

test("manual refresh retains playtime through parser, staged import and completed UI reload", () => {
  assert.equal(parser.steamOwnedGamesFromPayload({response:{games:[{appid:10,name:"Test",playtime_forever:690}]}})[0].hours_played,11.5);
  const read=(path:string)=>readFileSync(new URL(path,import.meta.url),"utf8");
  assert.match(read("../app/api/steam/owned-games/route.ts"),/stageSteamImport\(user.id, importedGames\)/);
  assert.match(read("./steam-import-jobs.ts"),/await upsertSteamGames\(userId, batch\)/);
  assert.match(read("./games.ts"),/hours_played: normalized.hours_played/);
  assert.match(read("../components/app-shell/AppDataProvider.tsx"),/const refreshed = await load\(\)/);
  assert.match(read("../components/shared/PinnedCommitments.tsx"),/games.find\(\(game\) => game.id === id\)/);
});
