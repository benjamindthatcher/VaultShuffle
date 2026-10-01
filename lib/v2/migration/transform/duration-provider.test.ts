import assert from "node:assert/strict";
import test from "node:test";
import {
  DURATION_REVIEW_SOURCE,
  transformDurationAliases,
  transformDurationEstimates,
  transformDurationImportRuns,
  transformDurationReviews,
  ProviderTransformError,
  type DurationAliasSourceRow,
  type DurationEstimateSourceRow,
  type DurationImportRunSourceRow,
  type DurationReviewSourceRow,
} from "./duration-provider.ts";
import { buildGameMap, type GameMap } from "./games.ts";

const RUN = Object.freeze({ runId: "duration-provider-test-run", snapshotHash: "b".repeat(64) });

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

function accountMap(entries: readonly { legacy_id: string; account_id: number }[]): unknown {
  return entries.map((entry) => ({ ...entry, source_kind: "app_accounts", source_snapshot_hash: RUN.snapshotHash }));
}

/* -------------------------------------------------------------------------
 * game_duration_estimates -> catalog.duration_estimates
 * ---------------------------------------------------------------------- */

function estimateRow(overrides: Partial<DurationEstimateSourceRow> = {}): DurationEstimateSourceRow {
  return {
    steam_app_id: "440",
    provider: "hltb",
    provider_game_id: "12345",
    main_story_minutes: "600",
    main_extra_minutes: "900",
    completionist_minutes: "1200",
    submission_count: "50",
    match_status: "matched",
    match_confidence: "high",
    provider_updated_at: "2026-01-01 00:00:00+00",
    checked_at: "2026-01-02 00:00:00+00",
    next_refresh_at: "2026-02-01 00:00:00+00",
    last_error_code: null,
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-01-02 00:00:00+00",
    evidence: '{"raw":"payload"}',
    ...overrides,
  };
}

test("an estimate for an app the catalogue does not hold still loads, with a NULL game_id", () => {
  const map = mapWith("70");
  const result = transformDurationEstimates({ runIdentity: RUN, gameMap: map, rows: [estimateRow()] });
  assert.equal(result.duration_estimates[0].game_id, null);
  assert.equal(result.duration_estimates[0].steam_app_id, "440");
  assert.equal(result.counts.unmapped, 1);
});

test("exact minutes and evidence survive without unit conversion or reserialisation", () => {
  const map = mapWith("440");
  const result = transformDurationEstimates({
    runIdentity: RUN,
    gameMap: map,
    rows: [estimateRow({ main_story_minutes: "0", evidence: '{"a":9223372036854775807}' })],
  });
  const estimate = result.duration_estimates[0];
  assert.equal(estimate.main_story_minutes, 0);
  assert.equal(estimate.evidence.text, '{"a":9223372036854775807}');
});

test("IGDB estimates are explicitly retired while HLTB evidence remains", () => {
  const map = mapWith("440");
  const result = transformDurationEstimates({
    runIdentity: RUN,
    gameMap: map,
    rows: [estimateRow({ provider: "hltb" }), estimateRow({ provider: "igdb" })],
  });
  assert.equal(result.duration_estimates.length, 1);
  assert.deepEqual(result.counts, { rows: 2, retained: 1, retired: 1, mapped: 1, unmapped: 0 });
});

test("a duplicate (steam_app_id, provider) pair fails explicitly", () => {
  const map = mapWith("440");
  assert.equal(
    failureCode(() =>
      transformDurationEstimates({ runIdentity: RUN, gameMap: map, rows: [estimateRow(), estimateRow()] }),
    ),
    "provider_duplicate_row",
  );
});

test("an unknown match_status fails rather than passing through", () => {
  const map = mapWith("440");
  assert.equal(
    failureCode(() =>
      transformDurationEstimates({
        runIdentity: RUN,
        gameMap: map,
        rows: [estimateRow({ match_status: "unknown" as DurationEstimateSourceRow["match_status"] })],
      }),
    ),
    "provider_invalid_enum",
  );
});

/* -------------------------------------------------------------------------
 * game_duration_aliases -> catalog.duration_aliases
 * ---------------------------------------------------------------------- */

function aliasRow(overrides: Partial<DurationAliasSourceRow> = {}): DurationAliasSourceRow {
  return {
    steam_app_id: "440",
    search_title: "Team Fortress 2 Classic",
    release_year: "2007",
    review_status: "approved",
    notes: "Rescue for a re-released SKU.",
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-01-01 00:00:00+00",
    ...overrides,
  };
}

test("an alias rescuing an unmatched AppID keeps a NULL game_id, not an error", () => {
  const map = mapWith("70");
  const result = transformDurationAliases({ runIdentity: RUN, gameMap: map, rows: [aliasRow()] });
  assert.equal(result.duration_aliases[0].game_id, null);
});

test("release_year stays an integer year, never widened into a date", () => {
  const map = mapWith("440");
  const result = transformDurationAliases({ runIdentity: RUN, gameMap: map, rows: [aliasRow({ release_year: "1998" })] });
  assert.equal(result.duration_aliases[0].release_year, 1998);
});

test("a duplicate alias AppID fails explicitly", () => {
  const map = mapWith("440");
  assert.equal(
    failureCode(() => transformDurationAliases({ runIdentity: RUN, gameMap: map, rows: [aliasRow(), aliasRow()] })),
    "provider_duplicate_row",
  );
});

/* -------------------------------------------------------------------------
 * catalog_duration_reviews -> catalog.review_decisions (decision_kind='duration')
 * ---------------------------------------------------------------------- */

function reviewRow(overrides: Partial<DurationReviewSourceRow> = {}): DurationReviewSourceRow {
  return {
    steam_appid: "440",
    response_text: "Corrected main story time using a fresh HLTB submission batch.",
    response_kind: "hltb_url",
    source_url: "https://howlongtobeat.com/game/440",
    reviewer_user_id: "0f6a6e5c-2222-4c22-8c22-222222222222",
    reviewed_at: "2026-01-05 00:00:00+00",
    updated_at: "2026-01-06 00:00:00+00",
    ...overrides,
  };
}

test("the source's enforced catalog_games FK means an unmapped AppID is a real transform failure", () => {
  const map = mapWith("70");
  assert.equal(
    failureCode(() =>
      transformDurationReviews({ runIdentity: RUN, gameMap: map, accountMap: accountMap([]), rows: [reviewRow()] }),
    ),
    "provider_game_unmapped",
  );
});

test("a review by a mapped reviewer resolves reviewer_account_id", () => {
  const map = mapWith("440");
  const uuid = "0f6a6e5c-2222-4c22-8c22-222222222222";
  const result = transformDurationReviews({
    runIdentity: RUN,
    gameMap: map,
    accountMap: accountMap([{ legacy_id: uuid, account_id: 7 }]),
    rows: [reviewRow({ reviewer_user_id: uuid })],
  });
  assert.equal(result.review_decisions[0].reviewer_account_id, 7);
  assert.equal(result.counts.reviewer_mapped, 1);
});

test("a review by a since-deleted reviewer keeps a NULL reviewer rather than being dropped", () => {
  const map = mapWith("440");
  const result = transformDurationReviews({
    runIdentity: RUN,
    gameMap: map,
    accountMap: accountMap([]),
    rows: [reviewRow()],
  });
  assert.equal(result.review_decisions.length, 1);
  assert.equal(result.review_decisions[0].reviewer_account_id, null);
  assert.equal(result.counts.reviewer_deleted, 1);
});

test("a review naming no reviewer needs no account map at all", () => {
  const map = mapWith("440");
  const result = transformDurationReviews({
    runIdentity: RUN,
    gameMap: map,
    rows: [reviewRow({ reviewer_user_id: null })],
  });
  assert.equal(result.review_decisions[0].reviewer_account_id, null);
});

test("response_kind and source_url pairing is enforced in both directions", () => {
  const map = mapWith("440");
  assert.equal(
    failureCode(() =>
      transformDurationReviews({
        runIdentity: RUN,
        gameMap: map,
        rows: [reviewRow({ response_kind: "hltb_url", source_url: null, reviewer_user_id: null })],
      }),
    ),
    "provider_json_shape_conflict",
  );
  assert.equal(
    failureCode(() =>
      transformDurationReviews({
        runIdentity: RUN,
        gameMap: map,
        rows: [reviewRow({ response_kind: "note", source_url: "https://example.com", reviewer_user_id: null })],
      }),
    ),
    "provider_json_shape_conflict",
  );
});

test("created_at reuses the review's own reviewed_at instant rather than inventing one", () => {
  const map = mapWith("440");
  const result = transformDurationReviews({
    runIdentity: RUN,
    gameMap: map,
    rows: [reviewRow({ reviewed_at: "2026-03-01 09:00:00+00", updated_at: "2026-03-02 09:00:00+00", reviewer_user_id: null })],
  });
  const decision = result.review_decisions[0];
  assert.equal(decision.created_at.canonicalUtc, "2026-03-01T09:00:00.000000Z");
  assert.equal(decision.updated_at.canonicalUtc, "2026-03-02T09:00:00.000000Z");
  assert.equal(decision.source, DURATION_REVIEW_SOURCE);
  assert.equal(decision.decision_status, "retained");
});

test("a duplicate duration review AppID fails explicitly", () => {
  const map = mapWith("440");
  assert.equal(
    failureCode(() =>
      transformDurationReviews({
        runIdentity: RUN,
        gameMap: map,
        rows: [reviewRow({ reviewer_user_id: null }), reviewRow({ reviewer_user_id: null })],
      }),
    ),
    "provider_duplicate_row",
  );
});

/* -------------------------------------------------------------------------
 * catalog_duration_import_runs -> catalog.duration_imports
 * ---------------------------------------------------------------------- */

function importRunRow(overrides: Partial<DurationImportRunSourceRow> = {}): DurationImportRunSourceRow {
  return {
    id: "0f6a6e5c-3333-4c33-8c33-333333333333",
    source: "hltb_bulk_export",
    imported_count: "900",
    skipped_count: "100",
    source_updated_at: "2025-12-31 00:00:00+00",
    created_at: "2026-01-01 00:00:00+00",
    source_sha256: "c".repeat(64),
    expected_app_count: "1000",
    staged_row_count: "1000",
    status: "succeeded",
    completed_at: "2026-01-01 01:00:00+00",
    manifest: '{"files":["a.csv"]}',
    ...overrides,
  };
}

test("manifest jsonb survives verbatim and status is asserted against the target vocabulary", () => {
  const result = transformDurationImportRuns({ runIdentity: RUN, rows: [importRunRow()] });
  assert.equal(result.duration_imports[0].manifest.text, '{"files":["a.csv"]}');
  assert.equal(result.duration_imports[0].status, "succeeded");
});

test("the source completed import label maps to the target succeeded terminal state", () => {
  const result = transformDurationImportRuns({
    runIdentity: RUN,
    rows: [importRunRow({ status: "completed" })],
  });
  assert.equal(result.duration_imports[0].status, "succeeded");
  assert.equal(result.duration_imports[0].completed_at?.canonicalUtc, "2026-01-01T01:00:00.000000Z");
});

test("an unknown import status fails rather than passing through", () => {
  assert.equal(
    failureCode(() =>
      transformDurationImportRuns({
        runIdentity: RUN,
        rows: [importRunRow({ status: "queued" as DurationImportRunSourceRow["status"] })],
      }),
    ),
    "provider_invalid_enum",
  );
});

test("completed_at before created_at is a reported order conflict", () => {
  assert.equal(
    failureCode(() =>
      transformDurationImportRuns({
        runIdentity: RUN,
        rows: [importRunRow({ created_at: "2026-01-05 00:00:00+00", completed_at: "2026-01-01 00:00:00+00" })],
      }),
    ),
    "provider_order_conflict",
  );
});

test("a duplicate import run id fails explicitly", () => {
  assert.equal(
    failureCode(() => transformDurationImportRuns({ runIdentity: RUN, rows: [importRunRow(), importRunRow()] })),
    "provider_duplicate_row",
  );
});

test("unknown providers are refused rather than silently discarded", () => {
  assert.equal(failureCode(() => transformDurationEstimates({ runIdentity: RUN, gameMap: mapWith("440"),
    rows: [estimateRow({ provider: "steamspy" })] })), "provider_invalid_enum");
});
test("IGDB import provenance is retired without preserving its manifest", () => {
  const result = transformDurationImportRuns({ runIdentity: RUN,
    rows: [importRunRow(), importRunRow({ id: "0f6a6e5c-2222-4c22-8c22-222222222222", source: "igdb_bulk_export" })] });
  assert.equal(result.duration_imports.length, 1);
  assert.deepEqual(result.counts, { rows: 2, retained: 1, retired: 1 });
});
