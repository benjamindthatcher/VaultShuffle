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

const { promoteIfEndless } = load("lib/endless-sync.ts", {
  "@/lib/game-classification": classification,
  "@/lib/supabase": {}
}) as unknown as {
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
