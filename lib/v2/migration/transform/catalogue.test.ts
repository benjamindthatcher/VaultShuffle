import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CATALOG_GAME_SIGHTINGS_SOURCE_COLUMNS,
  CATALOG_GAMES_SOURCE_COLUMNS,
  CATALOGUE_DECISION_PRECEDENCE,
  CATALOGUE_RETIRED_SOURCE_COLUMNS,
  CATALOGUE_TAGS_DURABLE_RETRY_COLUMNS,
  CATALOGUE_TARGET_COLUMNS,
  CATALOGUE_UNWRITTEN_TARGET_COLUMNS,
  CatalogueTransformError,
  canonicalCatalogueResult,
  LEGACY_CLASSIFICATION_SOURCE,
  transformCatalogue,
  type CatalogGameSightingsSourceRow,
  type CatalogGamesSourceRow,
  type CatalogueOfferPolicy,
  type CatalogueTransformResult,
} from "./catalogue.ts";
import { buildGameMap, type GameMap, type GameStubTargetRecord } from "./games.ts";

const RUN = Object.freeze({ runId: "catalogue-transform-run", snapshotHash: "e".repeat(64) });
const OTHER_RUN = Object.freeze({ runId: "catalogue-other-run", snapshotHash: "f".repeat(64) });

const OFFER_POLICY: CatalogueOfferPolicy = Object.freeze({
  provider: "legacy_catalog_games",
  retentionUntil: "2027-01-01 00:00:00+00",
});

/** A complete, valid 58-column source row. Every test starts from this. */
function sourceRow(overrides: Partial<CatalogGamesSourceRow> = {}): CatalogGamesSourceRow {
  return {
    steam_appid: "440",
    name: "Team Fortress 2",
    normalized_name: "team fortress 2",
    steam_type: "game",
    developer: "Valve",
    publisher: "Valve",
    genres: '{Action,"Free to Play"}',
    categories: '{Multi-player,"Steam Achievements"}',
    tags: '[{"tag":"Hero Shooter","weight":9223372036854775807}]',
    short_description: "A team-based shooter.",
    release_date: "2007-10-10",
    is_free: "t",
    capsule_url: "https://cdn.example/capsule.jpg",
    header_url: "https://cdn.example/header.jpg",
    review_positive: "900000",
    review_negative: "100000",
    review_total: "1000000",
    price_currency: "USD",
    price_initial: "1999",
    price_final: "999",
    discount_percent: "50",
    popularity_rank: "12",
    popularity_source: "steamspy",
    popularity_metric: "owners",
    popularity_low: "50000000",
    popularity_high: "100000000",
    popularity_ccu: "70000",
    source_captured_at: "2026-08-20",
    first_seen_reason: "seed",
    import_sighting_count: "37",
    first_seen_at: "2026-01-02 03:04:05.000006+00",
    last_seen_at: "2026-09-01 00:00:00+00",
    metadata_fetched_at: "2026-09-02 12:00:00+00",
    created_at: "2026-01-02 03:04:05+00",
    updated_at: "2026-09-03 09:08:07.654321+00",
    users_that_imported: "12",
    main_story_minutes: "0",
    main_extras_minutes: null,
    completionist_minutes: "6000",
    duration_source: "hltb",
    duration_source_game_id: "20873",
    duration_source_updated_at: "2026-05-05 00:00:00+00",
    duration_confidence: "high",
    duration_status: "ready",
    duration_kind: "endless",
    tags_source: "steam_store",
    tags_status: "ready",
    tags_fetched_at: "2026-09-02 12:00:01+00",
    tags_processing_started_at: null,
    tags_next_attempt_at: null,
    tags_failure_count: "0",
    tags_last_error: null,
    platform_windows: "t",
    platform_mac: "f",
    platform_linux: null,
    deck_compatibility: "3",
    deck_checked_at: "2026-07-01 00:00:00+00",
    duration_manual_override: "t",
    ...overrides,
  };
}

function mapFor(rows: readonly CatalogGamesSourceRow[], stubs: readonly { steam_appid: string }[] = []): {
  map: GameMap;
  stubs: readonly GameStubTargetRecord[];
} {
  const built = buildGameMap({
    runIdentity: RUN,
    catalogueGames: rows.map((row) => ({ steam_appid: row.steam_appid })),
    stubs: stubs.map((entry) => ({
      steam_appid: entry.steam_appid,
      title_provenance: "catalog_stub_fallback" as const,
      required_by_relation: "completion_events",
      required_by_field: "steam_appid",
      reason: "resolved completion event with no catalogue row",
    })),
  });
  return { map: built.map, stubs: built.stubs };
}

function run(
  rows: readonly CatalogGamesSourceRow[],
  options: {
    offerPolicy?: CatalogueOfferPolicy | null;
    stubAppIds?: readonly string[];
    sightings?: readonly CatalogGameSightingsSourceRow[];
  } = {},
): CatalogueTransformResult {
  const built = mapFor(rows, (options.stubAppIds ?? []).map((steam_appid) => ({ steam_appid })));
  return transformCatalogue({
    runIdentity: RUN,
    gameMap: built.map,
    rows,
    stubs: built.stubs,
    ...(options.sightings === undefined ? {} : { sightings: options.sightings }),
    ...(options.offerPolicy === null ? {} : { offerPolicy: options.offerPolicy ?? OFFER_POLICY }),
  });
}

function failureCode(execute: () => unknown): string {
  try {
    execute();
  } catch (error) {
    assert.ok(error instanceof CatalogueTransformError, `expected CatalogueTransformError, received ${String(error)}`);
    return error.catalogueCode;
  }
  assert.fail("expected a CatalogueTransformError");
}

/* -------------------------------------------------------------------------
 * Column coverage
 * ---------------------------------------------------------------------- */

test("the source column list is the complete 58-column relation", () => {
  assert.equal(CATALOG_GAMES_SOURCE_COLUMNS.length, 58);
  assert.equal(new Set(CATALOG_GAMES_SOURCE_COLUMNS).size, 58);
  // Every column named in the row builder is one the transform knows about.
  const builderColumns = Object.keys(sourceRow()).sort();
  assert.deepEqual(builderColumns, [...CATALOG_GAMES_SOURCE_COLUMNS].sort());
});

test("the dedicated sighting source has a bounded four-column shape", () => {
  assert.deepEqual(CATALOG_GAME_SIGHTINGS_SOURCE_COLUMNS, [
    "steam_appid",
    "import_count",
    "first_seen_at",
    "last_seen_at",
  ]);
});

test("every source column is mapped or explicitly retired", () => {
  const retired = Object.keys(CATALOGUE_RETIRED_SOURCE_COLUMNS);
  assert.deepEqual(retired.sort(), ["created_at", "import_sighting_count", "users_that_imported"]);
  // The two tags scheduling columns are no longer retired: root's durability
  // review found that "rebuilt from tags_status after cutover" depended on a
  // rebuild nothing performs, so they now reach catalog.provider_state.
  const durable = Object.keys(CATALOGUE_TAGS_DURABLE_RETRY_COLUMNS);
  assert.deepEqual(durable.sort(), ["tags_next_attempt_at", "tags_processing_started_at"]);
  for (const column of [...retired, ...durable]) {
    assert.ok(CATALOG_GAMES_SOURCE_COLUMNS.includes(column), `${column} is not a source column`);
    const stated =
      (CATALOGUE_RETIRED_SOURCE_COLUMNS as Record<string, string>)[column] ??
      (CATALOGUE_TAGS_DURABLE_RETRY_COLUMNS as Record<string, string>)[column];
    assert.ok(stated.length > 40, `${column} needs a stated replacement fact`);
  }
});

test("tags scheduling state survives in catalog.provider_state instead of being retired", () => {
  const row = sourceRow({
    tags_status: "failed",
    tags_source: "steamspy",
    tags_failure_count: "3",
    tags_last_error: "SteamSpy returned 429.",
    tags_fetched_at: "2026-01-03 00:00:00+00",
    tags_next_attempt_at: "2026-01-04 12:00:00+00",
    tags_processing_started_at: null,
  });
  const built = mapFor([row]);
  const result = transformCatalogue({
    runIdentity: RUN,
    gameMap: built.map,
    rows: [row],
    offerPolicy: OFFER_POLICY,
  });
  assert.equal(result.provider_state.length, 1);
  const state = result.provider_state[0];
  assert.equal(state.evidence_kind, "tags");
  // tags_source is the last successful content source; a failed refresh does
  // not prove which provider owns the current attempt.
  assert.equal(state.provider, "unknown");
  assert.equal(state.status, "failed");
  assert.equal(state.failure_count, 3);
  // The fence is the fact the old retirement note claimed would be "rebuilt".
  assert.equal(state.next_attempt_at?.canonicalUtc, "2026-01-04T12:00:00.000000Z");
  assert.equal(state.fetched_at?.canonicalUtc, "2026-01-03T00:00:00.000000Z");
  assert.equal(state.last_error, "SteamSpy returned 429.");
  assert.equal(result.counts.provider_state, 1);
});

test("a tag status outside the frozen source CHECK is rejected rather than treated as no evidence", () => {
  const row = sourceRow({
    tags_status: "unknown",
    tags_source: null,
    tags_failure_count: "0",
    tags_last_error: null,
    tags_fetched_at: null,
    tags_next_attempt_at: null,
    tags_processing_started_at: null,
  });
  const built = mapFor([row]);
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [row],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_invalid_enum",
  );
});

test("a missing source column is a broken shape, not an absent value", () => {
  for (const column of ["tags_next_attempt_at", "review_total", "steam_appid", "duration_manual_override"]) {
    const row = sourceRow();
    const partial = { ...row } as Record<string, unknown>;
    delete partial[column];
    const built = mapFor([row]);
    assert.equal(
      failureCode(() =>
        transformCatalogue({
          runIdentity: RUN,
          gameMap: built.map,
          rows: [partial as CatalogGamesSourceRow],
          offerPolicy: OFFER_POLICY,
        }),
      ),
      "catalogue_input_invalid",
      `expected a missing ${column} to be refused`,
    );
  }
});

test("retired source timestamps are still validated before their facts are rebuilt", () => {
  assert.equal(failureCode(() => run([sourceRow({ created_at: "not-a-timestamp" })])), "catalogue_invalid_timestamp");
  assert.equal(
    failureCode(() => run([sourceRow({ tags_processing_started_at: "not-a-timestamp" })])),
    "catalogue_invalid_timestamp",
  );
  assert.equal(
    failureCode(() => run([sourceRow({ tags_next_attempt_at: "not-a-timestamp" })])),
    "catalogue_invalid_timestamp",
  );
});

test("the unwritten target columns are declared with a reason", () => {
  const declared = Object.keys(CATALOGUE_UNWRITTEN_TARGET_COLUMNS);
  assert.ok(declared.includes("catalog.games.game_type"));
  assert.ok(declared.includes("catalog.game_features.duration_confidence"));
  assert.ok(declared.includes("catalog.game_features.review_score"));
  for (const [column, reason] of Object.entries(CATALOGUE_UNWRITTEN_TARGET_COLUMNS)) {
    assert.ok(reason.length > 30, `${column} needs a stated reason`);
  }
});

test("every catalogue destination column is written, generated, or declared unwritten", () => {
  // The generated index is parsed from the applied M1/M2/M3 SQL, so this
  // resolves the transform's claims against the real physical columns instead
  // of against a hand-kept list. A column in none of the three buckets would be
  // a destination the transform silently leaves to chance.
  const indexPath = fileURLToPath(
    new URL("../../../../database/v2/migration/manifest/physical-destination-index.json", import.meta.url),
  );
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
    relations: Record<string, { columns: string[] }>;
  };
  const result = run([sourceRow()]);
  const emittedRecord: Record<string, object> = {
    "catalog.games": result.games[0],
    "catalog.game_metadata": result.game_metadata[0],
    "catalog.game_features": result.game_features[0],
    "catalog.game_sightings": result.game_sightings[0],
    "catalog.offers": result.offers[0],
    "catalog.offer_prices": result.offer_prices[0],
    "catalog.review_decisions": result.review_decisions[0],
  };

  for (const [relation, declaration] of Object.entries(CATALOGUE_TARGET_COLUMNS)) {
    const physical = index.relations[relation];
    assert.ok(physical, `${relation} is absent from the physical destination index`);
    const unwritten = Object.keys(CATALOGUE_UNWRITTEN_TARGET_COLUMNS)
      .filter((key) => key.startsWith(`${relation}.`))
      .map((key) => key.slice(relation.length + 1));
    const accounted = new Set([
      ...declaration.written,
      ...declaration.target_generated,
      ...declaration.loader_resolved,
      ...unwritten,
    ]);
    const unaccounted = physical.columns.filter((column) => !accounted.has(column));
    assert.deepEqual(unaccounted, [], `${relation} has undeclared destination columns`);
    const surplus = [...accounted].filter((column) => !physical.columns.includes(column));
    assert.deepEqual(surplus, [], `${relation} declares columns the physical SQL does not define`);
    // A declared written column must really be on the emitted record, so the
    // declaration cannot drift from the code it describes.
    const record = emittedRecord[relation] as Record<string, unknown>;
    const missing = declaration.written.filter((column) => !(column in record));
    assert.deepEqual(missing, [], `${relation} declares written columns the record does not carry`);
  }
});

/* -------------------------------------------------------------------------
 * The complete happy path, checked against hand-computed expectations
 * ---------------------------------------------------------------------- */

test("one complete row produces every catalogue destination record", () => {
  const result = run([sourceRow()]);

  assert.equal(result.games.length, 1);
  const game = result.games[0];
  assert.equal(game.id, 1);
  assert.equal(game.steam_app_id, "440");
  assert.equal(game.title, "Team Fortress 2");
  assert.equal(game.normalized_sort_title, "team fortress 2");
  assert.equal(game.title_source, "existing");
  assert.equal(game.first_seen_reason, "seed");
  assert.equal(game.first_seen_at?.canonicalUtc, "2026-01-02T03:04:05.000006Z");
  assert.equal(game.last_seen_at?.canonicalUtc, "2026-09-01T00:00:00.000000Z");
  assert.equal(game.updated_at?.canonicalUtc, "2026-09-03T09:08:07.654321Z");
  assert.equal(game.source_kind, "catalog_games");
  // D-CAT-1: game_type is not asserted from the forced source value.
  assert.ok(!("game_type" in game), "game_type must not be written");

  const metadata = result.game_metadata[0];
  assert.equal(metadata.game_id, 1);
  assert.equal(metadata.genres, '["Action","Free to Play"]');
  assert.equal(metadata.categories, '["Multi-player","Steam Achievements"]');
  assert.equal(metadata.weighted_tags, '[{"tag":"Hero Shooter","weight":9223372036854775807}]');
  assert.equal(metadata.short_description, "A team-based shooter.");
  assert.equal(metadata.developer, "Valve");
  assert.equal(metadata.publisher, "Valve");
  assert.equal(metadata.header_image_url, "https://cdn.example/header.jpg");
  assert.equal(metadata.capsule_image_url, "https://cdn.example/capsule.jpg");
  assert.equal(metadata.fetched_at?.canonicalUtc, "2026-09-02T12:00:00.000000Z");
  // catalog.game_metadata.release_date is the only destination for this civil
  // date; catalog.game_features has no such column.
  assert.equal(metadata.release_date?.toIsoString(), "2007-10-10");
  assert.ok(!("provider_name" in metadata));

  const features = result.game_features[0];
  assert.equal(features.game_id, 1);
  assert.equal(features.deck_compatibility_detail, 3);
  assert.equal(features.deck_compatibility, "supported");
  assert.equal(features.windows_compatibility, "supported");
  assert.equal(features.mac_compatibility, "unsupported");
  assert.equal(features.linux_compatibility, "unknown");
  assert.equal(features.main_duration_minutes, 0);
  assert.equal(features.extras_duration_minutes, null);
  assert.equal(features.completion_duration_minutes, 6000);
  assert.equal(features.duration_source, "hltb");
  assert.equal(features.duration_source_game_id, "20873");
  assert.equal(features.duration_confidence_label, "high");
  assert.equal(features.duration_status, "ready");
  assert.equal(features.duration_kind, "endless");
  assert.equal(features.duration_manual_override, true);
  assert.equal(features.review_positive, "900000");
  assert.equal(features.review_negative, "100000");
  assert.equal(features.review_total, "1000000");
  assert.equal(features.popularity_rank, "12");
  assert.equal(features.popularity_source, "steamspy");
  assert.equal(features.popularity_metric, "owners");
  assert.equal(features.popularity_low, "50000000");
  assert.equal(features.popularity_high, "100000000");
  assert.equal(features.popularity_ccu, "70000");
  assert.equal(features.source_captured_on?.toIsoString(), "2026-08-20");
  assert.ok(
    !("release_date" in features),
    "catalog.game_features has no release_date column; the fact belongs to catalog.game_metadata",
  );
  assert.equal(features.tags_source, "steam_store");
  assert.equal(features.tags_status, "ready");
  assert.equal(features.tags_failure_count, 0);
  assert.equal(features.tags_last_error, null);

  assert.equal(result.offers.length, 1);
  const offer = result.offers[0];
  assert.equal(offer.game_id, 1);
  assert.equal(offer.provider, "legacy_catalog_games");
  assert.equal(offer.region_code, "US");
  assert.equal(offer.is_free, true);
  assert.equal(offer.first_observed_at.canonicalUtc, "2026-09-02T12:00:00.000000Z");
  assert.equal(offer.last_observed_at.canonicalUtc, "2026-09-02T12:00:00.000000Z");
  assert.equal(offer.observed_at_source, "catalog_games.metadata_fetched_at");
  assert.equal(offer.source_snapshot_hash, RUN.snapshotHash);

  assert.equal(result.offer_prices.length, 1);
  const price = result.offer_prices[0];
  assert.equal(price.offer_ref, offer.offer_ref);
  assert.equal(price.currency, "USD");
  assert.equal(price.price_initial_cents, 1999);
  assert.equal(price.price_final_cents, 999);
  assert.equal(price.discount_percent, 50);
  assert.equal(price.is_free, true);
  assert.equal(price.is_current, true);
  assert.equal(price.observed_at.canonicalUtc, "2026-09-02T12:00:00.000000Z");
  assert.equal(price.retention_until.canonicalUtc, "2027-01-01T00:00:00.000000Z");

  assert.deepEqual(result.game_sightings, [
    {
      steam_app_id: "440",
      game_id: 1,
      import_count: "37",
      first_seen_at: game.first_seen_at,
      last_seen_at: game.last_seen_at,
      source_snapshot_hash: RUN.snapshotHash,
      source_relation: "catalog_games",
    },
  ]);
  assert.equal(result.counts.game_sightings, 1);

  assert.equal(result.review_decisions.length, 1);
  const decision = result.review_decisions[0];
  assert.equal(decision.game_id, 1);
  assert.equal(decision.steam_app_id, "440");
  assert.equal(decision.decision_kind, "catalogue_type");
  assert.equal(decision.source_relation, "catalog_games");
  assert.equal(decision.source_record_key, "440");
  assert.equal(decision.source, LEGACY_CLASSIFICATION_SOURCE);
  assert.equal(decision.precedence_rank, CATALOGUE_DECISION_PRECEDENCE.legacy_catalog_games);
  assert.equal(decision.decision_status, "retained");
  assert.equal(decision.steam_type, "game");
  assert.equal(decision.duration_manual_override, false);
  assert.equal(decision.created_at.canonicalUtc, "2026-01-02T03:04:05.000006Z");
  assert.equal(decision.updated_at.canonicalUtc, "2026-09-03T09:08:07.654321Z");
  assert.equal(decision.created_at_source, "catalog_games.first_seen_at");
  // A reviewer and a review time are never invented for legacy evidence.
  assert.ok(!("reviewer_account_id" in decision));
  assert.ok(!("reviewed_at" in decision));

  assert.deepEqual(result.reconciliation, [
    { game_id: 1, steam_app_id: "440", import_sighting_count: "37", users_that_imported: "12" },
  ]);
});

test("permuted source row order produces an identical result", () => {
  const rows = [sourceRow({ steam_appid: "70", name: "Half-Life", normalized_name: "half-life" }),
    sourceRow({ steam_appid: "440" }),
    sourceRow({ steam_appid: "220", name: "Half-Life 2", normalized_name: "half-life 2" })];
  const forward = run(rows);
  const reversed = run([...rows].reverse());
  assert.equal(canonicalCatalogueResult(forward), canonicalCatalogueResult(reversed));
  assert.deepEqual(forward.games.map((game) => [game.steam_app_id, game.id]), [["70", 1], ["220", 2], ["440", 3]]);
});

test("developer and publisher preserve NULL and the target character bound", () => {
  const result = run([sourceRow({ developer: null, publisher: "" })]);
  assert.equal(result.game_metadata[0].developer, null);
  assert.equal(result.game_metadata[0].publisher, "");
  assert.equal(failureCode(() => run([sourceRow({ developer: "d".repeat(1001) })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ publisher: "p".repeat(1001) })])), "catalogue_text_bounds");
  const astral = "\u{1F9EA}".repeat(1000);
  assert.equal(run([sourceRow({ developer: astral })]).game_metadata[0].developer, astral);
  assert.equal(failureCode(() => run([sourceRow({ publisher: `${astral}\u{1F9EA}` })])), "catalogue_text_bounds");
});

test("dedicated sighting rows reconcile the duplicated catalogue facts", () => {
  const dedicated: CatalogGameSightingsSourceRow = {
    steam_appid: "440",
    import_count: "37",
    first_seen_at: "2026-01-02 03:04:05.000006+00",
    last_seen_at: "2026-09-01 00:00:00+00",
  };
  const result = run([sourceRow()], { sightings: [dedicated] });
  assert.equal(result.game_sightings.length, 1);
  assert.equal(result.game_sightings[0].source_relation, "catalog_game_sightings");
  assert.equal(result.game_sightings[0].game_id, 1);
  assert.equal(result.game_sightings[0].import_count, "37");
});

test("dedicated sighting times and catalogue times survive as independent timelines", () => {
  const result = run([sourceRow()], { sightings: [{
    steam_appid: "440",
    import_count: "37",
    first_seen_at: "2025-01-01 00:00:00+00",
    last_seen_at: "2025-02-01 00:00:00+00",
  }] });
  assert.equal(result.games[0].first_seen_at?.canonicalUtc, "2026-01-02T03:04:05.000006Z");
  assert.equal(result.games[0].last_seen_at?.canonicalUtc, "2026-09-01T00:00:00.000000Z");
  assert.equal(result.game_sightings[0].first_seen_at.canonicalUtc, "2025-01-01T00:00:00.000000Z");
  assert.equal(result.game_sightings[0].last_seen_at.canonicalUtc, "2025-02-01T00:00:00.000000Z");
});

test("a sighting-only AppID keeps its provenance with a NULL game identity", () => {
  const result = run([sourceRow()], {
    sightings: [
      {
        steam_appid: "70",
        import_count: "2",
        first_seen_at: "2000-02-29 23:59:59.999999+00",
        last_seen_at: "2001-01-01 00:00:00+00",
      },
    ],
  });
  const sighting = result.game_sightings.find((row) => row.steam_app_id === "70");
  assert.ok(sighting);
  assert.equal(sighting.game_id, null);
  assert.equal(sighting.first_seen_at.canonicalUtc, "2000-02-29T23:59:59.999999Z");
  assert.equal(sighting.last_seen_at.canonicalUtc, "2001-01-01T00:00:00.000000Z");
});

test("duplicate sighting counters fail closed on disagreement and repeated source rows are refused", () => {
  assert.equal(
    failureCode(() =>
      run([sourceRow()], {
        sightings: [{
          steam_appid: "440",
          import_count: "38",
          first_seen_at: "2026-01-02 03:04:05.000006+00",
          last_seen_at: "2026-09-01 00:00:00+00",
        }],
      }),
    ),
    "catalogue_sighting_conflict",
  );
  const row: CatalogGameSightingsSourceRow = {
    steam_appid: "70",
    import_count: "2",
    first_seen_at: "2000-01-01 00:00:00+00",
    last_seen_at: "2001-01-01 00:00:00+00",
  };
  assert.equal(failureCode(() => run([sourceRow()], { sightings: [row, row] })), "catalogue_duplicate_row");
});

test("dedicated sighting ordering is deterministic under permutation", () => {
  const source = [
    { steam_appid: "70", import_count: "2", first_seen_at: "2000-01-01 00:00:00+00", last_seen_at: "2001-01-01 00:00:00+00" },
    { steam_appid: "440", import_count: "37", first_seen_at: "2026-01-02 03:04:05.000006+00", last_seen_at: "2026-09-01 00:00:00+00" },
  ] as const;
  const forward = run([sourceRow()], { sightings: source });
  const reversed = run([sourceRow()], { sightings: [...source].reverse() });
  assert.equal(canonicalCatalogueResult(forward), canonicalCatalogueResult(reversed));
  assert.deepEqual(forward.game_sightings.map((row) => row.steam_app_id), ["440", "70"]);
});

/* -------------------------------------------------------------------------
 * NULL and zero stay distinct
 * ---------------------------------------------------------------------- */

test("NULL and zero are preserved as different facts", () => {
  const zeros = run([
    sourceRow({
      review_positive: "0",
      review_negative: "0",
      review_total: "0",
      popularity_rank: "0",
      popularity_low: "0",
      popularity_high: "0",
      popularity_ccu: "0",
      main_story_minutes: "0",
      main_extras_minutes: "0",
      completionist_minutes: "0",
      tags_failure_count: "0",
      price_initial: "0",
      price_final: "0",
      discount_percent: "0",
    }),
  ]).game_features[0];
  assert.equal(zeros.review_total, "0");
  assert.equal(zeros.popularity_rank, "0");
  assert.equal(zeros.popularity_ccu, "0");
  assert.equal(zeros.main_duration_minutes, 0);
  assert.equal(zeros.extras_duration_minutes, 0);
  assert.equal(zeros.completion_duration_minutes, 0);
  assert.equal(zeros.tags_failure_count, 0);

  const nulls = run([
    sourceRow({
      review_total: null,
      popularity_rank: null,
      popularity_low: null,
      popularity_high: null,
      popularity_ccu: null,
      main_story_minutes: null,
      main_extras_minutes: null,
      completionist_minutes: null,
    }),
  ]).game_features[0];
  assert.equal(nulls.review_total, null);
  assert.equal(nulls.popularity_rank, null);
  assert.equal(nulls.popularity_ccu, null);
  assert.equal(nulls.main_duration_minutes, null);
  assert.equal(nulls.completion_duration_minutes, null);

  const zeroPrice = run([sourceRow({ price_initial: "0", price_final: "0", discount_percent: "0" })]).offer_prices[0];
  assert.equal(zeroPrice.price_initial_cents, 0);
  assert.equal(zeroPrice.price_final_cents, 0);
  const nullPrice = run([sourceRow({ price_initial: null, price_final: null, discount_percent: "0" })]).offer_prices[0];
  assert.equal(nullPrice.price_initial_cents, null);
  assert.equal(nullPrice.price_final_cents, null);
});

test("a null duration confidence stays null and never becomes 'none'", () => {
  const features = run([sourceRow({ duration_confidence: null })]).game_features[0];
  assert.equal(features.duration_confidence_label, null);
  const none = run([sourceRow({ duration_confidence: "none" })]).game_features[0];
  assert.equal(none.duration_confidence_label, "none");
});

test("no numeric probability is fabricated from an ordinal label", () => {
  for (const label of ["low", "medium", "high"]) {
    const features = run([sourceRow({ duration_confidence: label })]).game_features[0];
    assert.equal(features.duration_confidence_label, label);
    assert.ok(!("duration_confidence" in features), "the numeric column must stay unwritten");
    assert.ok(!("review_score" in features), "the derived score must stay unwritten");
  }
});

/* -------------------------------------------------------------------------
 * Exact values: bigint, civil date, UTC boundary
 * ---------------------------------------------------------------------- */

test("bigint popularity values survive at the PostgreSQL edge", () => {
  const features = run([
    sourceRow({ popularity_low: "9223372036854775807", popularity_high: "9223372036854775807" }),
  ]).game_features[0];
  assert.equal(features.popularity_low, "9223372036854775807");
  assert.equal(features.popularity_high, "9223372036854775807");
  // The value survives serialisation without becoming 9223372036854776000.
  assert.ok(JSON.stringify(features).includes("9223372036854775807"));
});

test("an out-of-range integer fails rather than wrapping", () => {
  assert.equal(
    failureCode(() => run([sourceRow({ main_story_minutes: "2147483648" })])),
    "catalogue_invalid_integer",
  );
  assert.equal(failureCode(() => run([sourceRow({ review_positive: "-1" })])), "catalogue_invalid_integer");
  assert.equal(
    failureCode(() => run([sourceRow({ popularity_low: "9223372036854775808" })])),
    "catalogue_invalid_integer",
  );
  assert.equal(failureCode(() => run([sourceRow({ discount_percent: "101" })])), "catalogue_invalid_integer");
});

test("source NOT NULL integer facts cannot disappear as target NULLs", () => {
  for (const field of ["review_positive", "review_negative", "discount_percent", "tags_failure_count", "import_sighting_count", "users_that_imported"] as const) {
    assert.equal(
      failureCode(() => run([sourceRow({ [field]: null })])),
      "catalogue_invalid_integer",
      `expected ${field} NULL to be rejected`,
    );
  }
});

test("civil dates stay civil and are never routed through a timestamp", () => {
  const result = run([sourceRow({ release_date: "2024-02-29", source_captured_at: "1970-01-01" })]);
  const releaseDate = result.game_metadata[0].release_date;
  assert.equal(releaseDate?.toIsoString(), "2024-02-29");
  assert.equal(releaseDate?.year, 2024);
  assert.equal(releaseDate?.month, 2);
  assert.equal(releaseDate?.day, 29);
  assert.ok(!("epochMicros" in (releaseDate as object)), "a civil date must not carry an instant");
  assert.equal(result.game_features[0].source_captured_on?.toIsoString(), "1970-01-01");
  assert.equal(JSON.stringify(releaseDate), '"2024-02-29"');
});

test("an impossible civil date fails rather than rolling over", () => {
  assert.equal(failureCode(() => run([sourceRow({ release_date: "2023-02-29" })])), "catalogue_invalid_date");
  assert.equal(failureCode(() => run([sourceRow({ release_date: "2024-13-01" })])), "catalogue_invalid_date");
  assert.equal(
    failureCode(() => run([sourceRow({ source_captured_at: "2026-08-20 00:00:00+00" })])),
    "catalogue_invalid_date",
  );
});

test("instants are normalised to exact UTC microseconds across offsets", () => {
  const result = run([
    sourceRow({
      first_seen_at: "1969-12-31 19:00:00-05",
      last_seen_at: "1970-01-01 00:00:00.000001+00",
      updated_at: "1970-01-01 09:00:00.000002+09",
      metadata_fetched_at: "1970-01-01 00:00:00Z",
    }),
  ]);
  assert.equal(result.games[0].first_seen_at?.epochMicrosText, "0");
  assert.equal(result.games[0].last_seen_at?.epochMicrosText, "1");
  assert.equal(result.games[0].updated_at?.epochMicrosText, "2");
  assert.equal(result.game_metadata[0].fetched_at?.canonicalUtc, "1970-01-01T00:00:00.000000Z");
});

test("a timestamp without a timezone is refused rather than assumed", () => {
  assert.equal(failureCode(() => run([sourceRow({ updated_at: "2026-09-03 09:08:07" })])), "catalogue_invalid_timestamp");
  assert.equal(failureCode(() => run([sourceRow({ first_seen_at: "infinity" })])), "catalogue_invalid_timestamp");
  assert.equal(failureCode(() => run([sourceRow({ last_seen_at: null })])), "catalogue_invalid_timestamp");
});

test("the target seen-order check is a reported conflict, never a clamp", () => {
  assert.equal(
    failureCode(() =>
      run([sourceRow({ first_seen_at: "2026-09-01 00:00:00+00", last_seen_at: "2026-01-01 00:00:00+00" })]),
    ),
    "catalogue_seen_order_conflict",
  );
  // Equal instants satisfy the check.
  const equal = run([sourceRow({ first_seen_at: "2026-09-01 00:00:00+00", last_seen_at: "2026-09-01 00:00:00+00" })]);
  assert.equal(equal.games[0].last_seen_at?.canonicalUtc, "2026-09-01T00:00:00.000000Z");
});

/* -------------------------------------------------------------------------
 * Arrays, JSON and weighted tags
 * ---------------------------------------------------------------------- */

test("the weighted tag document is preserved verbatim, not reserialised", () => {
  const tags = '[{"tag":"RPG","weight":1.500000000000000001},{"tag":"Indie","weight":123456789012345678901}]';
  const metadata = run([sourceRow({ tags })]).game_metadata[0];
  assert.equal(metadata.weighted_tags, tags);
  assert.notEqual(JSON.stringify(JSON.parse(tags)), tags, "JSON.parse must be shown to be lossy here");
});

test("an empty tag array and an empty text array stay empty rather than absent", () => {
  const metadata = run([sourceRow({ tags: "[]", genres: "{}", categories: "{}" })]).game_metadata[0];
  assert.equal(metadata.weighted_tags, "[]");
  assert.equal(metadata.genres, "[]");
  assert.equal(metadata.categories, "[]");
  assert.deepEqual(metadata.genres_elements, []);
});

test("a numeric tag map becomes a deterministic lossless weighted-tag array", () => {
  const tags = '{"\u00c9lite":1.500000000000000001,"RPG":123456789012345678901,"emoji 🎮":2}';
  const weighted = run([sourceRow({ tags })]).game_metadata[0].weighted_tags;
  assert.equal(weighted, '[{"tag":"RPG","weight":123456789012345678901},{"tag":"emoji 🎮","weight":2},{"tag":"Élite","weight":1.500000000000000001}]');
  const reversed = Object.fromEntries((JSON.parse(weighted) as { tag: string; weight: number }[]).map((entry) => [entry.tag, entry.weight]));
  assert.deepEqual(Object.keys(reversed), ["RPG", "emoji 🎮", "Élite"]);
  assert.ok(weighted.includes("1.500000000000000001"));
  assert.ok(weighted.includes("123456789012345678901"));
  assert.equal(run([sourceRow({ tags: "{}" })]).game_metadata[0].weighted_tags, "[]");
});

test("tag maps reject non-numeric weights and duplicate decoded keys", () => {
  assert.equal(failureCode(() => run([sourceRow({ tags: '{"RPG":"5"}' })])), "catalogue_json_shape_conflict");
  assert.equal(failureCode(() => run([sourceRow({ tags: '{"RPG":5,"\\u0052PG":6}' })])), "catalogue_json_shape_conflict");
});

test("a tag document that is neither an array nor a numeric map is a conflict", () => {
  assert.equal(failureCode(() => run([sourceRow({ tags: '"RPG"' })])), "catalogue_json_shape_conflict");
  assert.equal(failureCode(() => run([sourceRow({ tags: "null" })])), "catalogue_json_shape_conflict");
  assert.equal(failureCode(() => run([sourceRow({ tags: "[1,2" })])), "catalogue_json_shape_conflict");
  assert.equal(failureCode(() => run([sourceRow({ tags: null })])), "catalogue_json_shape_conflict");
});

test("array elements keep order, NULL and quoting", () => {
  const metadata = run([
    sourceRow({ genres: '{Action,NULL,"NULL","Free to Play","",Indie}', categories: '{"a,b","c\\"d"}' }),
  ]).game_metadata[0];
  assert.deepEqual(metadata.genres_elements, ["Action", null, "NULL", "Free to Play", "", "Indie"]);
  assert.equal(metadata.genres, '["Action",null,"NULL","Free to Play","","Indie"]');
  assert.deepEqual(metadata.categories_elements, ["a,b", 'c"d']);
  assert.equal(metadata.categories, '["a,b","c\\"d"]');
});

test("a malformed or multi-dimensional array is a conflict, never coerced", () => {
  assert.equal(failureCode(() => run([sourceRow({ genres: "{{a},{b}}" })])), "catalogue_array_conflict");
  assert.equal(failureCode(() => run([sourceRow({ genres: "Action" })])), "catalogue_array_conflict");
  assert.equal(failureCode(() => run([sourceRow({ categories: "{a,,b}" })])), "catalogue_array_conflict");
  assert.equal(failureCode(() => run([sourceRow({ genres: null })])), "catalogue_array_conflict");
});

test("the encoded size checks stay required SQL gates", () => {
  const result = run([sourceRow()]);
  const columns = result.required_sql_gates.map((gate) => `${gate.relation}.${gate.column}`);
  assert.deepEqual(columns, [
    "catalog.game_metadata.genres",
    "catalog.game_metadata.categories",
    "catalog.game_metadata.weighted_tags",
  ]);
  for (const gate of result.required_sql_gates) {
    assert.ok(gate.check.includes("pg_column_size"));
    assert.ok(gate.max_source_utf8_bytes > 0);
  }
  const tagsGate = result.required_sql_gates.find((gate) => gate.column === "weighted_tags");
  assert.equal(tagsGate?.max_source_utf8_bytes, sourceRow().tags?.length);
});

/* -------------------------------------------------------------------------
 * Tri-state platforms and four-way Deck detail
 * ---------------------------------------------------------------------- */

test("platform booleans become a tri-state and NULL never becomes unsupported", () => {
  const supported = run([sourceRow({ platform_windows: "t", platform_mac: "t", platform_linux: "t" })]).game_features[0];
  assert.equal(supported.windows_compatibility, "supported");
  assert.equal(supported.mac_compatibility, "supported");
  assert.equal(supported.linux_compatibility, "supported");

  const unsupported = run([sourceRow({ platform_windows: "f", platform_mac: "f", platform_linux: "f" })]).game_features[0];
  assert.equal(unsupported.windows_compatibility, "unsupported");
  assert.equal(unsupported.mac_compatibility, "unsupported");
  assert.equal(unsupported.linux_compatibility, "unsupported");

  const unknown = run([sourceRow({ platform_windows: null, platform_mac: null, platform_linux: null })]).game_features[0];
  assert.equal(unknown.windows_compatibility, "unknown");
  assert.equal(unknown.mac_compatibility, "unknown");
  assert.equal(unknown.linux_compatibility, "unknown");
});

test("a non-COPY boolean cell is refused", () => {
  assert.equal(failureCode(() => run([sourceRow({ platform_windows: "true" })])), "catalogue_invalid_boolean");
  assert.equal(failureCode(() => run([sourceRow({ is_free: "1" })])), "catalogue_invalid_boolean");
  assert.equal(failureCode(() => run([sourceRow({ duration_manual_override: null })])), "catalogue_invalid_boolean");
});

test("the four-way Deck category keeps Playable distinct from Verified", () => {
  const expected: Record<string, [number, string]> = {
    "0": [0, "unknown"],
    "1": [1, "unsupported"],
    "2": [2, "supported"],
    "3": [3, "supported"],
  };
  for (const [source, [detail, triState]] of Object.entries(expected)) {
    const features = run([sourceRow({ deck_compatibility: source })]).game_features[0];
    assert.equal(features.deck_compatibility_detail, detail, `detail for ${source}`);
    assert.equal(features.deck_compatibility, triState, `tri-state for ${source}`);
  }
  const playable = run([sourceRow({ deck_compatibility: "2" })]).game_features[0];
  const verified = run([sourceRow({ deck_compatibility: "3" })]).game_features[0];
  assert.notEqual(playable.deck_compatibility_detail, verified.deck_compatibility_detail);
  assert.equal(playable.deck_compatibility, verified.deck_compatibility);
});

test("an unknown Deck category is a conflict and NULL stays unknown", () => {
  assert.equal(failureCode(() => run([sourceRow({ deck_compatibility: "4" })])), "catalogue_deck_detail_invalid");
  assert.equal(failureCode(() => run([sourceRow({ deck_compatibility: "-1" })])), "catalogue_deck_detail_invalid");
  const missing = run([sourceRow({ deck_compatibility: null, deck_checked_at: null })]).game_features[0];
  assert.equal(missing.deck_compatibility_detail, null);
  assert.equal(missing.deck_compatibility, "unknown");
  assert.equal(missing.deck_checked_at, null);
});

/* -------------------------------------------------------------------------
 * Duration provenance and manual override
 * ---------------------------------------------------------------------- */

test("the manual override fact is preserved in both states", () => {
  assert.equal(run([sourceRow({ duration_manual_override: "t" })]).game_features[0].duration_manual_override, true);
  assert.equal(run([sourceRow({ duration_manual_override: "f" })]).game_features[0].duration_manual_override, false);
});

test("a non-numeric provider identifier is a reported physical gap", () => {
  assert.equal(
    failureCode(() => run([sourceRow({ duration_source_game_id: "hltb-20873" })])),
    "catalogue_duration_source_game_id_unrepresentable",
  );
  assert.equal(
    failureCode(() => run([sourceRow({ duration_source_game_id: "0" })])),
    "catalogue_duration_source_game_id_unrepresentable",
  );
  assert.equal(
    failureCode(() => run([sourceRow({ duration_source_game_id: "020873" })])),
    "catalogue_duration_source_game_id_unrepresentable",
  );
  assert.equal(run([sourceRow({ duration_source_game_id: null })]).game_features[0].duration_source_game_id, null);
});

test("the duration and tag lifecycle vocabularies are checked against the target", () => {
  assert.equal(failureCode(() => run([sourceRow({ duration_status: "queued" })])), "catalogue_invalid_enum");
  assert.equal(failureCode(() => run([sourceRow({ duration_kind: "short" })])), "catalogue_invalid_enum");
  assert.equal(failureCode(() => run([sourceRow({ tags_status: "stale" })])), "catalogue_invalid_enum");
  assert.equal(failureCode(() => run([sourceRow({ first_seen_reason: "backfill" })])), "catalogue_invalid_enum");
  assert.equal(failureCode(() => run([sourceRow({ duration_confidence: "certain" })])), "catalogue_invalid_enum");
  // The target vocabulary is a superset, but accepting a value forbidden by
  // the frozen source CHECK would hide source-schema drift.
  assert.equal(failureCode(() => run([sourceRow({ duration_status: "unknown" })])), "catalogue_invalid_enum");
  assert.equal(run([sourceRow({ first_seen_reason: "unknown" })]).games[0].first_seen_reason, "unknown");
});

/* -------------------------------------------------------------------------
 * Text bounds
 * ---------------------------------------------------------------------- */

test("over-length text is a reported conflict, never truncated", () => {
  assert.equal(failureCode(() => run([sourceRow({ name: "x".repeat(501) })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ normalized_name: "x".repeat(501) })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ header_url: "h".repeat(2049) })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ short_description: "d".repeat(10_001) })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ tags_last_error: "e".repeat(2001) })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ duration_source: "s".repeat(121) })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ popularity_source: "s".repeat(121) })])), "catalogue_text_bounds");
});

test("a whitespace-only value the target rejects is a conflict, not a null", () => {
  assert.equal(failureCode(() => run([sourceRow({ name: "   " })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ duration_source: " " })])), "catalogue_text_bounds");
  assert.equal(failureCode(() => run([sourceRow({ tags_source: "" })])), "catalogue_text_bounds");
});

test("text bounds count characters the way PostgreSQL length() does", () => {
  // 500 astral code points are 1000 UTF-16 units and 500 PostgreSQL characters.
  const title = "\u{1F600}".repeat(500);
  assert.equal(title.length, 1000);
  const game = run([sourceRow({ name: title, normalized_name: title })]).games[0];
  assert.equal(game.title, title);
  assert.equal(failureCode(() => run([sourceRow({ name: "\u{1F600}".repeat(501) })])), "catalogue_text_bounds");
});

/* -------------------------------------------------------------------------
 * Offers and prices
 * ---------------------------------------------------------------------- */

test("a USD observation produces one offer and one current price", () => {
  const result = run([sourceRow()]);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offer_prices.length, 1);
  assert.equal(result.counts.offers, 1);
  assert.equal(result.counts.offer_prices, 1);
});

test("a free game with no stated currency keeps the offer without inventing one", () => {
  const result = run([
    sourceRow({ is_free: "t", price_currency: null, price_initial: null, price_final: null, discount_percent: "0" }),
  ]);
  assert.equal(result.offers.length, 1);
  assert.equal(result.offers[0].is_free, true);
  assert.equal(result.offer_prices.length, 0, "no currency means no price row");
});

test("a row with no price evidence at all produces no offer", () => {
  const result = run([
    sourceRow({ is_free: "f", price_currency: null, price_initial: null, price_final: null, discount_percent: "0" }),
  ]);
  assert.equal(result.offers.length, 0);
  assert.equal(result.offer_prices.length, 0);
});

test("cents with no stated currency are an unresolved case, not an assumed USD", () => {
  assert.equal(
    failureCode(() => run([sourceRow({ price_currency: null, price_initial: "1999", discount_percent: "0" })])),
    "catalogue_price_currency_unstated",
  );
  assert.equal(
    failureCode(() => run([sourceRow({ price_currency: null, price_initial: null, price_final: "999", discount_percent: "0" })])),
    "catalogue_price_currency_unstated",
  );
});

test("a discount with no stated currency has nowhere to go and is reported", () => {
  assert.equal(
    failureCode(() =>
      run([sourceRow({ price_currency: null, price_initial: null, price_final: null, discount_percent: "20" })]),
    ),
    "catalogue_price_discount_without_currency",
  );
});

test("a non-USD currency is a reported physical gap, never converted", () => {
  assert.equal(failureCode(() => run([sourceRow({ price_currency: "GBP" })])), "catalogue_physical_gap");
  assert.equal(failureCode(() => run([sourceRow({ price_currency: "usd" })])), "catalogue_physical_gap");
});

test("a final price above the initial price violates the target check and is reported", () => {
  assert.equal(
    failureCode(() => run([sourceRow({ price_initial: "999", price_final: "1999", discount_percent: "0" })])),
    "catalogue_price_conflict",
  );
});

test("an offer needs an explicit policy; the transform invents neither attribution nor expiry", () => {
  assert.equal(failureCode(() => run([sourceRow()], { offerPolicy: null })), "catalogue_offer_policy_missing");
  // A row with no offer needs no policy at all.
  const noOffer = run(
    [sourceRow({ is_free: "f", price_currency: null, price_initial: null, price_final: null, discount_percent: "0" })],
    { offerPolicy: null },
  );
  assert.equal(noOffer.offers.length, 0);
});

test("a retention instant before the observation violates the target check", () => {
  assert.equal(
    failureCode(() =>
      run([sourceRow({ metadata_fetched_at: "2026-09-02 12:00:00+00" })], {
        offerPolicy: { provider: "legacy_catalog_games", retentionUntil: "2026-09-02 11:59:59+00" },
      }),
    ),
    "catalogue_offer_policy_invalid",
  );
  // Equal instants satisfy `retention_until >= observed_at`.
  const equal = run([sourceRow({ metadata_fetched_at: "2026-09-02 12:00:00+00" })], {
    offerPolicy: { provider: "legacy_catalog_games", retentionUntil: "2026-09-02 12:00:00+00" },
  });
  assert.equal(equal.offer_prices[0].retention_until.epochMicrosText, equal.offer_prices[0].observed_at.epochMicrosText);
});

test("a malformed offer policy is refused", () => {
  assert.equal(
    failureCode(() => run([sourceRow()], { offerPolicy: { provider: "  ", retentionUntil: "2027-01-01 00:00:00+00" } })),
    "catalogue_offer_policy_invalid",
  );
  assert.equal(
    failureCode(() => run([sourceRow()], { offerPolicy: { provider: "p", retentionUntil: "2027-01-01" } })),
    "catalogue_offer_policy_invalid",
  );
});

test("offers are keyed per game so the same policy provider stays one offer each", () => {
  const result = run([sourceRow({ steam_appid: "440" }), sourceRow({ steam_appid: "70" })]);
  assert.equal(result.offers.length, 2);
  const keys = result.offers.map((offer) => `${offer.game_id}|${offer.provider}|${offer.region_code}`);
  assert.equal(new Set(keys).size, 2);
  assert.equal(new Set(result.offers.map((offer) => offer.offer_ref)).size, 2);
});

/* -------------------------------------------------------------------------
 * Legacy classification evidence and precedence
 * ---------------------------------------------------------------------- */

test("the precedence ladder orders manual above automatic above legacy", () => {
  const ranks = CATALOGUE_DECISION_PRECEDENCE;
  assert.ok(ranks.legacy_catalog_games < ranks.automatic_quarantine);
  assert.ok(ranks.automatic_quarantine < ranks.manual_quarantine);
  assert.ok(ranks.manual_quarantine < ranks.manual_duration_review);
  for (const rank of Object.values(ranks)) {
    assert.ok(rank >= 1 && rank <= 100, "precedence_rank is CHECK (between 1 and 100)");
  }
});

test("legacy classification is evidence and never rewrites the catalogue type", () => {
  const result = run([sourceRow()]);
  assert.equal(result.review_decisions[0].steam_type, "game");
  assert.equal(result.review_decisions[0].precedence_rank, 10);
  assert.ok(!("game_type" in result.games[0]));
  assert.ok(!("lifecycle_status" in result.games[0]));
});

test("a steam_type the forced-classification rule does not cover is returned unresolved", () => {
  assert.equal(failureCode(() => run([sourceRow({ steam_type: "dlc" })])), "catalogue_classification_unresolved");
  assert.equal(failureCode(() => run([sourceRow({ steam_type: "demo" })])), "catalogue_classification_unresolved");
});

test("the evidence source_record_key is unique per source relation", () => {
  const result = run([sourceRow({ steam_appid: "440" }), sourceRow({ steam_appid: "70" })]);
  const keys = result.review_decisions.map((decision) => `${decision.source_relation}|${decision.source_record_key}`);
  assert.equal(new Set(keys).size, keys.length);
});

/* -------------------------------------------------------------------------
 * Identity, stubs, run identity and safe failures
 * ---------------------------------------------------------------------- */

test("a stub becomes a labelled catalogue row with no invented instants", () => {
  const result = run([sourceRow({ steam_appid: "440" })], { stubAppIds: ["70"] });
  assert.equal(result.games.length, 2);
  const stubGame = result.games.find((game) => game.steam_app_id === "70");
  assert.ok(stubGame);
  assert.equal(stubGame.title, "Steam App 70");
  assert.equal(stubGame.normalized_sort_title, "steam app 70");
  assert.equal(stubGame.title_source, "catalog_stub");
  assert.equal(stubGame.source_kind, "stub");
  assert.equal(stubGame.first_seen_at, null);
  assert.equal(stubGame.last_seen_at, null);
  assert.equal(stubGame.updated_at, null);
  assert.equal(stubGame.first_seen_reason, "unknown");
  // A stub has no metadata, features, offer or classification evidence.
  assert.equal(result.game_metadata.length, 1);
  assert.equal(result.game_features.length, 1);
  assert.equal(result.review_decisions.length, 1);
  assert.equal(result.counts.stub_rows, 1);
});

test("duplicate source rows for one AppID fail explicitly", () => {
  const rows = [sourceRow({ steam_appid: "440" }), sourceRow({ steam_appid: "440" })];
  const built = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }] });
  assert.equal(
    failureCode(() =>
      transformCatalogue({ runIdentity: RUN, gameMap: built.map, rows, offerPolicy: OFFER_POLICY }),
    ),
    "catalogue_duplicate_row",
  );
});

test("a source row missing from the map fails rather than inventing an identity", () => {
  const built = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }] });
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [sourceRow({ steam_appid: "440" }), sourceRow({ steam_appid: "70" })],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_game_unmapped",
  );
});

test("a map entry with no source row fails rather than leaving a dangling key", () => {
  const built = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }, { steam_appid: "70" }] });
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [sourceRow({ steam_appid: "440" })],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_map_unmatched",
  );
});

/* -------------------------------------------------------------------------
 * Root catalogue review, defect 1: source_kind must agree with the map
 * ---------------------------------------------------------------------- */

test("a catalog_games row cannot claim an AppID the map resolved as a stub", () => {
  const built = buildGameMap({
    runIdentity: RUN,
    catalogueGames: [],
    stubs: [
      {
        steam_appid: "70",
        title_provenance: "catalog_stub_fallback" as const,
        required_by_relation: "completion_events",
        required_by_field: "steam_appid",
        reason: "resolved completion event with no catalogue row",
      },
    ],
    references: [{ relation: "completion_events", field: "steam_appid", steam_appid: "70" }],
  });
  // The map only ever resolved "70" as a stub; a real catalog_games row now
  // tries to claim that same identity as though it were catalogued.
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [sourceRow({ steam_appid: "70" })],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_source_kind_mismatch",
  );
});

test("a stub row cannot claim an AppID the map already resolved from the catalogue", () => {
  const built = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }] });
  const catalogedEntry = built.map.entries.find((entry) => entry.legacy_app_id === "440");
  assert.ok(catalogedEntry);
  // A stub record that is otherwise perfectly valid, but names the AppID the
  // map already resolved as a genuine catalogue identity.
  const forgedStub: GameStubTargetRecord = {
    legacy_app_id: "440",
    game_id: catalogedEntry.game_id,
    title: "Steam App 440",
    normalized_sort_title: "steam app 440",
    title_source: "catalog_stub",
    title_provenance: "catalog_stub_fallback",
    required_by_relation: "completion_events",
    required_by_field: "steam_appid",
    reason: "resolved completion event with no catalogue row",
    source_snapshot_hash: RUN.snapshotHash,
  };
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [],
        stubs: [forgedStub],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_source_kind_mismatch",
  );
});

/* -------------------------------------------------------------------------
 * Root catalogue review, defect 2: a stub record is validated at the public
 * transform's boundary, not merely trusted by shape
 * ---------------------------------------------------------------------- */

test("refuses an externally supplied stub with a null title rather than emitting it", () => {
  const built = buildGameMap({
    runIdentity: RUN,
    catalogueGames: [],
    stubs: [
      {
        steam_appid: "70",
        title_provenance: "catalog_stub_fallback" as const,
        required_by_relation: "completion_events",
        required_by_field: "steam_appid",
        reason: "resolved completion event with no catalogue row",
      },
    ],
    references: [{ relation: "completion_events", field: "steam_appid", steam_appid: "70" }],
  });
  const realStub = built.stubs[0];
  // A copied stub record with its title erased.  The boundary must refuse
  // this rather than emit a `catalog.games` row with a NULL/invalid title.
  const tamperedStub = { ...realStub, title: null } as unknown as GameStubTargetRecord;
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [],
        stubs: [tamperedStub],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_stub_invalid",
  );
});

test("refuses an externally supplied stub whose normalized title was tampered", () => {
  const built = buildGameMap({
    runIdentity: RUN,
    catalogueGames: [],
    stubs: [
      {
        steam_appid: "70",
        title_provenance: "catalog_stub_fallback" as const,
        required_by_relation: "completion_events",
        required_by_field: "steam_appid",
        reason: "resolved completion event with no catalogue row",
      },
    ],
    references: [{ relation: "completion_events", field: "steam_appid", steam_appid: "70" }],
  });
  const realStub = built.stubs[0];
  const tamperedStub = { ...realStub, normalized_sort_title: "not derived from the title" };
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [],
        stubs: [tamperedStub],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_stub_invalid",
  );
});

test("a genuinely built stub still passes the boundary validation unchanged", () => {
  // Regression guard: the new boundary validation must not reject the exact
  // stub this module already accepted as valid.
  const result = run([sourceRow({ steam_appid: "440" })], { stubAppIds: ["70"] });
  const stubGame = result.games.find((game) => game.steam_app_id === "70");
  assert.ok(stubGame);
  assert.equal(stubGame.title, "Steam App 70");
});

test("a map from another run is refused", () => {
  const otherRunMap = buildGameMap({ runIdentity: OTHER_RUN, catalogueGames: [{ steam_appid: "440" }] });
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: otherRunMap.map,
        rows: [sourceRow()],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_mixed_run_identity",
  );
});

test("a row annotated with another run is refused", () => {
  const built = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }] });
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [{ ...sourceRow(), run_id: OTHER_RUN.runId }],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_mixed_run_identity",
  );
});

test("malformed source AppIDs and explicit NULL run aliases use stable catalogue failures", () => {
  const built = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }] });
  for (const steam_appid of ["0", "4294967296", "007", null]) {
    assert.equal(
      failureCode(() =>
        transformCatalogue({
          runIdentity: RUN,
          gameMap: built.map,
          rows: [sourceRow({ steam_appid })],
          offerPolicy: OFFER_POLICY,
        }),
      ),
      steam_appid === "0" || steam_appid === "4294967296" ? "catalogue_invalid_integer" : "catalogue_input_invalid",
      `expected a stable failure for AppID ${String(steam_appid)}`,
    );
  }
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: RUN,
        gameMap: built.map,
        rows: [{ ...sourceRow(), run_id: null } as never],
        offerPolicy: OFFER_POLICY,
      }),
    ),
    "catalogue_mixed_run_identity",
  );
});

test("an invalid run identity fails before any row is read", () => {
  const built = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }] });
  assert.equal(
    failureCode(() =>
      transformCatalogue({
        runIdentity: { runId: "r", snapshotHash: "nope" },
        gameMap: built.map,
        rows: [sourceRow()],
      } as never),
    ),
    "catalogue_run_invalid",
  );
});

test("the row bound is enforced", () => {
  const rows = [sourceRow({ steam_appid: "1" }), sourceRow({ steam_appid: "2" }), sourceRow({ steam_appid: "3" })];
  const built = mapFor(rows);
  assert.equal(
    failureCode(() =>
      transformCatalogue(
        { runIdentity: RUN, gameMap: built.map, rows, offerPolicy: OFFER_POLICY },
        { maxRows: 2 },
      ),
    ),
    "catalogue_count_limit",
  );
});

test("failures carry a stable code, a relation and a count but no source value", () => {
  try {
    run([sourceRow({ name: "A Very Private Title".repeat(40) })]);
    assert.fail("expected a CatalogueTransformError");
  } catch (error) {
    assert.ok(error instanceof CatalogueTransformError);
    assert.equal(error.catalogueCode, "catalogue_text_bounds");
    assert.equal(error.details.relation, "catalog_games");
    assert.equal(error.details.field, "name");
    assert.equal(error.details.count, 1);
    const serialized = JSON.stringify(error.toJSON());
    assert.ok(!serialized.includes("Private"), serialized);
    assert.ok(!serialized.includes("440"), serialized);
  }
});

test("a tag document failure never prints the document", () => {
  try {
    run([sourceRow({ tags: '{"private-tag":"do-not-print"}' })]);
    assert.fail("expected a CatalogueTransformError");
  } catch (error) {
    assert.ok(error instanceof CatalogueTransformError);
    const serialized = JSON.stringify(error.toJSON());
    assert.ok(!serialized.includes("do-not-print"), serialized);
    assert.ok(!serialized.includes("private-tag"), serialized);
  }
});

test("an empty batch is valid and produces nothing", () => {
  const built = buildGameMap({ runIdentity: RUN, catalogueGames: [] });
  const result = transformCatalogue({ runIdentity: RUN, gameMap: built.map, rows: [] });
  assert.deepEqual(result.games, []);
  assert.deepEqual(result.offers, []);
  assert.equal(result.counts.source_rows, 0);
  assert.equal(result.run_identity.snapshot_hash, RUN.snapshotHash);
});
