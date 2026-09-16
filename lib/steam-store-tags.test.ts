import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as steamErrors from "./steam-api-error.ts";

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

type Write = { values: Record<string, unknown>; appId: number };

function harness(options: {
  candidates?: Array<{ steam_appid: number; users_that_imported: number }>;
  page?: (appid: number) => { body: string; status?: number };
} = {}) {
  const writes: Write[] = [];
  const requested: number[] = [];
  const candidates = options.candidates ?? [{ steam_appid: 21120, users_that_imported: 148 }];

  const supabase = {
    rpc: async (name: string) => {
      assert.equal(name, "select_store_tag_candidates");
      return { data: candidates, error: null };
    },
    from() {
      let values: Record<string, unknown> | undefined;
      const api: Record<string, unknown> = {
        update: (next: Record<string, unknown>) => { values = next; return api; },
        eq: async (_column: string, id: number) => {
          if (values) writes.push({ values, appId: id });
          return { error: null };
        }
      };
      return api;
    }
  };

  const loaded = load("lib/steam-store-tags.ts", {
    "@/lib/supabase": { getSupabaseAdmin: () => supabase },
    "@/lib/steam-api-error": steamErrors,
    "@/lib/steam": { waitForSteamStoreRateLimit: async () => undefined },
    "@/lib/endless-sync": { promoteIfEndless: async () => ({ promoted: false, witnesses: [] }) }
  }, {
    fetch: async (url: string) => {
      const appid = Number(String(url).match(/\/app\/(\d+)\//)?.[1]);
      requested.push(appid);
      const answer = options.page?.(appid) ?? { body: modalPage(appid) };
      return new Response(answer.body, { status: answer.status ?? 200 });
    }
  }) as unknown as {
    readStorePageTags: (appId: number, html: string) => { state: string; tags?: Record<string, number> };
    processStoreTagQueue: (limit: number, deadlineAt: number) => Promise<Record<string, number | boolean>>;
  };

  return { writes, requested, ...loaded };
}

/** The shape Steam actually serves: the call that feeds its own tag dialog. */
function modalPage(appid: number, tags = `[{"tagid":1667,"name":"Horror","count":554},{"tagid":19,"name":"Action","count":372}]`) {
  return `<html><body class="apphub_AppName"><script>InitAppTagModal( ${appid}, ${tags}, {"read_only":false} );</script></body></html>`;
}

const readOnly = () => harness().readStorePageTags;

test("tags are read with their vote counts, not just their names", () => {
  // The visible anchors carry names but lose the counts, and every share-based rule
  // in game-classification is computed from the counts.
  const verdict = readOnly()(21120, modalPage(21120));
  assert.equal(verdict.state, "ok");
  assert.deepEqual(verdict.tags, { Horror: 554, Action: 372 });
});

test("a page for a different game is never used to tag this one", () => {
  // Steam answers some retired AppIDs with a replacement product's page.
  assert.equal(readOnly()(21120, modalPage(99999)).state, "unavailable");
});

test("an age gate, a delisted game and an unreadable page are told apart", () => {
  const read = readOnly();
  assert.equal(read(1007840, "<html><body>agecheck ageYear</body></html>").state, "age_gated");
  // Delisted AppIDs redirect to the storefront, which carries none of a product
  // page's furniture. Six months before asking again.
  assert.equal(read(43160, "<html><body>Browse the Steam catalog</body></html>").state, "unavailable");
  // But a real product page whose tag block we could not read is still a live game,
  // and writing it off for six months would be wrong.
  assert.equal(read(10, `<html><body class="apphub_AppName">no modal here</body></html>`).state, "no_tags");
});

test("a page with an empty or unreadable tag list is not a failure", () => {
  assert.equal(readOnly()(10, modalPage(10, "[]")).state, "no_tags");
  assert.equal(readOnly()(10, modalPage(10, "[oops]")).state, "no_tags");
  assert.equal(readOnly()(10, modalPage(10, `[{"tagid":1,"count":5}]`)).state, "no_tags");
});

test("tag names are tidied and weights cannot go negative", () => {
  const verdict = readOnly()(10, modalPage(10, `[{"name":"  Open   World ","count":"12"},{"name":"Bad","count":-5}]`));
  assert.deepEqual(verdict.tags, { "Open World": 12, Bad: 0 });
});

test("a tagged game is written as store-sourced, and settles its SteamSpy queue state", async () => {
  const h = harness();
  const result = await h.processStoreTagQueue(10, Date.now() + 60_000);

  assert.equal(result.tagged, 1);
  assert.deepEqual(h.requested, [21120]);
  const write = h.writes[0];
  assert.deepEqual(write.values.tags, { Horror: 554, Action: 372 });
  assert.equal(write.values.tags_source, "steam-store");
  assert.equal(write.values.tags_status, "ready");
  assert.equal(write.values.store_tags_state, "ok");
  // Otherwise SteamSpy's queue keeps reclaiming a row it can never improve.
  assert.equal(write.values.tags_failure_count, 0);
  assert.ok(write.values.tags_fetched_at);
});

test("a game the store cannot tag records the visit and nothing else", async () => {
  const h = harness({ page: () => ({ body: "<html>Browse the Steam catalog</html>" }) });
  const result = await h.processStoreTagQueue(10, Date.now() + 60_000);

  assert.equal(result.unavailable, 1);
  assert.equal(result.tagged, 0);
  const write = h.writes[0];
  assert.equal(write.values.store_tags_state, "unavailable");
  // Critically: no empty tag set written over the row, and no claim on the source.
  assert.ok(!("tags" in write.values));
  assert.ok(!("tags_source" in write.values));
  // But the visit is recorded, or this game holds the head of an owner-ordered
  // queue for ever and starves the games behind it.
  assert.ok(write.values.store_tags_checked_at);
});

test("the deadline stops the pass without touching what it did not reach", async () => {
  const h = harness({
    candidates: [
      { steam_appid: 1, users_that_imported: 9 },
      { steam_appid: 2, users_that_imported: 8 }
    ]
  });
  const result = await h.processStoreTagQueue(10, Date.now() - 1);

  assert.equal(result.deferred, 2);
  assert.equal(result.tagged, 0);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.requested, []);
});

test("three failures in a row stop the pass rather than spending the night on them", async () => {
  const h = harness({
    candidates: [1, 2, 3, 4, 5].map((steam_appid) => ({ steam_appid, users_that_imported: 1 })),
    page: () => ({ body: "", status: 500 })
  });
  const result = await h.processStoreTagQueue(10, Date.now() + 60_000);

  assert.equal(result.failed, 3);
  assert.equal(result.deferred, 2);
  assert.equal(h.requested.length, 3);
  assert.equal(h.writes[0].values.store_tags_state, "error");
});
