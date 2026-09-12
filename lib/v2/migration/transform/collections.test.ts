import assert from "node:assert/strict";
import test from "node:test";
import { M3GTransformError } from "./commitments-shared.ts";
import {
  transformCollections,
  type CollectionMembershipSourceRow,
  type CollectionSourceRow,
  type CollectionTransformInput,
} from "./collections.ts";

/* -------------------------------------------------------------------------
 * Fixtures. Every expectation below is written out by hand rather than
 * recomputed with the transform's own helpers.
 * ---------------------------------------------------------------------- */

const SNAPSHOT = "a1".repeat(32);
const FOREIGN_SNAPSHOT = "b2".repeat(32);
const RUN = Object.freeze({ runId: "m3g-collections-test", snapshotHash: SNAPSHOT });

function uuid(tag: string): string {
  const body = tag.padStart(12, "0");
  return `00000000-0000-4000-8000-${body}`;
}

const ACCOUNT_A_LEGACY = uuid("a1");
const ACCOUNT_B_LEGACY = uuid("b1");
const COLLECTION_1 = uuid("c1");
const COLLECTION_2 = uuid("c2");
const COLLECTION_3 = uuid("c3");
const GAME_1 = uuid("d1");
const GAME_2 = uuid("d2");
const GAME_3 = uuid("d3");
const GAME_4 = uuid("d4");
const GAME_B1 = uuid("e1");

const ACCOUNT_MAP = Object.freeze([
  Object.freeze({ legacy_id: ACCOUNT_A_LEGACY, account_id: 7, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: ACCOUNT_B_LEGACY, account_id: 9, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT }),
]);

const LIBRARY_ROW_MAP = Object.freeze([
  Object.freeze({ legacy_id: GAME_1, account_id: 7, game_id: 101, steam_appid: "440", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: GAME_2, account_id: 7, game_id: 102, steam_appid: "570", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: GAME_3, account_id: 7, game_id: 103, steam_appid: "620", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: GAME_4, account_id: 7, game_id: 104, steam_appid: "730", source_snapshot_hash: SNAPSHOT }),
  // The same AppID owned by a second account resolves to the same catalogue
  // game through a different per-account library row.
  Object.freeze({ legacy_id: GAME_B1, account_id: 9, game_id: 101, steam_appid: "440", source_snapshot_hash: SNAPSHOT }),
]);

function collectionRow(overrides: Partial<CollectionSourceRow> = {}): CollectionSourceRow {
  return {
    id: COLLECTION_1,
    user_id: ACCOUNT_A_LEGACY,
    name: "Weekend picks",
    description: "Short games",
    created_at: "2026-01-02 03:04:05.123456+00",
    updated_at: "2026-02-03 04:05:06.654321+00",
    kind: "custom",
    rules: "{}",
    ...overrides,
  };
}

function memberRow(overrides: Partial<CollectionMembershipSourceRow> = {}): CollectionMembershipSourceRow {
  return {
    collection_id: COLLECTION_1,
    game_id: GAME_1,
    notes: null,
    position: "0",
    created_at: "2026-01-02 03:04:05+00",
    ...overrides,
  };
}

function input(overrides: Partial<CollectionTransformInput> = {}): CollectionTransformInput {
  return {
    runIdentity: RUN,
    accountMap: ACCOUNT_MAP,
    libraryRowMap: LIBRARY_ROW_MAP,
    collections: [collectionRow()],
    collectionGames: [],
    ...overrides,
  };
}

function failure(run: () => unknown): M3GTransformError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof M3GTransformError, `expected M3GTransformError, received ${String(error)}`);
    return error;
  }
  assert.fail("expected an M3GTransformError");
}

function code(run: () => unknown): string {
  return failure(run).m3gCode;
}

/* -------------------------------------------------------------------------
 * Collections
 * ---------------------------------------------------------------------- */

test("retains the collection public UUID verbatim and mints a bigint identity", () => {
  const upper = COLLECTION_1.toUpperCase();
  const result = transformCollections(input({ collections: [collectionRow({ id: upper })] }));
  assert.equal(result.collections.length, 1);
  assert.equal(result.collections[0].public_id, upper, "the source text is not re-cased");
  assert.equal(result.collections[0].id, 1);
  assert.equal(result.collections[0].account_id, 7);
  assert.deepEqual(result.collection_map, [
    { legacy_id: upper, account_id: 7, collection_id: 1, source_snapshot_hash: SNAPSHOT },
  ]);
});

test("numbers collections deterministically by account, creation instant, then UUID", () => {
  const rows = [
    collectionRow({ id: COLLECTION_3, user_id: ACCOUNT_B_LEGACY, created_at: "2020-01-01 00:00:00+00" }),
    collectionRow({ id: COLLECTION_2, user_id: ACCOUNT_A_LEGACY, created_at: "2026-05-05 05:05:05+00" }),
    collectionRow({ id: COLLECTION_1, user_id: ACCOUNT_A_LEGACY, created_at: "2026-05-05 05:05:05+00" }),
  ];
  const result = transformCollections(input({ collections: rows }));
  // Account 7 sorts before account 9; within account 7 the two share an
  // instant, so the canonical UUID decides and c1 precedes c2.
  assert.deepEqual(
    result.collections.map((row) => [row.id, row.public_id, row.account_id]),
    [
      [1, COLLECTION_1, 7],
      [2, COLLECTION_2, 7],
      [3, COLLECTION_3, 9],
    ],
  );
});

test("produces the same numbering under every input permutation", () => {
  const rows = [
    collectionRow({ id: COLLECTION_1, created_at: "2026-01-01 00:00:00+00" }),
    collectionRow({ id: COLLECTION_2, created_at: "2026-01-01 00:00:01+00" }),
    collectionRow({ id: COLLECTION_3, user_id: ACCOUNT_B_LEGACY, created_at: "2025-01-01 00:00:00+00" }),
  ];
  const baseline = JSON.stringify(transformCollections(input({ collections: rows })));
  const permutations = [
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of permutations) {
    const permuted = order.map((index) => rows[index]);
    assert.equal(JSON.stringify(transformCollections(input({ collections: permuted }))), baseline);
  }
});

test("orders two collections written at the same instant in different offsets by UUID", () => {
  const rows = [
    collectionRow({ id: COLLECTION_2, created_at: "2025-12-31 19:00:00-05" }),
    collectionRow({ id: COLLECTION_1, created_at: "2026-01-01 00:00:00+00" }),
  ];
  const result = transformCollections(input({ collections: rows }));
  assert.equal(result.collections[0].created_at.epochMicros, result.collections[1].created_at.epochMicros);
  assert.deepEqual(result.collections.map((row) => row.public_id), [COLLECTION_1, COLLECTION_2]);
});

test("keeps the source timestamps exactly, to the microsecond", () => {
  const result = transformCollections(input());
  assert.equal(result.collections[0].created_at.canonicalUtc, "2026-01-02T03:04:05.123456Z");
  assert.equal(result.collections[0].updated_at.canonicalUtc, "2026-02-03T04:05:06.654321Z");
  assert.equal(result.collections[0].created_at.sourceText, "2026-01-02 03:04:05.123456+00");
});

test("preserves a long name and description without truncation", () => {
  const name = "n".repeat(200);
  const description = "d".repeat(2000);
  const result = transformCollections(input({ collections: [collectionRow({ name, description })] }));
  assert.equal(result.collections[0].name, name);
  assert.equal(result.collections[0].description, description);
});

test("refuses over-length metadata instead of trimming it", () => {
  assert.equal(code(() => transformCollections(input({ collections: [collectionRow({ name: "n".repeat(201) })] }))), "m3g_invalid_text");
  assert.equal(
    code(() => transformCollections(input({ collections: [collectionRow({ description: "d".repeat(2001) })] }))),
    "m3g_invalid_text",
  );
  assert.equal(code(() => transformCollections(input({ collections: [collectionRow({ name: "   " })] }))), "m3g_invalid_text");
});

test("counts the name bound in characters, as PostgreSQL length does", () => {
  // 200 astral code points are 400 UTF-16 units; the target accepts them.
  const name = "\u{1F600}".repeat(200);
  const result = transformCollections(input({ collections: [collectionRow({ name })] }));
  assert.equal(result.collections[0].name, name);
  assert.equal(
    code(() => transformCollections(input({ collections: [collectionRow({ name: "\u{1F600}".repeat(201) })] }))),
    "m3g_invalid_text",
  );
});

test("normalises an empty description to NULL and keeps a blank-but-present one", () => {
  const empty = transformCollections(input({ collections: [collectionRow({ description: "" })] }));
  assert.equal(empty.collections[0].description, null);
  const blank = transformCollections(input({ collections: [collectionRow({ description: " " })] }));
  assert.equal(blank.collections[0].description, " ");
  const missing = transformCollections(input({ collections: [collectionRow({ description: null })] }));
  assert.equal(missing.collections[0].description, null);
});

test("carries the rules document through as opaque text", () => {
  // 1.10 and 1.1 are the same double and different jsonb numerics. Neither is
  // re-serialised, so the trailing zero and the big integer both survive.
  const rules = '{"threshold": 1.10, "floor": 9007199254740993}';
  const result = transformCollections(input({ collections: [collectionRow({ kind: "smart", rules })] }));
  assert.equal(result.collections[0].rules, rules);
  assert.equal(result.collections[0].collection_kind, "smart");
});

test("accepts a custom collection with an empty rules object", () => {
  const result = transformCollections(input({ collections: [collectionRow({ rules: "{}" })] }));
  assert.equal(result.collections[0].rules, "{}");
  assert.deepEqual(result.conflicts, []);
});

test("refuses a smart collection with no rules and reports a custom one", () => {
  assert.equal(
    code(() => transformCollections(input({ collections: [collectionRow({ kind: "smart", rules: null })] }))),
    "m3g_smart_collection_without_rules",
  );
  const custom = transformCollections(input({ collections: [collectionRow({ kind: "custom", rules: null })] }));
  assert.equal(custom.collections[0].rules, null);
  assert.deepEqual(
    custom.conflicts.map((row) => [row.conflict_class, row.source_column, row.conflict_count]),
    [["collection_rules_missing", "rules", 1]],
  );
});

test("refuses a rules document that is not an object, and a malformed one", () => {
  assert.equal(code(() => transformCollections(input({ collections: [collectionRow({ rules: "[1,2]" })] }))), "m3g_invalid_json");
  assert.equal(code(() => transformCollections(input({ collections: [collectionRow({ rules: "{oops}" })] }))), "m3g_invalid_json");
  assert.equal(code(() => transformCollections(input({ collections: [collectionRow({ rules: "3" })] }))), "m3g_invalid_json");
});

test("reports an over-size rules document as an advisory the loader must confirm", () => {
  const filler = "x".repeat(16_400);
  const rules = `{"k":"${filler}"}`;
  const result = transformCollections(input({ collections: [collectionRow({ rules })] }));
  assert.equal(result.collections[0].rules, rules, "the document is never trimmed");
  assert.equal(result.size_advisories.length, 1);
  assert.deepEqual(result.size_advisories[0], {
    relation: "app.collections",
    column: "rules",
    public_id: COLLECTION_1,
    utf8_bytes: rules.length,
    pg_column_size_bound: 16_384,
    bound_source: "M1:357 check (rules is null or pg_column_size(rules) <= 16384)",
    requires_sql_validation: true,
  });
  const advisory = result.conflicts.find((row) => row.conflict_class === "collection_rules_size_advisory");
  assert.ok(advisory);
  assert.equal(advisory.details.requires_sql_validation, true);
});

test("refuses an unknown collection kind rather than coercing it to custom", () => {
  assert.equal(code(() => transformCollections(input({ collections: [collectionRow({ kind: "dynamic" })] }))), "m3g_invalid_enum");
  assert.equal(code(() => transformCollections(input({ collections: [collectionRow({ kind: "Custom" })] }))), "m3g_invalid_enum");
});

test("refuses a duplicate or malformed collection identity", () => {
  assert.equal(
    code(() => transformCollections(input({ collections: [collectionRow(), collectionRow({ name: "Other" })] }))),
    "m3g_duplicate_identity",
  );
  assert.equal(
    code(() =>
      transformCollections(input({ collections: [collectionRow(), collectionRow({ id: COLLECTION_1.toUpperCase() })] })),
    ),
    "m3g_duplicate_identity",
  );
  assert.equal(code(() => transformCollections(input({ collections: [collectionRow({ id: "not-a-uuid" })] }))), "m3g_invalid_uuid");
});

test("refuses a collection whose owner is not in the same-run account map", () => {
  assert.equal(
    code(() => transformCollections(input({ collections: [collectionRow({ user_id: uuid("f9") })] }))),
    "m3g_account_unmapped",
  );
});

/* -------------------------------------------------------------------------
 * Membership positions
 * ---------------------------------------------------------------------- */

test("carries legal position gaps through unchanged", () => {
  const members = [
    memberRow({ game_id: GAME_1, position: "0" }),
    memberRow({ game_id: GAME_2, position: "5" }),
    memberRow({ game_id: GAME_3, position: "9" }),
  ];
  const result = transformCollections(input({ collectionGames: members }));
  assert.deepEqual(
    result.collection_games.map((row) => [row.game_id, row.position, row.legacy_position, row.position_resolution]),
    [
      [101, 0, 0, "source"],
      [102, 5, 5, "source"],
      [103, 9, 9, "source"],
    ],
  );
  assert.deepEqual(result.conflicts, []);
});

test("resolves duplicate positions into the nearest free integer above", () => {
  // Source: d1@0, d2@0, d3@1, d4@3. Stable order is (0,d1),(0,d2),(1,d3),(3,d4).
  // d1 keeps 0. d2 cannot keep 0; 1 is another member's source position, so 2.
  // d3 keeps 1 and d4 keeps 3.
  const members = [
    memberRow({ game_id: GAME_4, position: "3" }),
    memberRow({ game_id: GAME_2, position: "0" }),
    memberRow({ game_id: GAME_3, position: "1" }),
    memberRow({ game_id: GAME_1, position: "0" }),
  ];
  const result = transformCollections(input({ collectionGames: members }));
  assert.deepEqual(
    result.collection_games.map((row) => [row.game_id, row.position, row.legacy_position, row.position_resolution]),
    [
      [101, 0, 0, "source"],
      [103, 1, 1, "source"],
      [102, 2, 0, "stable_reorder"],
      [104, 3, 3, "source"],
    ],
  );
  assert.equal(result.collection_games.length, 4, "no member is dropped");
  const conflict = result.conflicts.find((row) => row.conflict_class === "collection_duplicate_position");
  assert.ok(conflict);
  assert.equal(conflict.conflict_count, 1);
  assert.equal(conflict.source_relation, "collection_games");
});

test("breaks a duplicate position by recorded original order before identity", () => {
  // d1 sorts before d2 by UUID, but d2 carries the earlier recorded order, so
  // d2 keeps position 0 and d1 is the one displaced.
  const members = [
    memberRow({ game_id: GAME_1, position: "0", source_order: "5" }),
    memberRow({ game_id: GAME_2, position: "0", source_order: "2" }),
  ];
  const result = transformCollections(input({ collectionGames: members }));
  assert.deepEqual(
    result.collection_games.map((row) => [row.game_id, row.position, row.legacy_order, row.position_resolution]),
    [
      [102, 0, "2", "source"],
      [101, 1, "5", "stable_reorder"],
    ],
  );
});

test("sorts a member with no order evidence after one that has it", () => {
  const members = [
    memberRow({ game_id: GAME_2, position: "0" }),
    memberRow({ game_id: GAME_1, position: "0", source_order: "9" }),
  ];
  const result = transformCollections(input({ collectionGames: members }));
  assert.deepEqual(
    result.collection_games.map((row) => [row.game_id, row.position, row.legacy_order]),
    [
      [101, 0, "9"],
      [102, 1, null],
    ],
  );
});

test("resolves a three-way duplicate deterministically", () => {
  // d1,d2,d3 all at 4. d1 keeps 4, d2 takes 5, d3 takes 6.
  const members = [
    memberRow({ game_id: GAME_3, position: "4" }),
    memberRow({ game_id: GAME_1, position: "4" }),
    memberRow({ game_id: GAME_2, position: "4" }),
  ];
  const result = transformCollections(input({ collectionGames: members }));
  assert.deepEqual(
    result.collection_games.map((row) => [row.game_id, row.position, row.position_resolution]),
    [
      [101, 4, "source"],
      [102, 5, "stable_reorder"],
      [103, 6, "stable_reorder"],
    ],
  );
  const conflict = result.conflicts.find((row) => row.conflict_class === "collection_duplicate_position");
  assert.equal(conflict?.conflict_count, 2);
});

test("resolves duplicate positions independently per collection", () => {
  const collections = [collectionRow({ id: COLLECTION_1 }), collectionRow({ id: COLLECTION_2 })];
  const members = [
    memberRow({ collection_id: COLLECTION_1, game_id: GAME_1, position: "0" }),
    memberRow({ collection_id: COLLECTION_2, game_id: GAME_2, position: "0" }),
  ];
  const result = transformCollections(input({ collections, collectionGames: members }));
  assert.deepEqual(
    result.collection_games.map((row) => [row.collection_id, row.game_id, row.position, row.position_resolution]),
    [
      [1, 101, 0, "source"],
      [2, 102, 0, "source"],
    ],
  );
});

test("records original position evidence for every member, duplicate or not", () => {
  const members = [
    memberRow({ game_id: GAME_1, position: "0", notes: "keep" }),
    memberRow({ game_id: GAME_2, position: "0" }),
    memberRow({ game_id: GAME_3, position: "7" }),
  ];
  const result = transformCollections(input({ collectionGames: members }));
  assert.deepEqual(
    result.membership_evidence.map((row) => [
      row.source_game_id,
      row.source_position,
      row.position_resolution,
      row.conflict_group,
      row.source_notes,
      row.retention_class,
    ]),
    [
      [GAME_1, 0, "source", "position:0", "keep", "staging-30d-post-cutover"],
      [GAME_2, 0, "stable_reorder", "position:0", null, "staging-30d-post-cutover"],
      [GAME_3, 7, "source", null, null, "staging-30d-post-cutover"],
    ],
  );
  assert.equal(result.membership_evidence.length, result.collection_games.length);
  for (const row of result.membership_evidence) {
    assert.equal(row.account_id, 7);
    assert.equal(row.collection_id, 1);
    assert.equal(row.source_snapshot_hash, SNAPSHOT);
  }
});

test("keeps the original membership instant apart from the runtime clock", () => {
  const members = [memberRow({ created_at: "2024-07-08 09:10:11.000001+00" })];
  const result = transformCollections(input({ collectionGames: members }));
  assert.equal(result.collection_games[0].legacy_created_at.canonicalUtc, "2024-07-08T09:10:11.000001Z");
  assert.equal(result.membership_evidence[0].source_created_at.canonicalUtc, "2024-07-08T09:10:11.000001Z");
});

test("refuses a negative or malformed source position", () => {
  assert.equal(code(() => transformCollections(input({ collectionGames: [memberRow({ position: "-1" })] }))), "m3g_invalid_integer");
  assert.equal(code(() => transformCollections(input({ collectionGames: [memberRow({ position: "1.5" })] }))), "m3g_invalid_integer");
  assert.equal(code(() => transformCollections(input({ collectionGames: [memberRow({ position: "" })] }))), "m3g_invalid_integer");
});

test("refuses a resolved position that would overflow the integer column", () => {
  const members = [
    memberRow({ game_id: GAME_1, position: "2147483647" }),
    memberRow({ game_id: GAME_2, position: "2147483647" }),
  ];
  assert.equal(code(() => transformCollections(input({ collectionGames: members }))), "m3g_target_overflow");
});

/* -------------------------------------------------------------------------
 * Membership notes and references
 * ---------------------------------------------------------------------- */

test("preserves a nonempty note and normalises an empty one", () => {
  const note = "n".repeat(10_000);
  const kept = transformCollections(input({ collectionGames: [memberRow({ notes: note })] }));
  assert.equal(kept.collection_games[0].note, note);
  assert.equal(kept.membership_evidence[0].source_notes, note);
  const empty = transformCollections(input({ collectionGames: [memberRow({ notes: "" })] }));
  assert.equal(empty.collection_games[0].note, null);
  assert.equal(empty.membership_evidence[0].source_notes, "", "the archive keeps the original empty string");
});

test("refuses an over-length note rather than truncating it", () => {
  assert.equal(
    code(() => transformCollections(input({ collectionGames: [memberRow({ notes: "n".repeat(10_001) })] }))),
    "m3g_invalid_text",
  );
});

test("retains a member without consulting current ownership", () => {
  // The input carries no ownership, playtime or availability signal at all:
  // identity through the library-row map is the only question asked.
  const result = transformCollections(input({ collectionGames: [memberRow({ game_id: GAME_3 })] }));
  assert.equal(result.collection_games.length, 1);
  assert.equal(result.collection_games[0].game_id, 103);
});

test("refuses a member whose library row is not mapped", () => {
  assert.equal(
    code(() => transformCollections(input({ collectionGames: [memberRow({ game_id: uuid("ff") })] }))),
    "m3g_library_unmapped",
  );
});

test("refuses a member pointing at another account's library row", () => {
  // GAME_B1 belongs to account 9; COLLECTION_1 belongs to account 7.
  assert.equal(
    code(() => transformCollections(input({ collectionGames: [memberRow({ game_id: GAME_B1 })] }))),
    "m3g_cross_tenant_reference",
  );
});

test("keeps the same AppID separate per owner", () => {
  const collections = [
    collectionRow({ id: COLLECTION_1, user_id: ACCOUNT_A_LEGACY }),
    collectionRow({ id: COLLECTION_2, user_id: ACCOUNT_B_LEGACY, created_at: "2026-06-06 06:06:06+00" }),
  ];
  const members = [
    memberRow({ collection_id: COLLECTION_1, game_id: GAME_1, position: "0" }),
    memberRow({ collection_id: COLLECTION_2, game_id: GAME_B1, position: "0" }),
  ];
  const result = transformCollections(input({ collections, collectionGames: members }));
  assert.deepEqual(
    result.collection_games.map((row) => [row.account_id, row.collection_id, row.game_id, row.position]),
    [
      [7, 1, 101, 0],
      [9, 2, 101, 0],
    ],
  );
});

test("refuses a member of an unknown collection", () => {
  assert.equal(
    code(() => transformCollections(input({ collectionGames: [memberRow({ collection_id: COLLECTION_3 })] }))),
    "m3g_collection_unmapped",
  );
});

test("refuses the same game twice in one collection", () => {
  const members = [memberRow({ game_id: GAME_1, position: "0" }), memberRow({ game_id: GAME_1, position: "1" })];
  assert.equal(code(() => transformCollections(input({ collectionGames: members }))), "m3g_duplicate_identity");
});

test("accepts the same game in two collections of one account", () => {
  const collections = [collectionRow({ id: COLLECTION_1 }), collectionRow({ id: COLLECTION_2 })];
  const members = [
    memberRow({ collection_id: COLLECTION_1, game_id: GAME_1 }),
    memberRow({ collection_id: COLLECTION_2, game_id: GAME_1 }),
  ];
  const result = transformCollections(input({ collections, collectionGames: members }));
  assert.equal(result.collection_games.length, 2);
});

/* -------------------------------------------------------------------------
 * Run identity, bounds and safe errors
 * ---------------------------------------------------------------------- */

test("requires an explicit, well-formed run identity", () => {
  assert.equal(code(() => transformCollections(input({ runIdentity: undefined as never }))), "m3g_run_invalid");
  assert.equal(
    code(() => transformCollections(input({ runIdentity: { runId: "r", snapshotHash: "short" } as never }))),
    "m3g_run_invalid",
  );
});

test("refuses a row tagged with another run", () => {
  assert.equal(
    code(() => transformCollections(input({ collections: [{ ...collectionRow(), snapshot_hash: FOREIGN_SNAPSHOT }] }))),
    "m3g_mixed_run_identity",
  );
  assert.equal(
    code(() =>
      transformCollections(
        input({ collectionGames: [{ ...memberRow(), run_id: "another-run" } as CollectionMembershipSourceRow] }),
      ),
    ),
    "m3g_mixed_run_identity",
  );
});

test("refuses a map from another snapshot", () => {
  const foreignAccounts = [{ ...ACCOUNT_MAP[0], source_snapshot_hash: FOREIGN_SNAPSHOT }];
  assert.equal(code(() => transformCollections(input({ accountMap: foreignAccounts }))), "m3g_account_map_invalid");
  const foreignLibrary = [{ ...LIBRARY_ROW_MAP[0], source_snapshot_hash: FOREIGN_SNAPSHOT }];
  assert.equal(code(() => transformCollections(input({ libraryRowMap: foreignLibrary }))), "m3g_mixed_run_identity");
});

test("refuses a library map that reuses one account/game pair", () => {
  const broken = [
    { legacy_id: GAME_1, account_id: 7, game_id: 101, steam_appid: "440", source_snapshot_hash: SNAPSHOT },
    { legacy_id: GAME_2, account_id: 7, game_id: 101, steam_appid: "570", source_snapshot_hash: SNAPSHOT },
  ];
  assert.equal(code(() => transformCollections(input({ libraryRowMap: broken }))), "m3g_duplicate_identity");
});

test("enforces explicit row bounds", () => {
  assert.equal(
    code(() => transformCollections(input({ collections: [collectionRow()] }), { maxCollections: 0 })),
    "m3g_row_limit",
  );
  assert.equal(
    code(() => transformCollections(input({ collectionGames: [memberRow()] }), { maxMembers: 0 })),
    "m3g_row_limit",
  );
});

test("refuses a missing cell rather than treating it as NULL", () => {
  const row = { ...collectionRow() } as Record<string, unknown>;
  delete row.name;
  assert.equal(code(() => transformCollections(input({ collections: [row as CollectionSourceRow] }))), "m3g_input_invalid");
});

test("keeps every private value out of the failure", () => {
  const secretName = "Ben's private shelf";
  const error = failure(() =>
    transformCollections(input({ collections: [collectionRow({ name: secretName + "x".repeat(300) })] })),
  );
  const serialised = JSON.stringify(error.toJSON()) + error.message;
  assert.ok(!serialised.includes("private shelf"));
  assert.ok(!serialised.includes(COLLECTION_1));
  assert.ok(!serialised.includes(ACCOUNT_A_LEGACY));
  assert.deepEqual(error.diagnostics, [{ code: "m3g_invalid_text", relation: "collections", field: "name", count: 1 }]);
});

test("starts the identity sequence where the caller says", () => {
  const result = transformCollections(input(), { startCollectionId: 5000 });
  assert.equal(result.collections[0].id, 5000);
  assert.equal(result.collection_map[0].collection_id, 5000);
});

test("returns the run identity it was given", () => {
  const result = transformCollections(input());
  assert.deepEqual(result.run_identity, { run_id: RUN.runId, snapshot_hash: SNAPSHOT });
});
