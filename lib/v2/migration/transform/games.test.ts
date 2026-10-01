import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGameMapRunIdentity,
  buildGameMap,
  canonicalGameMap,
  catalogueStubTitle,
  gameMapEntryKind,
  GameMapError,
  hasGameId,
  lookupGameId,
  STEAM_APP_ID_MAX,
  validateGameStubTargetRecord,
  type CatalogueStubEvidence,
  type GameMap,
  type GameMapInput,
  type GameReferenceRow,
  type GameStubTargetRecord,
} from "./games.ts";

const RUN = Object.freeze({ runId: "catalogue-test-run", snapshotHash: "b".repeat(64) });
const OTHER_RUN = Object.freeze({ runId: "catalogue-other-run", snapshotHash: "c".repeat(64) });

function input(overrides: Partial<GameMapInput> = {}): GameMapInput {
  return {
    runIdentity: RUN,
    catalogueGames: [],
    ...overrides,
  } as GameMapInput;
}

function catalogue(...appIds: (string | null)[]) {
  return appIds.map((steam_appid) => ({ steam_appid }));
}

function reference(relation: string, field: string, steam_appid: string | null): GameReferenceRow {
  return { relation, field, steam_appid };
}

function stub(steam_appid: string | null, overrides: Partial<CatalogueStubEvidence> = {}): CatalogueStubEvidence {
  return {
    steam_appid,
    title_provenance: "catalog_stub_fallback",
    required_by_relation: "completion_events",
    required_by_field: "steam_appid",
    reason: "resolved completion event with no catalogue row",
    ...overrides,
  } as CatalogueStubEvidence;
}

function failureCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof GameMapError, `expected GameMapError, received ${String(error)}`);
    return error.gameMapCode;
  }
  assert.fail("expected a GameMapError");
}

/* -------------------------------------------------------------------------
 * Deterministic numbering over the complete union
 * ---------------------------------------------------------------------- */

test("numbers the complete AppID union in ascending numeric order", () => {
  const result = buildGameMap(input({ catalogueGames: catalogue("70", "10", "4294967295", "220") }));
  // Expected by hand from the contract: sort numerically, then assign 1..N.
  assert.deepEqual(
    result.map.entries.map((entry) => [entry.legacy_app_id, entry.game_id]),
    [
      ["10", 1],
      ["70", 2],
      ["220", 3],
      ["4294967295", 4],
    ],
  );
  assert.equal(result.counts.mapped_identities, 4);
  assert.equal(result.counts.catalogue_identities, 4);
  assert.equal(result.counts.stub_identities, 0);
});

test("sorts numerically, not lexicographically", () => {
  // Lexicographic order would put "1000" before "9"; numeric order must not.
  const result = buildGameMap(input({ catalogueGames: catalogue("9", "1000", "10", "100000") }));
  assert.deepEqual(
    result.map.entries.map((entry) => entry.legacy_app_id),
    ["9", "10", "1000", "100000"],
  );
});

test("permuted input order produces an identical map", () => {
  const appIds = ["731", "2", "999999", "17", "4294967294", "1"];
  const forward = buildGameMap(input({ catalogueGames: catalogue(...appIds) }));
  const reversed = buildGameMap(input({ catalogueGames: catalogue(...[...appIds].reverse()) }));
  const shuffled = buildGameMap(input({ catalogueGames: catalogue("17", "4294967294", "1", "999999", "731", "2") }));
  assert.equal(canonicalGameMap(forward.map), canonicalGameMap(reversed.map));
  assert.equal(canonicalGameMap(forward.map), canonicalGameMap(shuffled.map));
});

test("reference order never changes the assigned identities", () => {
  const games = catalogue("500", "300", "400");
  const withReferences = buildGameMap(
    input({
      catalogueGames: games,
      references: [
        reference("user_games", "catalog_steam_appid", "500"),
        reference("vault_draws", "steam_appid", "300"),
        reference("user_games", "catalog_steam_appid", "400"),
      ],
    }),
  );
  const withoutReferences = buildGameMap(input({ catalogueGames: games }));
  assert.equal(canonicalGameMap(withReferences.map), canonicalGameMap(withoutReferences.map));
  assert.equal(withReferences.counts.resolved_references, 3);
});

test("the same AppID referenced by many accounts maps once", () => {
  const result = buildGameMap(
    input({
      catalogueGames: catalogue("620"),
      references: [
        reference("user_games", "catalog_steam_appid", "620"),
        reference("user_games", "catalog_steam_appid", "620"),
        reference("user_game_state", "appid", "620"),
        reference("completion_events", "steam_appid", "620"),
      ],
    }),
  );
  assert.equal(result.map.entries.length, 1);
  assert.equal(result.counts.resolved_references, 4);
  assert.equal(lookupGameId(result.map, "620"), 1);
});

test("every entry carries the run snapshot hash and the map carries the run identity", () => {
  const result = buildGameMap(input({ catalogueGames: catalogue("10", "20") }));
  assert.deepEqual(result.map.run_identity, { run_id: RUN.runId, snapshot_hash: RUN.snapshotHash });
  for (const entry of result.map.entries) {
    assert.equal(entry.source_snapshot_hash, RUN.snapshotHash);
    assert.equal(entry.source_kind, "catalog_games");
  }
});

/* -------------------------------------------------------------------------
 * AppID bounds and exact text
 * ---------------------------------------------------------------------- */

test("accepts the exact unsigned 32-bit AppID boundaries", () => {
  const result = buildGameMap(input({ catalogueGames: catalogue("1", STEAM_APP_ID_MAX.toString(10)) }));
  assert.deepEqual(
    result.map.entries.map((entry) => entry.legacy_app_id),
    ["1", "4294967295"],
  );
});

test("rejects AppIDs outside 1..4294967295", () => {
  assert.equal(failureCode(() => buildGameMap(input({ catalogueGames: catalogue("0") }))), "game_map_app_id_out_of_range");
  assert.equal(
    failureCode(() => buildGameMap(input({ catalogueGames: catalogue("4294967296") }))),
    "game_map_app_id_out_of_range",
  );
  assert.equal(failureCode(() => buildGameMap(input({ catalogueGames: catalogue("-1") }))), "game_map_app_id_out_of_range");
  assert.equal(
    failureCode(() => buildGameMap(input({ catalogueGames: catalogue("9223372036854775808") }))),
    "game_map_app_id_out_of_range",
  );
});

test("rejects non-canonical AppID text rather than re-rendering it", () => {
  for (const text of ["+7", "007", " 7", "7 ", "7.0", "7e2", "", "seven"]) {
    assert.equal(
      failureCode(() => buildGameMap(input({ catalogueGames: catalogue(text) }))),
      "game_map_app_id_invalid",
      `expected ${JSON.stringify(text)} to be rejected`,
    );
  }
});

test("preserves AppID text exactly at the bigint edge", () => {
  const result = buildGameMap(input({ catalogueGames: catalogue("4294967295") }));
  assert.equal(result.map.entries[0].legacy_app_id, "4294967295");
  assert.equal(typeof result.map.entries[0].legacy_app_id, "string");
  // The text survives a JSON round trip without becoming a number.
  assert.equal(JSON.parse(canonicalGameMap(result.map)).entries[0].legacy_app_id, "4294967295");
});

test("a null catalogue AppID is a missing identity, a missing column is a broken shape", () => {
  assert.equal(
    failureCode(() => buildGameMap(input({ catalogueGames: catalogue(null) }))),
    "game_map_reference_identity_missing",
  );
  assert.equal(
    failureCode(() => buildGameMap(input({ catalogueGames: [{}] as never }))),
    "game_map_input_invalid",
  );
});

/* -------------------------------------------------------------------------
 * Duplicate, conflicting and missing identities
 * ---------------------------------------------------------------------- */

test("duplicate catalogue identities fail explicitly", () => {
  assert.equal(
    failureCode(() => buildGameMap(input({ catalogueGames: catalogue("10", "20", "10") }))),
    "game_map_duplicate_identity",
  );
});

test("a missing reference fails and names the relation, never the value", () => {
  try {
    buildGameMap(
      input({
        catalogueGames: catalogue("10"),
        references: [reference("completion_events", "steam_appid", "999")],
      }),
    );
    assert.fail("expected a GameMapError");
  } catch (error) {
    assert.ok(error instanceof GameMapError);
    assert.equal(error.gameMapCode, "game_map_missing_reference");
    assert.equal(error.details.relation, "completion_events");
    assert.equal(error.details.field, "steam_appid");
    assert.equal(error.details.count, 1);
    const serialized = JSON.stringify(error.toJSON());
    assert.ok(!serialized.includes("999"), "the AppID must not reach the failure");
  }
});

test("a null reference AppID is a routing decision the caller owes, not a silent skip", () => {
  assert.equal(
    failureCode(() =>
      buildGameMap(
        input({
          catalogueGames: catalogue("10"),
          references: [reference("completion_events", "steam_appid", null)],
        }),
      ),
    ),
    "game_map_reference_identity_missing",
  );
});

/* -------------------------------------------------------------------------
 * Stubs
 * ---------------------------------------------------------------------- */

test("an explicit stub joins the union and is labelled", () => {
  const result = buildGameMap(
    input({
      catalogueGames: catalogue("10", "30"),
      stubs: [stub("20")],
      references: [reference("completion_events", "steam_appid", "20")],
    }),
  );
  assert.deepEqual(
    result.map.entries.map((entry) => [entry.legacy_app_id, entry.game_id, entry.source_kind]),
    [
      ["10", 1, "catalog_games"],
      ["20", 2, "stub"],
      ["30", 3, "catalog_games"],
    ],
  );
  assert.equal(result.stubs.length, 1);
  assert.deepEqual(result.stubs[0], {
    legacy_app_id: "20",
    game_id: 2,
    title: "Steam App 20",
    normalized_sort_title: "steam app 20",
    title_source: "catalog_stub",
    title_provenance: "catalog_stub_fallback",
    required_by_relation: "completion_events",
    required_by_field: "steam_appid",
    reason: "resolved completion event with no catalogue row",
    source_snapshot_hash: RUN.snapshotHash,
  });
});

test("the stub title fallback matches the live import normalizer", () => {
  assert.equal(catalogueStubTitle("620"), "Steam App 620");
  const result = buildGameMap(input({ stubs: [stub("620")] }));
  assert.equal(result.stubs[0].title, "Steam App 620");
});

test("a stub never carries a fabricated instant", () => {
  const result = buildGameMap(input({ stubs: [stub("620")] }));
  const keys = Object.keys(result.stubs[0]).join(" ");
  assert.ok(!/_at\b/.test(keys), `a stub record must have no timestamp field: ${keys}`);
});

test("a stub may not shadow a catalogued AppID", () => {
  assert.equal(
    failureCode(() => buildGameMap(input({ catalogueGames: catalogue("20"), stubs: [stub("20")] }))),
    "game_map_stub_unneeded",
  );
});

test("stub evidence must satisfy the documented fallback rule", () => {
  assert.equal(
    failureCode(() => buildGameMap(input({ stubs: [stub("20", { title: "Half-Life" })] }))),
    "game_map_stub_invalid",
  );
  assert.equal(
    failureCode(() => buildGameMap(input({ stubs: [stub("20", { title_provenance: "source_relation_title" })] }))),
    "game_map_stub_invalid",
  );
  assert.equal(
    failureCode(() => buildGameMap(input({ stubs: [stub("20", { reason: "" })] }))),
    "game_map_stub_invalid",
  );
  assert.equal(
    failureCode(() => buildGameMap(input({ stubs: [stub("20", { required_by_relation: "Not A Relation" })] }))),
    "game_map_stub_invalid",
  );
});

test("a source-titled stub preserves the supplied title and bounds it", () => {
  const result = buildGameMap(
    input({ stubs: [stub("20", { title_provenance: "source_relation_title", title: "  Portal  " })] }),
  );
  assert.equal(result.stubs[0].title, "  Portal  ");
  assert.equal(result.stubs[0].normalized_sort_title, "portal");
  assert.equal(result.stubs[0].title_provenance, "source_relation_title");
  assert.equal(
    failureCode(() =>
      buildGameMap(input({ stubs: [stub("21", { title_provenance: "source_relation_title", title: "x".repeat(501) })] })),
    ),
    "game_map_stub_invalid",
  );
  assert.equal(
    failureCode(() =>
      buildGameMap(input({ stubs: [stub("22", { title_provenance: "source_relation_title", title: "   " })] })),
    ),
    "game_map_stub_invalid",
  );
});

test("duplicate stub evidence for one AppID fails", () => {
  assert.equal(
    failureCode(() => buildGameMap(input({ stubs: [stub("20"), stub("20")] }))),
    "game_map_duplicate_identity",
  );
});

/* -------------------------------------------------------------------------
 * Run identity
 * ---------------------------------------------------------------------- */

test("a row annotated with another run fails immediately", () => {
  assert.equal(
    failureCode(() =>
      buildGameMap(
        input({ catalogueGames: [{ steam_appid: "10", runId: OTHER_RUN.runId }] as never }),
      ),
    ),
    "game_map_mixed_run_identity",
  );
  assert.equal(
    failureCode(() =>
      buildGameMap(
        input({ catalogueGames: [{ steam_appid: "10", snapshot_hash: OTHER_RUN.snapshotHash }] as never }),
      ),
    ),
    "game_map_mixed_run_identity",
  );
});

test("matching run annotations are accepted on every input kind", () => {
  const result = buildGameMap(
    input({
      catalogueGames: [{ steam_appid: "10", runId: RUN.runId, snapshotHash: RUN.snapshotHash }] as never,
      references: [{ relation: "user_games", field: "catalog_steam_appid", steam_appid: "10", run_id: RUN.runId }] as never,
      stubs: [{ ...stub("11"), snapshot_hash: RUN.snapshotHash }] as never,
    }),
  );
  assert.equal(result.map.entries.length, 2);
});

test("an invalid run identity fails before any row is read", () => {
  assert.equal(failureCode(() => buildGameMap({ ...input(), runIdentity: {} } as never)), "game_map_run_invalid");
  assert.equal(
    failureCode(() => buildGameMap({ ...input(), runIdentity: { runId: "r", snapshotHash: "short" } } as never)),
    "game_map_run_invalid",
  );
  assert.equal(
    failureCode(() => buildGameMap({ ...input(), runIdentity: { runId: "bad run id", snapshotHash: "d".repeat(64) } } as never)),
    "game_map_run_invalid",
  );
});

test("assertGameMapRunIdentity rejects a map from another run", () => {
  const map = buildGameMap(input({ catalogueGames: catalogue("10") })).map;
  assertGameMapRunIdentity(map, RUN);
  assert.equal(failureCode(() => assertGameMapRunIdentity(map, OTHER_RUN)), "game_map_mixed_run_identity");
});

/* -------------------------------------------------------------------------
 * lookupGameId
 * ---------------------------------------------------------------------- */

test("lookupGameId resolves an entry and throws on a miss", () => {
  const map = buildGameMap(input({ catalogueGames: catalogue("10", "20") })).map;
  assert.equal(lookupGameId(map, "10"), 1);
  assert.equal(lookupGameId(map, "20"), 2);
  assert.equal(failureCode(() => lookupGameId(map, "30")), "game_map_unknown_app_id");
});

test("lookupGameId throws on a null identity rather than returning a sentinel", () => {
  const map = buildGameMap(input({ catalogueGames: catalogue("10") })).map;
  assert.equal(failureCode(() => lookupGameId(map, null)), "game_map_reference_identity_missing");
});

test("lookupGameId rejects non-canonical text instead of reporting it as unknown", () => {
  const map = buildGameMap(input({ catalogueGames: catalogue("10") })).map;
  assert.equal(failureCode(() => lookupGameId(map, "010")), "game_map_app_id_invalid");
  assert.equal(failureCode(() => lookupGameId(map, "+10")), "game_map_app_id_invalid");
});

test("hasGameId answers without throwing on a miss", () => {
  const map = buildGameMap(input({ catalogueGames: catalogue("10") })).map;
  assert.equal(hasGameId(map, "10"), true);
  assert.equal(hasGameId(map, "11"), false);
  assert.equal(hasGameId(map, null), false);
});

test("a hand-built inconsistent map is rejected on first use", () => {
  const base = buildGameMap(input({ catalogueGames: catalogue("10", "20") })).map;
  const duplicateAppId: GameMap = {
    run_identity: base.run_identity,
    entries: [base.entries[0], { ...base.entries[0], game_id: 5 }],
  };
  assert.equal(failureCode(() => lookupGameId(duplicateAppId, "10")), "game_map_inconsistent");

  const duplicateGameId: GameMap = {
    run_identity: base.run_identity,
    entries: [base.entries[0], { ...base.entries[1], game_id: base.entries[0].game_id }],
  };
  assert.equal(failureCode(() => lookupGameId(duplicateGameId, "10")), "game_map_inconsistent");

  const mixedHash: GameMap = {
    run_identity: base.run_identity,
    entries: [base.entries[0], { ...base.entries[1], source_snapshot_hash: OTHER_RUN.snapshotHash }],
  };
  assert.equal(failureCode(() => lookupGameId(mixedHash, "10")), "game_map_inconsistent");

  const outOfRange: GameMap = {
    run_identity: base.run_identity,
    entries: [{ ...base.entries[0], game_id: 2147483648 }],
  };
  assert.equal(failureCode(() => lookupGameId(outOfRange, "10")), "game_map_inconsistent");

  const zeroId: GameMap = {
    run_identity: base.run_identity,
    entries: [{ ...base.entries[0], game_id: 0 }],
  };
  assert.equal(failureCode(() => lookupGameId(zeroId, "10")), "game_map_inconsistent");
});

/* -------------------------------------------------------------------------
 * gameMapEntryKind
 * ---------------------------------------------------------------------- */

test("gameMapEntryKind reports catalog_games versus stub provenance", () => {
  const result = buildGameMap(
    input({
      catalogueGames: catalogue("10"),
      stubs: [stub("70")],
      references: [reference("completion_events", "steam_appid", "70")],
    }),
  );
  assert.equal(gameMapEntryKind(result.map, "10"), "catalog_games");
  assert.equal(gameMapEntryKind(result.map, "70"), "stub");
  assert.equal(failureCode(() => gameMapEntryKind(result.map, "999")), "game_map_unknown_app_id");
});

/* -------------------------------------------------------------------------
 * The identity cache never survives a mutation of a map it did not build
 * (root catalogue review, defect 3: mutable-map cache staleness)
 * ---------------------------------------------------------------------- */

test("a mutable map is revalidated on every call rather than cached by identity", () => {
  const base = buildGameMap(input({ catalogueGames: catalogue("70") })).map;
  // A plain object literal, not the frozen graph buildGameMap returns: the
  // same shape a caller could hand-construct or copy for a synthetic probe.
  const mutable: { run_identity: typeof base.run_identity; entries: GameMap["entries"][number][] } = {
    run_identity: base.run_identity,
    entries: [{ ...base.entries[0] }],
  };
  assert.equal(lookupGameId(mutable, "70"), 1);

  // Mutate the same object in place, exactly as the root review's repro did
  // (copy a built map, then edit one entry's game_id).  A cache keyed on the
  // outer object's identity would still answer with the pre-mutation value.
  mutable.entries[0] = { ...mutable.entries[0], game_id: 22 };
  assert.equal(lookupGameId(mutable, "70"), 22);

  // Frozen, builder-produced maps remain cache-eligible and their entries
  // cannot be mutated at all (freeze makes the assignment a silent no-op in
  // sloppy mode, so this only proves the frozen path is unaffected).
  assert.equal(lookupGameId(base, "70"), 1);
  assert.equal(lookupGameId(base, "70"), 1);
});

test("a cached frozen map's repeated lookup does not rescan entries", () => {
  // A deterministic proof that the cache hit path is O(1), not a timing
  // guess: wrap the (already frozen) entries array in a Proxy that counts
  // every indexed element read, then assert that count stops growing once
  // the map's index has been built once. `isFullyFrozenGameMap` and the
  // first `indexGameMap` build both read every entry, so only the FIRST
  // `lookupGameId` call is expected to move the counter at all.
  const built = buildGameMap(input({ catalogueGames: catalogue("10", "20", "30") }));
  let indexedReads = 0;
  const countingEntries = new Proxy(built.map.entries as unknown as object[], {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) indexedReads += 1;
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as GameMap["entries"];
  const map: GameMap = Object.freeze({
    run_identity: built.map.run_identity,
    entries: countingEntries,
  });

  assert.equal(lookupGameId(map, "10"), 1);
  const readsAfterFirstCall = indexedReads;
  assert.ok(readsAfterFirstCall > 0, "the first call must actually index the map");

  // The path a library transform exercises millions of times: many further
  // lookups against the SAME map object. None of them may touch an entry.
  for (let i = 0; i < 50; i += 1) {
    assert.equal(lookupGameId(map, "10"), 1);
    assert.equal(lookupGameId(map, "20"), 2);
    assert.equal(lookupGameId(map, "30"), 3);
  }

  assert.equal(
    indexedReads,
    readsAfterFirstCall,
    "a cached frozen map must not read an entry again on a subsequent lookup",
  );
});

/* -------------------------------------------------------------------------
 * validateGameStubTargetRecord (root catalogue review, defect 2: external
 * stub validation)
 * ---------------------------------------------------------------------- */

function builtStub(overrides: Partial<CatalogueStubEvidence> = {}): GameStubTargetRecord {
  const result = buildGameMap(
    input({
      stubs: [stub("70", overrides)],
      references: [reference("completion_events", "steam_appid", "70")],
    }),
  );
  return result.stubs[0];
}

test("a stub this module built always revalidates unchanged", () => {
  const record = builtStub();
  assert.deepEqual(validateGameStubTargetRecord(record, "catalogue_stubs"), record);

  const titled = builtStub({ title_provenance: "source_relation_title", title: "Some Real Title" });
  assert.deepEqual(validateGameStubTargetRecord(titled, "catalogue_stubs"), titled);
});

test("refuses an externally supplied stub with a null or missing title", () => {
  const record = builtStub();
  assert.equal(
    failureCode(() => validateGameStubTargetRecord({ ...record, title: null }, "catalogue_stubs")),
    "game_map_stub_invalid",
  );
  const { title, ...withoutTitle } = record;
  void title;
  assert.equal(failureCode(() => validateGameStubTargetRecord(withoutTitle, "catalogue_stubs")), "game_map_stub_invalid");
});

test("refuses a fallback-provenance stub whose title was substituted", () => {
  const record = builtStub();
  assert.equal(
    failureCode(() => validateGameStubTargetRecord({ ...record, title: "Not The Fallback Title" }, "catalogue_stubs")),
    "game_map_stub_invalid",
  );
});

test("refuses a normalized_sort_title that does not match its title", () => {
  const record = builtStub();
  assert.equal(
    failureCode(() =>
      validateGameStubTargetRecord({ ...record, normalized_sort_title: "wrong normalized title" }, "catalogue_stubs"),
    ),
    "game_map_stub_invalid",
  );
});

test("refuses a title_source other than catalog_stub", () => {
  const record = builtStub();
  assert.equal(
    failureCode(() => validateGameStubTargetRecord({ ...record, title_source: "existing" }, "catalogue_stubs")),
    "game_map_stub_invalid",
  );
});

test("refuses a title outside the trimmed 1..500 bound", () => {
  const record = builtStub();
  assert.equal(
    failureCode(() => validateGameStubTargetRecord({ ...record, title: "   " }, "catalogue_stubs")),
    "game_map_stub_invalid",
  );
  assert.equal(
    failureCode(() =>
      validateGameStubTargetRecord(
        { ...record, title_provenance: "source_relation_title", title: "x".repeat(501) },
        "catalogue_stubs",
      ),
    ),
    "game_map_stub_invalid",
  );
});

test("refuses a malformed required_by_relation, required_by_field, reason, or snapshot hash", () => {
  const record = builtStub();
  assert.equal(
    failureCode(() => validateGameStubTargetRecord({ ...record, required_by_relation: "Not Valid!" }, "catalogue_stubs")),
    "game_map_stub_invalid",
  );
  assert.equal(
    failureCode(() => validateGameStubTargetRecord({ ...record, required_by_field: "" }, "catalogue_stubs")),
    "game_map_stub_invalid",
  );
  assert.equal(
    failureCode(() => validateGameStubTargetRecord({ ...record, reason: "" }, "catalogue_stubs")),
    "game_map_stub_invalid",
  );
  assert.equal(
    failureCode(() => validateGameStubTargetRecord({ ...record, source_snapshot_hash: "not-a-hash" }, "catalogue_stubs")),
    "game_map_stub_invalid",
  );
});

/* -------------------------------------------------------------------------
 * Bounds
 * ---------------------------------------------------------------------- */

test("the identity bound is enforced before allocation", () => {
  assert.equal(
    failureCode(() => buildGameMap(input({ catalogueGames: catalogue("1", "2", "3") }), { maxGames: 2 })),
    "game_map_count_limit",
  );
  assert.equal(
    failureCode(() =>
      buildGameMap(input({ catalogueGames: catalogue("1"), references: [reference("user_games", "catalog_steam_appid", "1")] }), {
        maxReferences: 0,
      }),
    ),
    "game_map_count_limit",
  );
});

test("catalogue plus stub identities are bounded together", () => {
  assert.equal(
    failureCode(() => buildGameMap(input({ catalogueGames: catalogue("1", "2"), stubs: [stub("3")] }), { maxGames: 2 })),
    "game_map_count_limit",
  );
});

test("a non-array input relation is a shape failure", () => {
  assert.equal(failureCode(() => buildGameMap({ runIdentity: RUN, catalogueGames: "no" } as never)), "game_map_input_invalid");
  assert.equal(
    failureCode(() => buildGameMap({ runIdentity: RUN, catalogueGames: [], references: {} } as never)),
    "game_map_input_invalid",
  );
});

test("an empty catalogue produces an empty, valid map", () => {
  const result = buildGameMap(input());
  assert.deepEqual(result.map.entries, []);
  assert.equal(result.counts.mapped_identities, 0);
  assertGameMapRunIdentity(result.map, RUN);
});
