import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as steamErrors from "./steam-api-error.ts";
import * as library from "./steam-owned-games.ts";
import * as snapshots from "./steam-library-snapshot.ts";
import * as input from "./steam-profile-input.ts";
import * as diagnostics from "./diagnostics.ts";
import * as security from "./manual-profile-security.ts";

// Execute the actual route handlers with explicit, in-memory service adapters.
// Unknown imports fail closed: this harness cannot reach production or Supabase.
const nativeRequire = createRequire(import.meta.url);
const next = nativeRequire("next/server");
const root = new URL("../", import.meta.url);
const accountId = "11111111-2222-4333-8444-555555555555";
const steamId = "76561198000000000";
type Handler = (request: Request) => Promise<Response>;

function harness(options: { libraryError?: Error; profileMissing?: boolean; visibility?: number; cacheFailure?: boolean; stagingFailure?: boolean; databaseFailure?: boolean; identityValid?: boolean; existingSession?: boolean } = {}) {
  let gamesFetched = 0; let loggedIn = options.existingSession ?? false; let accountsCreated = 0;
  let progress = { status: "idle", total: 0, imported: 0, completedAt: null as string | null };
  const rows = new Map<string, unknown>();
  const entries: Record<string, unknown>[] = [];
  const afterWork: Array<() => Promise<unknown>> = [];
  const games = library.steamOwnedGamesFromPayload({ response: { games: [{ appid: 10, name: "Test game", playtime_forever: 60 }] } });
  const user = { id: accountId, steam_id: steamId, account_type: "manual", display_name: "Test player", avatar_url: null };
  const cache = { get: async (key: string) => rows.get(key), set: async (key: string, value: unknown) => { if (options.cacheFailure) throw new Error("Cache offline"); rows.set(key, value); }, delete: async (key: string) => { rows.delete(key); } };
  const diagnosticAdapter = (request: Request, operation: string) => {
    let stage = "request";
    const requestId = crypto.randomUUID();
    return { requestId, stage: (value: string) => { stage = value; }, account: () => undefined,
      event: (outcome: string, fields = {}, error?: unknown) => entries.push({ operation, stage, outcome, ...fields, ...diagnostics.diagnosticFailure(error) }),
      response: (response: Response) => { response.headers.set("X-Request-Id", requestId); return response; },
    };
  };
  class SessionRequiredError extends Error {}
  class RateLimitExceededError extends Error { retryAfterSeconds = 60; code = "rate_limited"; }
  const imports: Record<string, unknown> = {
    "server-only": {}, "node:crypto": nativeRequire("node:crypto"), "zod": nativeRequire("zod"),
    "next/server": { ...next, after: (work: () => Promise<unknown>) => { afterWork.push(work); } },
    "next/headers": { headers: async () => new Headers() },
    "@/lib/diagnostics": diagnostics,
    "@/lib/diagnostics-server": { requestDiagnostics: diagnosticAdapter, reportApiFailure: () => undefined, reportServiceWarning: () => undefined },
    "@/lib/steam-api-error": steamErrors, "@/lib/steam-owned-games": library, "@/lib/steam-library-snapshot": snapshots,
    "@/lib/steam-profile-input": input, "@/lib/manual-profile-security": security,
    "@/lib/steam-setup-cache": { steamSetupCache: () => cache },
    "@/lib/rate-limit": { enforceRateLimit: async () => undefined, releaseRateLimit: async () => undefined, requestFingerprint: () => "test", RateLimitExceededError },
    "@/lib/recency-sync": { syncSteamRecentWindow: async () => ({ error: null }) },
    "@/lib/catalogue": { processCatalogueQueue: async () => undefined },
    "@/lib/posthog-server": { deliverPostHogAccountProfileMerge: async () => undefined },
    "@/lib/auth": {
      SessionRequiredError,
      getCurrentSession: async () => loggedIn ? { user, sessionId: accountId } : null,
      requireSession: async () => { if (!loggedIn) throw new SessionRequiredError("unauthorized"); return { user }; },
      attachSessionCookie: (response: InstanceType<typeof next.NextResponse>, token: string) => { response.cookies.set("vault_session", token, { httpOnly: true }); return response; },
      createManualProfileSession: async () => { accountsCreated++; loggedIn = true; return { user, token: "manual.test-only-session" }; },
      createSessionForSteamId: async () => {
        if (options.databaseFailure) throw new Error("Could not create user", { cause: { code: "42702", message: "private database content" } });
        accountsCreated++; return { user: { ...user, account_type: "steam" }, token: "test-only-session" };
      },
    },
    "@/lib/steam": {
      fetchSteamPlayerSummary: async () => options.profileMissing ? null : { steam_id: steamId, display_name: "Test player", avatar_url: null, community_visibility_state: options.visibility ?? 3 },
      fetchOwnedSteamGames: async () => { gamesFetched++; if (options.libraryError) throw options.libraryError; return games; },
      verifySteamOpenId: async () => options.identityValid !== false,
      steamIdFromOpenId: () => steamId,
      siteBaseUrl: () => "http://localhost",
      steamAuthUrl: () => "https://steamcommunity.com/openid/login",
    },
    "@/lib/steam-import-jobs": {
      stageSteamImport: async (_id: string, stagedGames: unknown[]) => { if (options.stagingFailure) throw new Error("staging unavailable"); progress = { ...progress, status: "importing", total: stagedGames.length }; return progress; },
      getSteamImportProgress: async () => progress,
      processNextSteamImportBatch: async () => { progress = { ...progress, status: "complete", imported: progress.total, completedAt: new Date().toISOString() }; return { progress }; },
    },
  };
  const modules = new Map<string, Record<string, unknown>>();
  function load(path: string): Record<string, unknown> {
    if (modules.has(path)) return modules.get(path)!;
    const source = readFileSync(new URL(path, root), "utf8");
    const compiled = ts.transpileModule(source, { fileName: fileURLToPath(new URL(path, root)), compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const sourceModule = { exports: {} as Record<string, unknown> };
    modules.set(path, sourceModule.exports);
    const requireMock = (name: string) => {
      if (name in imports) return imports[name];
      if (name === "@/lib/http") return load("lib/http.ts");
      if (name === "@/lib/manual-steam-profile") return load("lib/manual-steam-profile.ts");
      throw new Error(`Unmocked import in isolated auth test: ${name}`);
    };
    new Function("require", "module", "exports", compiled)(requireMock, sourceModule, sourceModule.exports);
    return sourceModule.exports;
  }
  function route(path: string, method: "POST" | "GET" = "POST") { return load(`app/api/${path}/route.ts`)[method] as Handler; }
  const post = (path: string, body: unknown) => new Request(`http://localhost/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(body) });
  return { route, post, entries, afterWork, rows, get gamesFetched() { return gamesFetched; }, get accountsCreated() { return accountsCreated; } };
}

const originalSecret = process.env.SESSION_SECRET;
const originalSteamKey = process.env.STEAM_WEB_API_KEY;
test.beforeEach(() => { process.env.SESSION_SECRET = "isolated-auth-test-secret-not-production"; process.env.STEAM_WEB_API_KEY = "isolated-test-key"; });
test.after(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSecret;
  if (originalSteamKey === undefined) delete process.env.STEAM_WEB_API_KEY; else process.env.STEAM_WEB_API_KEY = originalSteamKey;
});

test("manual lookup -> create -> dashboard import reuses the setup library without a second Steam fetch", async () => {
  const h = harness();
  const lookup = await h.route("manual-profile/lookup")(h.post("manual-profile/lookup", { profile: steamId }));
  assert.equal(lookup.status, 200);
  const result = await lookup.json();
  const created = await h.route("manual-profile/create")(h.post("manual-profile/create", { lookup_token: result.lookup_token, display_name: "My Vault" }));
  assert.equal(created.status, 200); assert.match(created.headers.get("set-cookie") ?? "", /vault_session=/);
  assert.equal(h.accountsCreated, 1);
  const imported = await h.route("steam/owned-games")(h.post("steam/owned-games", { restart: true }));
  assert.equal((await imported.json()).progress.status, "complete");
  assert.equal(h.gamesFetched, 1);
  assert.ok(h.entries.some((entry) => entry.cache_result === "hit"));
});

test("cache/staging failures preserve the created session and allow dashboard recovery", async () => {
  for (const options of [{ cacheFailure: true }, { stagingFailure: true }]) {
    const h = harness(options);
    const lookup = await (await h.route("manual-profile/lookup")(h.post("manual-profile/lookup", { profile: steamId }))).json();
    const created = await h.route("manual-profile/create")(h.post("manual-profile/create", { lookup_token: lookup.lookup_token, display_name: "My Vault" }));
    assert.equal(created.status, 200); assert.match(created.headers.get("set-cookie") ?? "", /vault_session=/); assert.equal(h.accountsCreated, 1);
    assert.ok(h.entries.some((entry) => entry.outcome === "warning"));
    options.stagingFailure = false;
    const retry = await h.route("steam/owned-games")(h.post("steam/owned-games", { restart: true }));
    assert.equal(retry.status, 200);
    const imported = await h.route("steam/owned-games")(h.post("steam/owned-games", { restart: false }));
    assert.equal((await imported.json()).progress.status, "complete");
  }
});

test("manual lookup emits distinct private, unavailable, empty, invalid, missing and Steam limit results", async () => {
  const cases = [
    { options: { visibility: 1, libraryError: new library.SteamLibraryUnavailableError() }, code: "library_private", status: 409 },
    { options: { libraryError: new library.SteamLibraryUnavailableError() }, code: "library_unavailable", status: 409 },
    { options: { libraryError: new library.SteamLibraryUnavailableError("library_empty") }, code: "library_empty", status: 409 },
    { options: { profileMissing: true }, code: "profile_not_found", status: 404 },
    { options: { libraryError: new steamErrors.SteamApiError("owned_games", "steam_rate_limited", 429, 90) }, code: "steam_rate_limited", status: 429 },
  ];
  for (const item of cases) {
    const h = harness(item.options);
    const response = await h.route("manual-profile/lookup")(h.post("manual-profile/lookup", { profile: steamId }));
    assert.equal(response.status, item.status); assert.equal((await response.json()).code, item.code);
    assert.ok(diagnostics.diagnosticId(response.headers.get("X-Request-Id")));
    if (item.status === 429) assert.equal(response.headers.get("Retry-After"), "90");
    assert.equal(h.accountsCreated, 0);
  }
  const invalid = harness();
  const response = await invalid.route("manual-profile/lookup")(invalid.post("manual-profile/lookup", { profile: "https://malicious.example/secret" }));
  assert.equal(response.status, 400); assert.equal((await response.json()).code, "invalid_profile"); assert.equal(invalid.gamesFetched, 0);
});

test("Steam callback failures preserve verification and report the exact failing stage without leaking database text", async () => {
  for (const options of [{ databaseFailure: true }, { identityValid: false }]) {
    const h = harness(options);
    const response = await h.route("auth/steam/callback", "GET")(new next.NextRequest(`http://localhost/api/auth/steam/callback?openid.claimed_id=https://steamcommunity.com/openid/id/${steamId}`));
    assert.equal(response.status, 307); assert.match(response.headers.get("location") ?? "", /signin=/);
    assert.ok(!response.headers.get("set-cookie")?.includes("vault_session=")); assert.equal(h.accountsCreated, 0);
    assert.ok(h.entries.some((entry) => entry.stage === (options.databaseFailure ? "account_and_session_create" : "steam_identity_verification") && entry.outcome === "failed"));
    assert.ok(!JSON.stringify(h.entries).includes("private database content"));
    if (options.databaseFailure) assert.ok(h.entries.some((entry) => entry.database_code === "42702"));
  }
});

test("a verified Steam callback creates the session, returns the import marker and clears the diagnostic flow cookie", async () => {
  const h = harness();
  const response = await h.route("auth/steam/callback", "GET")(new next.NextRequest(`http://localhost/api/auth/steam/callback?openid.claimed_id=https://steamcommunity.com/openid/id/${steamId}`));
  assert.match(response.headers.get("location") ?? "", /\/dashboard$/);
  assert.match(response.headers.get("set-cookie") ?? "", /vault_session=/);
  assert.match(response.headers.get("set-cookie") ?? "", /vault_steam_import=1/);
  assert.equal(h.accountsCreated, 1);
});

test("dashboard import propagates a Steam 429 cooldown instead of hiding it inside a 502", async () => {
  const h = harness({ existingSession: true, libraryError: new steamErrors.SteamApiError("owned_games", "steam_rate_limited", 429, 90) });
  const response = await h.route("steam/owned-games")(h.post("steam/owned-games", { restart: true }));
  assert.equal(response.status, 429); assert.equal(response.headers.get("Retry-After"), "90");
  const payload = await response.json();
  assert.equal(payload.code, "steam_rate_limited"); assert.equal(payload.retry_after_seconds, 90);
  assert.ok(h.entries.some((entry) => entry.upstream_status === 429 && entry.outcome === "deferred"));
  assert.equal(h.gamesFetched, 1);
});

test("Steam start and callback share a diagnostic-only flow ID, including cancellation", async () => {
  const h = harness();
  const start = await h.route("auth/steam", "GET")(new Request("http://localhost/api/auth/steam"));
  const flowId = (start.headers.get("set-cookie") ?? "").match(/vault_auth_trace=([^;]+)/)?.[1];
  assert.ok(diagnostics.diagnosticId(flowId));
  const response = await h.route("auth/steam/callback", "GET")(new next.NextRequest("http://localhost/api/auth/steam/callback?openid.mode=cancel", { headers: { Cookie: `vault_auth_trace=${flowId}` } }));
  assert.equal(response.status, 307); assert.equal(h.accountsCreated, 0);
  assert.ok(h.entries.some((entry) => entry.flow_id === flowId && entry.error_code === "steam_sign_in_cancelled"));
});
