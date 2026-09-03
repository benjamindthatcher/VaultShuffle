import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as classification from "./game-classification.ts";

/**
 * Loaded the same way the nightly workers are tested: `endless-sync.ts` is
 * server-only and imports through the `@/` alias, neither of which resolves under
 * bare node. Transpiling it and injecting its imports keeps the real rule in play
 * while letting the Supabase client be a stand-in.
 */
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

const { promoteIfEndless, sweepEndlessVerdicts } = load("lib/endless-sync.ts", {
  "@/lib/game-classification": classification,
  "@/lib/supabase": {}
}) as unknown as {
  sweepEndlessVerdicts: (
    client: unknown,
    options?: { limit?: number }
  ) => Promise<{ examined: number; promoted: number }>;
  promoteIfEndless: (
    client: unknown,
    steamAppId: number,
    tags: Record<string, number> | null
  ) => Promise<{ promoted: boolean; witnesses: string[] }>;
};

/** Records the update it is asked to make, so we can assert on what was written. */
function fakeClient(row: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    from() {
      let pending: Record<string, unknown> | undefined;
      const query: Record<string, unknown> = {
        select: () => query,
        update: (values: Record<string, unknown>) => { pending = values; return query; },
        eq: () => query,
        neq: () => query,
        maybeSingle: async () => ({ data: row, error: null }),
        then: (resolve: (value: unknown) => unknown) => {
          if (pending) updates.push(pending);
          return resolve({ error: null });
        }
      };
      return query;
    }
  };
  return { client, updates };
}

const siegeTags = {
  FPS: 9892, PvP: 9194, Tactical: 9103, Multiplayer: 9103, "e-sports": 9102,
  Competitive: 9007, Shooter: 9091, "Hero Shooter": 8901
};

const finiteRow = {
  genres: ["Action"],
  categories: ["Single-player", "Multi-player", "PvP", "Online PvP"],
  main_story_minutes: 199,
  completionist_minutes: null,
  duration_kind: "finite",
  duration_manual_override: false,
  steam_type: "game"
};

test("a game the tags convict is promoted to endless", async () => {
  const { client, updates } = fakeClient(finiteRow);
  const result = await promoteIfEndless(client, 359550, siegeTags);

  assert.equal(result.promoted, true);
  assert.ok(result.witnesses.includes("competitive-loop"));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].duration_kind, "endless");
  assert.equal(updates[0].duration_source, "classification");
  assert.equal(updates[0].duration_status, "ready");
  // The HLTB figure is deliberately kept, not nulled.
  assert.ok(!("main_story_minutes" in updates[0]));
});

test("a manual ruling is never overturned", async () => {
  const { client, updates } = fakeClient({ ...finiteRow, duration_manual_override: true });
  assert.equal((await promoteIfEndless(client, 359550, siegeTags)).promoted, false);
  assert.deepEqual(updates, []);
});

test("a game already endless is left alone", async () => {
  const { client, updates } = fakeClient({ ...finiteRow, duration_kind: "endless" });
  assert.equal((await promoteIfEndless(client, 359550, siegeTags)).promoted, false);
  assert.deepEqual(updates, []);
});

test("demos and DLC are not given a length verdict", async () => {
  const { client, updates } = fakeClient({ ...finiteRow, steam_type: "dlc" });
  assert.equal((await promoteIfEndless(client, 359550, siegeTags)).promoted, false);
  assert.deepEqual(updates, []);
});

test("nothing is written for a game the rule clears, or with no tags yet", async () => {
  // Elden Ring: an Action RPG with multiplayer that still has an ending.
  const eldenRing = fakeClient({
    ...finiteRow,
    genres: ["Action", "RPG"],
    main_story_minutes: 3605,
    completionist_minutes: 8170
  });
  const cleared = await promoteIfEndless(eldenRing.client, 1245620, {
    "Souls-like": 6994, "Open World": 5078, RPG: 4707, "Action RPG": 3584, Multiplayer: 3395
  });
  assert.equal(cleared.promoted, false);
  assert.deepEqual(eldenRing.updates, []);

  const untagged = fakeClient(finiteRow);
  assert.equal((await promoteIfEndless(untagged.client, 1, {})).promoted, false);
  assert.deepEqual(untagged.updates, []);
});

test("a missing catalogue row is not an error", async () => {
  const { client, updates } = fakeClient(null);
  assert.equal((await promoteIfEndless(client, 999999, siegeTags)).promoted, false);
  assert.deepEqual(updates, []);
});

test("the sweep judges recently resolved lengths and writes them in one update", async () => {
  const promoted: number[] = [];
  const reads: Array<Record<string, unknown>> = [];
  const rows = [
    // Rainbow Six Siege shape: HLTB just resolved a 3h19 story, tags say
    // competitive. This is the case the tag hook cannot see.
    { steam_appid: 359550, tags: siegeTags, genres: ["Action"],
      categories: ["Single-player", "Multi-player", "PvP"], main_story_minutes: 199, completionist_minutes: null },
    // Elden Ring shape: resolved, and still finite.
    { steam_appid: 1245620, tags: { "Souls-like": 6994, RPG: 4707, "Action RPG": 3584 },
      genres: ["Action", "RPG"], categories: ["Single-player", "Multi-player"],
      main_story_minutes: 3605, completionist_minutes: 8170 },
    // No tags yet, so nothing to judge on.
    { steam_appid: 1, tags: {}, genres: [], categories: [], main_story_minutes: 600, completionist_minutes: 6000 }
  ];

  const client = {
    from() {
      let pending: Record<string, unknown> | undefined;
      const query: Record<string, unknown> = {
        select: () => query, in: (_k: string, v: number[]) => { if (pending) promoted.push(...v); return query; },
        eq: () => query, not: () => query, neq: () => query, gte: (_k: string, v: unknown) => { reads.push({ since: v }); return query; },
        order: () => query, limit: () => query,
        update: (values: Record<string, unknown>) => { pending = values; return query; },
        then: (resolve: (value: unknown) => unknown) =>
          resolve(pending ? { error: null } : { data: rows, error: null })
      };
      return query;
    }
  };

  const result = await sweepEndlessVerdicts(client as never, { limit: 400 });
  assert.equal(result.examined, 3);
  assert.equal(result.promoted, 1);
  assert.deepEqual(promoted, [359550]);
  // Scoped to recently resolved lengths rather than the whole catalogue.
  assert.equal(reads.length, 1);
  assert.ok(typeof reads[0].since === "string");
});

test("the sweep writes nothing when nothing qualifies", async () => {
  const writes: unknown[] = [];
  const client = {
    from() {
      let pending: unknown;
      const query: Record<string, unknown> = {
        select: () => query, in: () => query, eq: () => query, not: () => query, neq: () => query,
        gte: () => query, order: () => query, limit: () => query,
        update: (v: unknown) => { pending = v; writes.push(v); return query; },
        then: (resolve: (value: unknown) => unknown) => resolve(pending ? { error: null } : { data: [], error: null })
      };
      return query;
    }
  };
  assert.deepEqual(await sweepEndlessVerdicts(client as never), { examined: 0, promoted: 0 });
  assert.deepEqual(writes, []);
});
