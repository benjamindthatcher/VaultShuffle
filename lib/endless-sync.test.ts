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

type SweepResult = { examined: number; promoted: number; held: number; pages: number; complete: boolean };
const { promoteIfEndless, sweepEndlessVerdicts } = load("lib/endless-sync.ts", {
  "@/lib/game-classification": classification,
  "@/lib/supabase": {}
}) as unknown as {
  promoteIfEndless: (
    client: unknown,
    steamAppId: number,
    tags: Record<string, number> | null
  ) => Promise<{ promoted: boolean; witnesses: string[] }>;
  sweepEndlessVerdicts: (
    client: unknown,
    options?: { deadlineAt?: number; maxExamined?: number; pageSize?: number }
  ) => Promise<SweepResult>;
};

type Call = { method: string; args: unknown[] };

/**
 * A stand-in for the Supabase query builder that records every call and answers
 * reads from a function, so a test can page, filter and assert on writes without
 * reimplementing PostgREST.
 */
function fakeClient(answer: (calls: Call[]) => unknown) {
  const reads: Call[][] = [];
  const updates: Array<{ values: Record<string, unknown>; calls: Call[] }> = [];
  const client = {
    from() {
      const calls: Call[] = [];
      let values: Record<string, unknown> | undefined;
      const builder: object = new Proxy({}, {
        get(_target, property) {
          if (typeof property !== "string") return undefined;
          if (property === "then") {
            return (resolve: (value: unknown) => unknown) => {
              if (values) {
                updates.push({ values, calls });
                return resolve({ error: null });
              }
              reads.push(calls);
              return resolve({ data: answer(calls), error: null });
            };
          }
          if (property === "maybeSingle") {
            return async () => {
              reads.push(calls);
              return { data: answer(calls), error: null };
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
  return { client, reads, updates };
}

function argOf(calls: Call[], method: string, column?: string) {
  return calls.find((call) => call.method === method && (column === undefined || call.args[0] === column))?.args;
}

const siegeTags = {
  FPS: 9892, PvP: 9194, Tactical: 9103, Multiplayer: 9103, "e-sports": 9102,
  Competitive: 9007, Shooter: 9091, "Hero Shooter": 8901
};
const eldenRingTags = { "Souls-like": 6994, "Open World": 5078, RPG: 4707, "Action RPG": 3584, Multiplayer: 3395 };
const lastEpochTags = {
  "Action RPG": 412, Loot: 348, "Hack and Slash": 300, RPG: 272, Isometric: 206, Multiplayer: 199
};

const finiteRow = {
  genres: ["Action"],
  categories: ["Single-player", "Multi-player", "PvP", "Online PvP"],
  main_story_minutes: 199,
  completionist_minutes: null,
  duration_kind: "finite",
  duration_source: "hltb",
  duration_manual_override: false,
  steam_type: "game"
};

test("a game the tags convict is promoted to endless", async () => {
  const { client, updates } = fakeClient(() => finiteRow);
  const result = await promoteIfEndless(client, 359550, siegeTags);

  assert.equal(result.promoted, true);
  assert.ok(result.witnesses.includes("competitive-loop"));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].values.duration_kind, "endless");
  assert.equal(updates[0].values.duration_source, "classification");
  assert.equal(updates[0].values.duration_status, "ready");
  // The HLTB figure is deliberately kept, not nulled.
  assert.ok(!("main_story_minutes" in updates[0].values));
  // Guarded as `is not true`, which stays correct even if the column ever allows NULL.
  assert.deepEqual(argOf(updates[0].calls, "not", "duration_manual_override"), ["duration_manual_override", "is", true]);
});

test("a person's length ruling is never overturned, flag or no flag", async () => {
  const held = [
    { ...finiteRow, duration_manual_override: true },
    // New World Playtest: ruled by hand, the flag never set.
    { ...finiteRow, duration_kind: "not-applicable", duration_source: "manual-classification" },
    { ...finiteRow, duration_source: "manual-classification" },
    // not-applicable protects itself whatever wrote it.
    { ...finiteRow, duration_kind: "not-applicable", duration_source: "steam-tags" },
    { ...finiteRow, duration_kind: "endless", duration_source: "classification" }
  ];
  for (const row of held) {
    const { client, updates } = fakeClient(() => row);
    assert.equal((await promoteIfEndless(client, 1724660, siegeTags)).promoted, false, JSON.stringify(row));
    assert.deepEqual(updates, []);
  }
});

test("demos and DLC are not given a length verdict", async () => {
  const { client, updates } = fakeClient(() => ({ ...finiteRow, steam_type: "dlc" }));
  assert.equal((await promoteIfEndless(client, 359550, siegeTags)).promoted, false);
  assert.deepEqual(updates, []);
});

test("nothing is written for a game the rule clears, with no tags yet, or missing from the catalogue", async () => {
  const eldenRing = fakeClient(() => ({
    ...finiteRow, genres: ["Action", "RPG"], main_story_minutes: 3605, completionist_minutes: 8170
  }));
  assert.equal((await promoteIfEndless(eldenRing.client, 1245620, eldenRingTags)).promoted, false);
  assert.deepEqual(eldenRing.updates, []);

  const untagged = fakeClient(() => finiteRow);
  assert.equal((await promoteIfEndless(untagged.client, 1, {})).promoted, false);
  assert.deepEqual(untagged.reads, []);

  const missing = fakeClient(() => null);
  assert.equal((await promoteIfEndless(missing.client, 999999, siegeTags)).promoted, false);
  assert.deepEqual(missing.updates, []);
});

const sweepCatalogue = [
  { steam_appid: 100, tags: siegeTags, genres: ["Action"], categories: ["Single-player", "Multi-player", "PvP"],
    main_story_minutes: 199, completionist_minutes: null,
    duration_kind: "unknown", duration_source: null, duration_manual_override: false },
  { steam_appid: 200, tags: eldenRingTags, genres: ["Action", "RPG"], categories: ["Single-player", "Multi-player"],
    main_story_minutes: 3605, completionist_minutes: 8170,
    duration_kind: "finite", duration_source: "hltb", duration_manual_override: false },
  // Would qualify on its tags, but a person ruled on it.
  { steam_appid: 300, tags: siegeTags, genres: ["Action"], categories: ["Single-player", "Multi-player", "PvP"],
    main_story_minutes: 199, completionist_minutes: null,
    duration_kind: "finite", duration_source: "manual-classification", duration_manual_override: false },
  { steam_appid: 400, tags: {}, genres: [], categories: [], main_story_minutes: 600, completionist_minutes: 6000,
    duration_kind: "unknown", duration_source: null, duration_manual_override: false },
  // Tags from a bulk import: a loot loop nothing had judged.
  { steam_appid: 500, tags: lastEpochTags, genres: ["RPG", "Action"], categories: ["Single-player", "Multi-player", "Co-op"],
    main_story_minutes: 1370, completionist_minutes: 5056,
    duration_kind: "finite", duration_source: "hltb", duration_manual_override: false }
];

/** Answers reads the way the database would: AppIDs after the cursor, in order, up to the limit. */
function pagedCatalogue(rows: typeof sweepCatalogue) {
  return (calls: Call[]) => {
    const cursor = Number(argOf(calls, "gt", "steam_appid")?.[1] ?? 0);
    const limit = Number(argOf(calls, "limit")?.[0] ?? Infinity);
    return rows.filter((row) => row.steam_appid > cursor).slice(0, limit);
  };
}

test("the sweep judges every recently changed game, page by page, whether its tags or its length changed", async () => {
  const { client, reads, updates } = fakeClient(pagedCatalogue(sweepCatalogue));
  const result = await sweepEndlessVerdicts(client, { pageSize: 2 });

  assert.deepEqual(result, { examined: 5, promoted: 2, held: 1, pages: 3, complete: true });
  // Keyset paging: each page starts after the last AppID the previous one saw.
  assert.deepEqual(reads.map((calls) => argOf(calls, "gt", "steam_appid")?.[1]), [0, 200, 400]);
  // Either change counts, so a bulk tag import and an HLTB writeback are both seen.
  const window = String(argOf(reads[0], "or")?.[0]);
  assert.match(window, /tags_fetched_at\.gte\./);
  assert.match(window, /duration_source_updated_at\.gte\./);

  assert.equal(updates.length, 1);
  assert.deepEqual(argOf(updates[0].calls, "in", "steam_appid")?.[1], [100, 500]);
  assert.equal(updates[0].values.duration_kind, "endless");
  assert.deepEqual(argOf(updates[0].calls, "in", "duration_kind")?.[1], ["finite", "unknown"]);
  assert.deepEqual(argOf(updates[0].calls, "not", "duration_manual_override"), ["duration_manual_override", "is", true]);
});

test("the sweep stops at its deadline or its cap, and says it did not finish", async () => {
  const late = fakeClient(pagedCatalogue(sweepCatalogue));
  assert.deepEqual(
    await sweepEndlessVerdicts(late.client, { deadlineAt: Date.now() - 1 }),
    { examined: 0, promoted: 0, held: 0, pages: 0, complete: false }
  );
  assert.deepEqual(late.updates, []);

  const capped = fakeClient(pagedCatalogue(sweepCatalogue));
  const result = await sweepEndlessVerdicts(capped.client, { pageSize: 2, maxExamined: 3 });
  assert.equal(result.examined, 3);
  assert.equal(result.complete, false);
  assert.equal(result.promoted, 1);
});

test("the sweep writes nothing when nothing changed", async () => {
  const { client, updates } = fakeClient(() => []);
  assert.deepEqual(await sweepEndlessVerdicts(client), { examined: 0, promoted: 0, held: 0, pages: 1, complete: true });
  assert.deepEqual(updates, []);
});
