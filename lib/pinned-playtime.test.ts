import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as steamErrors from "./steam-api-error.ts";
import * as steamPayload from "./steam-owned-games.ts";
import type { Game } from "./types.ts";

function load(imports: Record<string, unknown>) {
  const source = readFileSync(new URL("./pinned-playtime.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} as Record<string, (...args: any[]) => any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  new Function("require", "module", "exports", "process", compiled)((name: string) => {
    if (name in imports) return imports[name];
    throw new Error(`Unmocked pinned-refresh dependency: ${name}`);
  }, loaded, loaded.exports, { env: { STEAM_WEB_API_KEY: "test-key" } });
  return loaded.exports;
}

const account = "00000000-0000-4000-8000-000000000001";
const steamId = "76561198000000001";
function game(id: string, overrides: Partial<Game> = {}): Game {
  return {
    id, user_id: account, title: `Game ${id}`, genre: "Action", store: "Steam", ownership: "Owned", status: "In Progress",
    rating: 9, hours_played: 10, completion_percentage: 33, priority: "High", date_added: null, last_played_at: null,
    notes: "Keep my notes", steam_appid: id, observed_playtime_minutes: 600, updated_at: "2026-08-30T10:00:00.000Z", ...overrides,
  };
}

function harness(options: {
  payload?: unknown; pins?: string[]; currentPins?: string[]; games?: Game[];
  limiterError?: Error; fetchError?: Error; rpcError?: Error;
} = {}) {
  const games = options.games ?? [game("10"), game("20"), game("30", { user_id: "another-account" })];
  const pins = options.pins ?? ["10", "20"];
  const currentPins = options.currentPins ?? pins;
  const calls = { fetch: 0, rate: [] as Array<Record<string, unknown>>, rpc: [] as Array<Record<string, unknown>> };
  let pinReads = 0;
  function from(table: string) {
    assert.ok(["user_game_pins", "user_games_with_catalog"].includes(table));
    const filters = new Map<string, unknown>();
    let limit = Infinity;
    const query = {
      select: () => query,
      eq: (name: string, value: unknown) => { filters.set(name, value); return query; },
      in: (name: string, value: unknown) => { filters.set(name, value); return query; },
      order: () => query,
      limit: (value: number) => { limit = value; return query; },
      then: (resolve: (value: unknown) => unknown) => {
        assert.equal(filters.get("user_id"), account);
        if (table === "user_game_pins") {
          assert.equal(filters.get("scope"), "library"); pinReads++;
          return resolve({ data: (pinReads === 1 ? pins : currentPins).slice(0, limit).map((game_id) => ({ game_id })), error: null });
        }
        assert.equal(filters.get("ownership"), "Owned"); assert.equal(filters.get("is_quarantined"), false);
        return resolve({ data: games.filter((row) => row.user_id === account && (filters.get("id") as string[]).includes(row.id)), error: null });
      },
    };
    return query;
  }
  const loaded = load({
    "@/lib/supabase": { getSupabaseAdmin: () => ({ from, rpc: async (name: string, input: { p_user_id: string; p_games: steamPayload.SteamPlaytime[] }) => {
      assert.equal(name, "refresh_pinned_steam_playtime"); assert.equal(input.p_user_id, account);
      calls.rpc.push(input);
      if (options.rpcError) return { data: null, error: options.rpcError };
      let matched = 0;
      for (const reading of input.p_games) {
        assert.deepEqual(Object.keys(reading).sort(), ["last_played_at", "minutes", "steam_appid"]);
        const row = games.find((row) => row.user_id === account && currentPins.includes(row.id) && row.steam_appid === reading.steam_appid);
        if (row) { matched++; row.hours_played = Math.max(row.hours_played, Math.round(reading.minutes / 6) / 10); }
      }
      return { data: { pinned_games_updated: matched, pinned_games_matched: matched }, error: null };
    } }) },
    "@/lib/game-tables": { USER_GAMES_READ_MODEL: "user_games_with_catalog" },
    "@/lib/games": { findGame: async (userId: string, id: string) => {
      assert.equal(userId, account); return games.find((row) => row.id === id && row.user_id === userId) ?? null;
    } },
    "@/lib/rate-limit": { enforceRateLimit: async (input: Record<string, unknown>) => {
      calls.rate.push(input); if (options.limiterError) throw options.limiterError;
    } },
    "@/lib/steam-owned-games": steamPayload,
    "@/lib/steam": { fetchPinnedSteamPlaytime: async (id: string, key: string, appIds: string[]) => {
      calls.fetch++; assert.equal(id, steamId); assert.equal(key, "test-key");
      assert.ok(appIds.length <= 3); assert.ok(appIds.every((id) => pins.includes(id)));
      if (options.fetchError) throw options.fetchError;
      return steamPayload.steamPlaytimeFromPayload(options.payload ?? { response: { games: [{ appid: 10, playtime_forever: 660 }, { appid: 20, playtime_forever: 720 }] } });
    } },
  });
  return { refreshPinnedPlaytime: loaded.refreshPinnedPlaytime, readablePinnedPlaytime: loaded.readablePinnedPlaytime, calls, games };
}

test("only requested readings survive; stale/hidden playtime cannot erase saved values", () => {
  const h = harness();
  const readings = h.readablePinnedPlaytime([game("10", { hours_played: 0 }), game("20")], [
    { steam_appid: "10", minutes: 0, last_played_at: null },
    { steam_appid: "20", minutes: 0, last_played_at: null },
    { steam_appid: "30", minutes: 500, last_played_at: null },
  ]);
  assert.deepEqual(readings, [{ steam_appid: "10", minutes: 0, last_played_at: null }]);
  assert.equal(h.readablePinnedPlaytime([game("10")], [{ steam_appid: "10", minutes: 300, last_played_at: null }]).length, 0);
});

test("malformed minute fields and future recency cannot be sent to the shared RPC", () => {
  const h = harness();
  for (const minutes of [null, undefined, "660", -1, 1.5, Infinity, NaN, 2_147_483_648]) {
    assert.equal(h.readablePinnedPlaytime([game("10")], [{ steam_appid: "10", minutes, last_played_at: null }]).length, 0);
  }
  assert.equal(h.readablePinnedPlaytime([game("10")], [{ steam_appid: "10", minutes: 660, last_played_at: "2100-01-01" }])[0].last_played_at, null);
});

test("refresh fetches once for server-resolved pins and only uses the targeted RPC", async () => {
  const h = harness({ payload: { response: { games: [{ appid: 10, playtime_forever: 660 }, { appid: 20, playtime_forever: 720 }, { appid: 30, playtime_forever: 1000 }] } } });
  const result = await h.refreshPinnedPlaytime(account, steamId);
  assert.equal(h.calls.fetch, 1); assert.equal(h.calls.rpc.length, 1);
  assert.deepEqual(result.games.map((row: Game) => [row.id, row.hours_played]), [["10", 11], ["20", 12]]);
  assert.equal(result.refreshed, 2); assert.equal(result.skipped, 0); assert.equal(result.retryAfterSeconds, 60);
  assert.equal(h.games[2].hours_played, 10); assert.equal(h.games[0].notes, "Keep my notes"); assert.equal(h.games[0].status, "In Progress");
  assert.deepEqual(h.calls.rate.map((item) => [item.bucket, item.identity, item.limit, item.windowSeconds]), [
    ["pinned_playtime_account", account, 1, 60], ["pinned_playtime_steam", steamId, 1, 60],
  ]);
});

test("missing Steam pins and pins removed during fetch are preserved and reported as skipped", async () => {
  for (const options of [{ payload: { response: { games: [{ appid: 10, playtime_forever: 660 }] } } }, { currentPins: ["10"] }]) {
    const h = harness(options); const result = await h.refreshPinnedPlaytime(account, steamId);
    assert.equal(result.refreshed, 1); assert.equal(result.skipped, 1); assert.equal(h.games[1].hours_played, 10);
  }
});

test("unchanged real zero-hour pins count as refreshed; stale or zeroed known playtime is skipped", async () => {
  const h = harness({ games: [game("10", { hours_played: 0 })], pins: ["10"], payload: { response: { games: [{ appid: 10, playtime_forever: 0 }] } } });
  assert.equal((await h.refreshPinnedPlaytime(account, steamId)).refreshed, 1);
  const stale = harness({ payload: { response: { games: [{ appid: 10, playtime_forever: 0 }, { appid: 20, playtime_forever: 300 }] } } });
  const result = await stale.refreshPinnedPlaytime(account, steamId);
  assert.equal(result.refreshed, 0); assert.equal(result.skipped, 2); assert.equal(stale.calls.rpc.length, 0);
});

test("no-pin action needs no Steam request or limiter", async () => {
  const h = harness({ pins: [] });
  assert.equal((await h.refreshPinnedPlaytime(account, steamId)).retryAfterSeconds, 0);
  assert.equal(h.calls.fetch, 0); assert.equal(h.calls.rate.length, 0); assert.equal(h.calls.rpc.length, 0);
});

test("Steam failures, hidden libraries and rate-limit failures never submit a playtime write", async () => {
  for (const options of [
    { payload: { response: {} } }, { payload: { response: { games: [] } } },
    { fetchError: new steamErrors.SteamApiError("owned_games", "steam_rate_limited", 429, 120) },
    { limiterError: new Error("coordination unavailable") },
  ]) {
    const h = harness(options); await assert.rejects(() => h.refreshPinnedPlaytime(account, steamId)); assert.equal(h.calls.rpc.length, 0);
  }
  await assert.rejects(() => harness({ rpcError: new Error("database unavailable") }).refreshPinnedPlaytime(account, steamId));
});

test("route derives identity from session, protects same origin and never reads client game/account payloads", () => {
  const route = readFileSync(new URL("../app/api/steam/pinned-playtime/route.ts", import.meta.url), "utf8");
  assert.match(route, /assertSameOrigin\(request\)/); assert.match(route, /requireSession\(\)/);
  assert.match(route, /refreshPinnedPlaytime\(user.id, user.steam_id\)/);
  assert.doesNotMatch(route, /request\.json|request\.text|searchParams|upsertSteamGames|processDuration|catalogue/);
  assert.match(route, /private, no-store/);
});

/** Executes the real route and HTTP helper; every I/O dependency is in memory. */
function routeHarness(options: { accountType?: "steam" | "manual"; signedOut?: boolean; refreshError?: Error; partial?: boolean } = {}) {
  const nativeRequire = createRequire(import.meta.url);
  const calls = { sessions: 0, refresh: [] as string[][], outcomes: [] as string[], accountTypes: [] as string[] };
  class SessionRequiredError extends Error {}
  class RateLimitExceededError extends Error { readonly code = "rate_limited"; readonly retryAfterSeconds = 60; }
  class PinnedPlaytimeError extends Error { readonly status = 422; readonly code = "library_unavailable"; }
  class RequestDiagnostics {
    readonly requestId = "99999999-2222-4333-8444-555555555555";
    stage() {}
    account(_id: string, type: string) { calls.accountTypes.push(type); }
    event(outcome: string) { calls.outcomes.push(outcome); }
    response(response: Response) { response.headers.set("X-Request-Id", this.requestId); return response; }
  }
  const result = { games: [game("10", { hours_played: 11 })], refreshed: 1, skipped: options.partial ? 1 : 0,
    refreshedAt: "2026-08-31T10:00:00.000Z", retryAfterSeconds: 60 };
  const imports: Record<string, unknown> = {
    "next/server": nativeRequire("next/server"),
    "next/headers": { headers: async () => new Headers() },
    "zod": nativeRequire("zod"),
    "@/lib/auth": { SessionRequiredError, requireSession: async () => {
      calls.sessions++;
      if (options.signedOut) throw new SessionRequiredError("A VaultShuffle profile is required.");
      return { user: { id: account, steam_id: steamId, account_type: options.accountType ?? "steam" } };
    } },
    "@/lib/rate-limit": { RateLimitExceededError },
    "@/lib/diagnostics-server": { RequestDiagnostics, requestDiagnostics: () => new RequestDiagnostics(), reportApiFailure: () => undefined },
    "@/lib/steam-api-error": steamErrors,
    "@/lib/pinned-playtime": { PinnedPlaytimeError, PINNED_PLAYTIME_COOLDOWN_SECONDS: 60,
      refreshPinnedPlaytime: async (userId: string, profileId: string) => {
        calls.refresh.push([userId, profileId]);
        if (options.refreshError) throw options.refreshError;
        return result;
      },
    },
  };
  function compile(relativePath: string): Record<string, unknown> {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const loaded = { exports: {} as Record<string, unknown> };
    new Function("require", "module", "exports", compiled)((name: string) => {
      if (name in imports) return imports[name];
      if (name === "@/lib/http") return compile("./http.ts");
      throw new Error(`Unmocked route dependency: ${name}`);
    }, loaded, loaded.exports);
    return loaded.exports;
  }
  const post = compile("../app/api/steam/pinned-playtime/route.ts").POST as (request: Request) => Promise<Response>;
  const request = (origin = "https://vault.test", fetchSite = "same-origin") => new Request("https://vault.test/api/steam/pinned-playtime?steam_id=forged", {
    method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": fetchSite, "Content-Type": "application/json" },
    body: JSON.stringify({ steam_id: "76561198999999999", user_id: "another-user", game_ids: ["30"] }),
  });
  return { post, request, calls, result };
}

test("executable POST accepts both account types but ignores forged client account, Steam and game IDs", async () => {
  for (const accountType of ["steam", "manual"] as const) {
    const h = routeHarness({ accountType });
    const response = await h.post(h.request());
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), h.result);
    assert.deepEqual(h.calls.refresh, [[account, steamId]]); assert.deepEqual(h.calls.accountTypes, [accountType]);
    assert.deepEqual(h.calls.outcomes, ["succeeded"]); assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
  }
});

test("executable POST rejects signed-out sessions and cross-site requests before refreshing", async () => {
  const signedOut = routeHarness({ signedOut: true });
  const unauthenticated = await signedOut.post(signedOut.request());
  assert.equal(unauthenticated.status, 401); assert.equal(signedOut.calls.refresh.length, 0);
  for (const [origin, site] of [["https://hostile.test", "same-origin"], ["https://vault.test", "cross-site"]]) {
    const foreign = routeHarness(); const response = await foreign.post(foreign.request(origin, site));
    assert.equal(response.status, 403); assert.equal(foreign.calls.sessions, 0); assert.equal(foreign.calls.refresh.length, 0);
  }
});

test("executable POST returns accurate Steam failures with cooldown, no-store headers and sanitized bodies", async () => {
  const scenarios = [
    { code: "steam_http_error" as const, upstream: 500, retry: undefined, status: 502, expectedRetry: 60 },
    { code: "steam_rate_limited" as const, upstream: 429, retry: 120, status: 429, expectedRetry: 120 },
    { code: "steam_timeout" as const, upstream: undefined, retry: undefined, status: 504, expectedRetry: 60 },
  ];
  for (const scenario of scenarios) {
    const h = routeHarness({ refreshError: new steamErrors.SteamApiError("owned_games", scenario.code, scenario.upstream, scenario.retry) });
    const response = await h.post(h.request()); const body = await response.json();
    assert.equal(response.status, scenario.status); assert.equal(body.code, scenario.code); assert.equal(body.retry_after_seconds, scenario.expectedRetry);
    assert.equal(response.headers.get("Retry-After"), String(scenario.expectedRetry)); assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
    assert.deepEqual(h.calls.outcomes, [scenario.status === 429 ? "deferred" : "failed"]);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(`${steamId}|${account}|test-key`));
  }
});

test("executable POST returns partial success honestly and emits a warning", async () => {
  const h = routeHarness({ partial: true }); const response = await h.post(h.request());
  assert.equal(response.status, 200); assert.equal((await response.json()).skipped, 1); assert.deepEqual(h.calls.outcomes, ["warning"]);
});
