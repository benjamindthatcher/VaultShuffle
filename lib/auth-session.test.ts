import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { unstable_rethrow } = require("next/navigation");
const { DynamicServerError } = require("next/dist/client/components/hooks-server-context.js");

function auth(resolve: () => Promise<unknown>) {
  const source = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const imports: Record<string, unknown> = {
    "node:crypto": require("node:crypto"), "next/headers": {},
    "next/navigation": { unstable_rethrow }, "next/server": { after: () => undefined },
    "@/lib/supabase": {}, "@/lib/rate-limit": {},
    "@/lib/database-authority": { isV2Authority: () => true },
    "@/lib/v2/runtime": {}, "@/lib/v2/current-session": { currentV2Session: resolve },
  };
  const loadedModule = { exports: {} as { getCurrentSession: () => Promise<unknown>; SessionLookupError: new (cause: unknown) => Error } };
  new Function("require", "module", "exports", compiled)((name: string) => {
    assert.ok(name in imports, `Unexpected session test import: ${name}`);
    return imports[name];
  }, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

test("V2 session lookup preserves Next request-time rendering control", async () => {
  const control = new DynamicServerError("cookies require a request");
  await assert.rejects(auth(async () => { throw control; }).getCurrentSession(), error => error === control);
});

test("V2 session database failure stays retriable rather than becoming signed out", async () => {
  const failure = new Error("test database unavailable");
  const service = auth(async () => { throw failure; });
  await assert.rejects(service.getCurrentSession(), error => error instanceof service.SessionLookupError && error.cause === failure);
  assert.equal(await auth(async () => null).getCurrentSession(), null);
  const session = { user: { id: "test-account" }, principal: {} };
  assert.equal(await auth(async () => session).getCurrentSession(), session);
});
