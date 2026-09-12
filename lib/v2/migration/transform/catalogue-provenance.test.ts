import assert from "node:assert/strict";
import test from "node:test";
import {
  transformGameQuarantine,
  transformGuestCataloguePool,
  transformIngestQueueArchive,
  transformSeedRuns,
  ProviderTransformError,
  type GuestCataloguePoolSourceRow,
  type IngestQueueSourceRow,
  type QuarantineSourceRow,
  type SeedRunSourceRow,
} from "./catalogue-provenance.ts";
import { buildGameMap, type GameMap } from "./games.ts";

const RUN = Object.freeze({ runId: "provenance-test-run", snapshotHash: "a".repeat(64) });

function mapWith(...appIds: string[]): GameMap {
  return buildGameMap({ runIdentity: RUN, catalogueGames: appIds.map((steam_appid) => ({ steam_appid })) }).map;
}

function failureCode(execute: () => unknown): string {
  try {
    execute();
  } catch (error) {
    assert.ok(error instanceof ProviderTransformError, `expected ProviderTransformError, received ${String(error)}`);
    return error.providerCode;
  }
  assert.fail("expected a ProviderTransformError");
}

/* -------------------------------------------------------------------------
 * catalog_game_quarantine -> catalog.review_decisions
 * ---------------------------------------------------------------------- */

function quarantineRow(overrides: Partial<QuarantineSourceRow> = {}): QuarantineSourceRow {
  return {
    steam_appid: "9999",
    name: "Not A Game",
    steam_type: "advertising",
    matched_rule: "advertising_keyword",
    reason: "Title matched the advertising-app keyword list.",
    genres: "{Utilities}",
    categories: "{}",
    review_status: "pending",
    source: "automatic",
    first_detected_at: "2026-01-01 00:00:00+00",
    last_detected_at: "2026-01-05 00:00:00+00",
    reviewed_at: null,
    review_notes: null,
    updated_at: "2026-01-05 00:00:00+00",
    ...overrides,
  };
}

test("a quarantined app absent from the catalogue keeps a NULL game_id, not an error", () => {
  const map = mapWith("440");
  const result = transformGameQuarantine({ runIdentity: RUN, gameMap: map, rows: [quarantineRow()] });
  assert.equal(result.review_decisions.length, 1);
  assert.equal(result.review_decisions[0].game_id, null);
  assert.equal(result.review_decisions[0].steam_app_id, "9999");
  assert.equal(result.counts.mapped, 0);
  assert.equal(result.counts.unmapped, 1);
});

test("a quarantined app the catalogue also holds resolves its game_id", () => {
  const map = mapWith("9999");
  const result = transformGameQuarantine({ runIdentity: RUN, gameMap: map, rows: [quarantineRow()] });
  assert.equal(result.review_decisions[0].game_id, 1);
  assert.equal(result.counts.mapped, 1);
});

test("automatic and manual quarantine sources get distinct precedence ranks", () => {
  const map = mapWith("440");
  const auto = transformGameQuarantine({
    runIdentity: RUN,
    gameMap: map,
    rows: [quarantineRow({ source: "automatic" })],
  });
  const manual = transformGameQuarantine({
    runIdentity: RUN,
    gameMap: map,
    rows: [quarantineRow({ steam_appid: "8888", source: "manual" })],
  });
  assert.ok(manual.review_decisions[0].precedence_rank > auto.review_decisions[0].precedence_rank);
  assert.equal(auto.review_decisions[0].source, "automatic");
  assert.equal(manual.review_decisions[0].source, "manual");
});

test("genres and categories preserve exact element order as a JSON array", () => {
  const map = mapWith("440");
  const result = transformGameQuarantine({
    runIdentity: RUN,
    gameMap: map,
    rows: [quarantineRow({ genres: '{Action,"Free to Play"}', categories: "{}" })],
  });
  const decision = result.review_decisions[0];
  assert.deepEqual(JSON.parse(decision.genres as string), ["Action", "Free to Play"]);
  assert.deepEqual(decision.genres_elements, ["Action", "Free to Play"]);
  assert.deepEqual(JSON.parse(decision.categories as string), []);
});

test("last_detected_at is embedded in source_payload, not silently dropped", () => {
  const map = mapWith("440");
  const result = transformGameQuarantine({
    runIdentity: RUN,
    gameMap: map,
    rows: [quarantineRow({ last_detected_at: "2026-03-01 12:00:00+00" })],
  });
  const payload = JSON.parse(result.review_decisions[0].source_payload.text);
  assert.equal(payload.last_detected_at, "2026-03-01T12:00:00.000000Z");
});

test("first_detected_at becomes created_at; updated_at is preserved separately", () => {
  const map = mapWith("440");
  const result = transformGameQuarantine({
    runIdentity: RUN,
    gameMap: map,
    rows: [quarantineRow({ first_detected_at: "2026-01-01 00:00:00+00", updated_at: "2026-02-02 00:00:00+00" })],
  });
  const decision = result.review_decisions[0];
  assert.equal(decision.created_at.canonicalUtc, "2026-01-01T00:00:00.000000Z");
  assert.equal(decision.updated_at.canonicalUtc, "2026-02-02T00:00:00.000000Z");
});

test("a duplicate quarantine AppID fails explicitly", () => {
  const map = mapWith("440");
  assert.equal(
    failureCode(() =>
      transformGameQuarantine({ runIdentity: RUN, gameMap: map, rows: [quarantineRow(), quarantineRow()] }),
    ),
    "provider_duplicate_row",
  );
});

test("a review_status outside the source's own declared domain fails rather than passing through", () => {
  const map = mapWith("440");
  assert.equal(
    failureCode(() =>
      transformGameQuarantine({
        runIdentity: RUN,
        gameMap: map,
        rows: [quarantineRow({ review_status: "unresolved" as QuarantineSourceRow["review_status"] })],
      }),
    ),
    "provider_invalid_enum",
  );
});

test("a missing quarantine column is a broken shape, not an absent value", () => {
  const map = mapWith("440");
  const row = quarantineRow() as Record<string, unknown>;
  delete row.reason;
  assert.equal(
    failureCode(() => transformGameQuarantine({ runIdentity: RUN, gameMap: map, rows: [row as QuarantineSourceRow] })),
    "provider_input_invalid",
  );
});

/* -------------------------------------------------------------------------
 * catalog_ingest_queue -> migration.legacy_ingest_queue_archive
 * ---------------------------------------------------------------------- */

function ingestQueueRow(overrides: Partial<IngestQueueSourceRow> = {}): IngestQueueSourceRow {
  return {
    steam_appid: "440",
    status: "rejected",
    reason: "manual",
    priority: "50",
    requested_count: "3",
    source_rank: "1",
    source_payload: '{"raw":"payload"}',
    attempts: "2",
    next_attempt_at: null,
    processing_started_at: null,
    last_error: "rate limited",
    rejection_reason: "not a real game",
    first_requested_at: "2026-01-01 00:00:00+00",
    last_requested_at: "2026-01-02 00:00:00+00",
    processed_at: "2026-01-02 00:00:00+00",
    updated_at: "2026-01-02 00:00:00+00",
    ...overrides,
  };
}

test("the ingest queue archive keeps earned history and drops the three retired columns", () => {
  // The rejected AppID is NOT in the catalogue: that is what a rejection
  // means, and it is exactly the case app.provider_state cannot hold.
  const result = transformIngestQueueArchive({ runIdentity: RUN, gameMap: mapWith("220"), rows: [ingestQueueRow()] });
  const archived = result.archive[0];
  assert.equal(archived.steam_appid, "440");
  assert.equal(archived.status, "rejected");
  assert.equal(archived.requested_count, 3);
  assert.equal(archived.source_rank, 1);
  assert.equal(archived.attempts, 2);
  assert.equal(archived.last_error, "rate limited");
  assert.equal(archived.rejection_reason, "not a real game");
  assert.equal((archived as unknown as Record<string, unknown>).priority, undefined);
  assert.equal((archived as unknown as Record<string, unknown>).source_payload, undefined);
  assert.equal((archived as unknown as Record<string, unknown>).processing_started_at, undefined);
});

test("a rejected AppID with no catalogue row survives as a durable terminal verdict, not only in expiring staging", () => {
  const result = transformIngestQueueArchive({ runIdentity: RUN, gameMap: mapWith("220"), rows: [ingestQueueRow()] });
  assert.equal(result.provider_state.length, 0);
  assert.equal(result.terminal_rejections.length, 1);
  const verdict = result.terminal_rejections[0];
  assert.equal(verdict.steam_app_id, "440");
  assert.equal(verdict.evidence_kind, "ingest");
  assert.equal(verdict.terminal_status, "rejected");
  // The source's own rejection text, never a summary of it.
  assert.equal(verdict.reason, "not a real game");
  assert.equal(verdict.attempts, 2);
  assert.equal(verdict.source_relation, "catalog_ingest_queue");
  assert.equal(verdict.first_requested_at?.canonicalUtc, "2026-01-01T00:00:00.000000Z");
  assert.equal(verdict.last_attempt_at.canonicalUtc, "2026-01-02T00:00:00.000000Z");
  assert.equal(verdict.retry_allowed_after, null);
  assert.equal(result.counts.terminal, 1);
  assert.equal(result.counts.terminal_mapped, 0);
});

test("an exhausted-attempt failure keeps its retry fence and attempt count", () => {
  const result = transformIngestQueueArchive({
    runIdentity: RUN,
    gameMap: mapWith("220"),
    rows: [
      ingestQueueRow({
        status: "failed",
        rejection_reason: null,
        last_error: "Steam metadata was unavailable.",
        attempts: "5",
        processed_at: null,
        next_attempt_at: "2026-01-03 00:00:00+00",
      }),
    ],
  });
  const verdict = result.terminal_rejections[0];
  assert.equal(verdict.terminal_status, "permanently_failed");
  assert.equal(verdict.reason, "Steam metadata was unavailable.");
  assert.equal(verdict.attempts, 5);
  // Without this, ensure_catalogue_entries restarts the same app at attempt 0.
  assert.equal(verdict.retry_allowed_after?.canonicalUtc, "2026-01-03T00:00:00.000000Z");
  // processed_at is null on a failure, so the last attempt is updated_at.
  assert.equal(verdict.last_attempt_at.canonicalUtc, "2026-01-02T00:00:00.000000Z");
});

test("a terminal verdict with no source reason text states the source facts rather than inventing a cause", () => {
  const result = transformIngestQueueArchive({
    runIdentity: RUN,
    gameMap: mapWith("220"),
    rows: [ingestQueueRow({ status: "failed", rejection_reason: null, last_error: null, attempts: "5" })],
  });
  assert.match(result.terminal_rejections[0].reason, /catalog_ingest_queue\.status='failed' after 5 attempts/);
});

test("a queue row for an AppID the catalogue does hold becomes provider_state, not an AppID verdict", () => {
  const result = transformIngestQueueArchive({
    runIdentity: RUN,
    gameMap: mapWith("440"),
    rows: [ingestQueueRow({ status: "ready", rejection_reason: null, last_error: null, reason: "refresh" })],
  });
  assert.equal(result.terminal_rejections.length, 0);
  assert.equal(result.provider_state.length, 1);
  const state = result.provider_state[0];
  assert.equal(state.evidence_kind, "metadata");
  assert.equal(state.status, "ready");
  assert.equal(state.failure_count, 2);
  // processed_at is a real fetch instant, so it is the receipt time.
  assert.equal(state.fetched_at?.canonicalUtc, "2026-01-02T00:00:00.000000Z");
  // The target only permits a fence for pending/failed/review_required.
  assert.equal(state.next_attempt_at, null);
  assert.equal(state.updated_at.canonicalUtc, "2026-01-02T00:00:00.000000Z");
  assert.equal(result.counts.mapped, 1);
});

test("a mapped pending row keeps its backoff fence in durable provider state", () => {
  const result = transformIngestQueueArchive({
    runIdentity: RUN,
    gameMap: mapWith("440"),
    rows: [
      ingestQueueRow({
        status: "pending",
        rejection_reason: null,
        processed_at: null,
        next_attempt_at: "2026-01-04 06:00:00+00",
      }),
    ],
  });
  const state = result.provider_state[0];
  assert.equal(state.status, "pending");
  assert.equal(state.next_attempt_at?.canonicalUtc, "2026-01-04T06:00:00.000000Z");
  assert.equal(state.fetched_at, null);
});

test("an uncatalogued pending row with a live fence blocks instead of expiring its only backoff", () => {
  assert.equal(
    failureCode(() =>
      transformIngestQueueArchive({
        runIdentity: RUN,
        gameMap: mapWith("220"),
        rows: [
          ingestQueueRow({
            status: "pending",
            processed_at: null,
            rejection_reason: null,
            next_attempt_at: "2026-01-04 06:00:00+00",
          }),
        ],
      }),
    ),
    "provider_physical_gap",
  );
});

test("an uncatalogued ready row is a snapshot inconsistency, not disposable queue state", () => {
  assert.equal(
    failureCode(() =>
      transformIngestQueueArchive({
        runIdentity: RUN,
        gameMap: mapWith("220"),
        rows: [ingestQueueRow({ status: "ready", rejection_reason: null, last_error: null })],
      }),
    ),
    "provider_physical_gap",
  );
});

test("last_requested_at before first_requested_at is a reported order conflict", () => {
  assert.equal(
    failureCode(() =>
      transformIngestQueueArchive({
        runIdentity: RUN,
        gameMap: mapWith("440"),
        rows: [ingestQueueRow({ last_requested_at: "2025-12-31 00:00:00+00" })],
      }),
    ),
    "provider_order_conflict",
  );
});

test("a duplicate ingest queue AppID fails explicitly", () => {
  assert.equal(
    failureCode(() =>
      transformIngestQueueArchive({ runIdentity: RUN, gameMap: mapWith("440"), rows: [ingestQueueRow(), ingestQueueRow()] }),
    ),
    "provider_duplicate_row",
  );
});

test("an over-long terminal reason fails closed rather than being shortened into the durable column", () => {
  assert.equal(
    failureCode(() =>
      transformIngestQueueArchive({
        runIdentity: RUN,
        gameMap: mapWith("220"),
        rows: [ingestQueueRow({ rejection_reason: "x".repeat(5001) })],
      }),
    ),
    "provider_text_bounds",
  );
});

/* -------------------------------------------------------------------------
 * catalog_seed_runs -> catalog.seed_runs
 * ---------------------------------------------------------------------- */

function seedRunRow(overrides: Partial<SeedRunSourceRow> = {}): SeedRunSourceRow {
  return {
    id: "0f6a6e5c-1111-4c11-8c11-111111111111",
    source: "steamspy",
    metric: "owners",
    captured_at: "2026-01-01",
    requested_count: "1000",
    accepted_count: "900",
    source_url: "https://steamspy.com/api.php",
    source_sha256: "a".repeat(64),
    created_at: "2026-01-01 00:00:00+00",
    ...overrides,
  };
}

test("a seed run's captured date stays a civil date, never a timestamp", () => {
  const result = transformSeedRuns({ runIdentity: RUN, rows: [seedRunRow({ captured_at: "2026-03-04" })] });
  assert.equal(result.seed_runs[0].captured_on.toIsoString(), "2026-03-04");
});

test("accepted_count above requested_count is a reported order conflict", () => {
  assert.equal(
    failureCode(() =>
      transformSeedRuns({
        runIdentity: RUN,
        rows: [seedRunRow({ requested_count: "10", accepted_count: "11" })],
      }),
    ),
    "provider_order_conflict",
  );
});

test("a malformed seed run UUID is refused", () => {
  assert.equal(
    failureCode(() => transformSeedRuns({ runIdentity: RUN, rows: [seedRunRow({ id: "not-a-uuid" })] })),
    "provider_invalid_uuid",
  );
});

test("a duplicate seed run id fails explicitly", () => {
  assert.equal(
    failureCode(() => transformSeedRuns({ runIdentity: RUN, rows: [seedRunRow(), seedRunRow()] })),
    "provider_duplicate_row",
  );
});

/* -------------------------------------------------------------------------
 * guest_catalogue_pool: coverage accounting only
 * ---------------------------------------------------------------------- */

function poolRow(overrides: Partial<GuestCataloguePoolSourceRow> = {}): GuestCataloguePoolSourceRow {
  return {
    steam_appid: "440",
    position: "1",
    refreshed_at: "2026-01-01 00:00:00+00",
    ...overrides,
  };
}

test("guest pool coverage counts rows, mapping and duplicates without retaining a row array", () => {
  const map = mapWith("440");
  const result = transformGuestCataloguePool({
    runIdentity: RUN,
    gameMap: map,
    rows: [
      poolRow({ steam_appid: "440", position: "1" }),
      poolRow({ steam_appid: "70", position: "2" }),
      poolRow({ steam_appid: "70", position: "2" }),
    ],
  });
  const coverage = result.coverage;
  assert.equal(coverage.row_count, 3);
  assert.equal(coverage.distinct_app_ids, 2);
  assert.equal(coverage.duplicate_app_id_rows, 1);
  assert.equal(coverage.distinct_positions, 2);
  assert.equal(coverage.duplicate_position_rows, 1);
  assert.equal(coverage.mapped_app_ids, 1);
  assert.equal(coverage.unmapped_app_ids, 2);
  assert.equal(coverage.min_position, 1);
  assert.equal(coverage.max_position, 2);
  assert.equal((result as unknown as Record<string, unknown>).rows, undefined);
});

test("an empty guest pool produces zeroed coverage with null position/instant bounds", () => {
  const map = mapWith("440");
  const result = transformGuestCataloguePool({ runIdentity: RUN, gameMap: map, rows: [] });
  assert.equal(result.coverage.row_count, 0);
  assert.equal(result.coverage.min_position, null);
  assert.equal(result.coverage.max_position, null);
  assert.equal(result.coverage.earliest_refreshed_at, null);
  assert.equal(result.coverage.latest_refreshed_at, null);
});

test("guest pool coverage tracks the earliest and latest refresh instant", () => {
  const map = mapWith("440");
  const result = transformGuestCataloguePool({
    runIdentity: RUN,
    gameMap: map,
    rows: [
      poolRow({ steam_appid: "440", refreshed_at: "2026-02-01 00:00:00+00" }),
      poolRow({ steam_appid: "70", position: "2", refreshed_at: "2026-01-01 00:00:00+00" }),
    ],
  });
  assert.equal(result.coverage.earliest_refreshed_at?.canonicalUtc, "2026-01-01T00:00:00.000000Z");
  assert.equal(result.coverage.latest_refreshed_at?.canonicalUtc, "2026-02-01T00:00:00.000000Z");
});
