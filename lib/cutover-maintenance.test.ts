import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
const { unstable_doesMiddlewareMatch: doesProxyMatch } = require("next/experimental/testing/server");
const loaded = { exports: {} as { proxy: (request: InstanceType<typeof NextRequest>) => Response; config: { matcher: string[] } } };
const imports: Record<string, unknown> = {
  "next/server": { NextRequest, NextResponse },
  "@/lib/diagnostics": { diagnosticRoute: () => "/test" },
  "@/lib/blog/schedule": { isUnpublishedArticle: () => false },
  "node:crypto": require("node:crypto"),
};
const compiled = ts.transpileModule(readFileSync(new URL("../proxy.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("require", "module", "exports", compiled)((name: string) => {
  assert.ok(name in imports);return imports[name];
}, loaded, loaded.exports);

test("Cutover maintenance fences GET workers, session pages and writes before routes run", async () => {
  const previous = process.env.VAULT_MAINTENANCE;
  try {
    process.env.VAULT_MAINTENANCE = "1";
    for (const [path, method] of [["/api/cron/nightly-metadata", "GET"], ["/api/catalogue/process", "POST"],
      ["/api/auth/steam/callback", "GET"], ["/setup/steam-profile", "GET"], ["/wishlist", "GET"], ["/library", "GET"]]) {
      assert.equal(doesProxyMatch({ config: loaded.exports.config, nextConfig: {}, url: path }), true);
      const response = loaded.exports.proxy(new NextRequest(`https://vaultshuffle.com${path}`, { method }));
      assert.equal(response.status, 503);assert.equal(response.headers.get("Retry-After"), "60");
      assert.equal(response.headers.get("Cache-Control"), "private, no-store, max-age=0");
      assert.equal(response.headers.get("x-middleware-next"), null);
    }
    for (const path of ["/_next/static/chunk.js", "/_next/image?url=game.jpg", "/favicon.ico"])
      assert.equal(doesProxyMatch({ config: loaded.exports.config, nextConfig: {}, url: path }), false);
    delete process.env.VAULT_MAINTENANCE;
    assert.equal(loaded.exports.proxy(new NextRequest("https://vaultshuffle.com/api/session")).headers.get("x-middleware-next"), "1");
  } finally {
    if (previous === undefined) delete process.env.VAULT_MAINTENANCE;else process.env.VAULT_MAINTENANCE = previous;
  }
});

test("Maintenance permits only the explicitly enabled, authenticated V2 recovery worker", () => {
  const saved = Object.fromEntries(["VAULT_MAINTENANCE", "VAULT_CUTOVER_WORKERS", "VAULT_DATABASE_AUTHORITY", "CRON_SECRET"].map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { VAULT_MAINTENANCE: "1", VAULT_CUTOVER_WORKERS: "1", VAULT_DATABASE_AUTHORITY: "v2", CRON_SECRET: "synthetic-cutover-test" });
    const request = (path = "/api/v2/workers/owned-games", authorization = "Bearer synthetic-cutover-test", method = "GET") =>
      new NextRequest(`https://vaultshuffle.com${path}`, {method,headers:{authorization}});
    assert.equal(loaded.exports.proxy(request()).headers.get("x-middleware-next"), "1");
    for (const denied of [request("/api/session"), request("/api/cron/nightly-metadata"), request("/api/cron/catalogue-metadata"), request(undefined, "Bearer wrong"),
      request(undefined, ""), request(undefined, undefined, "POST")]) assert.equal(loaded.exports.proxy(denied).status, 503);
    process.env.VAULT_CUTOVER_WORKERS = "0";
    assert.equal(loaded.exports.proxy(request()).status, 503);
    process.env.VAULT_CUTOVER_WORKERS = "1";process.env.VAULT_DATABASE_AUTHORITY = "legacy";
    assert.equal(loaded.exports.proxy(request()).status, 503);
    process.env.VAULT_DATABASE_AUTHORITY = "v2";delete process.env.CRON_SECRET;
    assert.equal(loaded.exports.proxy(request()).status, 503);
  } finally {
    for (const [key,value] of Object.entries(saved)) if (value === undefined) delete process.env[key];else process.env[key] = value;
  }
});
