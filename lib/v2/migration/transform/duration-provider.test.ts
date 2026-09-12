import assert from "node:assert/strict";
import test from "node:test";
import {
  DURATION_REVIEW_SOURCE,
  transformDurationAliases,
  transformDurationEstimates,
  transformDurationImportRuns,
  transformDurationJobArchive,
  transformDurationReviews,
  ProviderTransformError,
  type DurationAliasSourceRow,
  type DurationEstimateSourceRow,
  type DurationImportRunSourceRow,
  type DurationJobSourceRow,
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

test("the same AppID may have one estimate per distinct provider", () => {
  const map = mapWith("440");
  const result = transformDurationEstimates({
    runIdentity: RUN,
    gameMap: map,
    rows: [estimateRow({ provider: "hltb" }), estimateRow({ provider: "steamspy" })],
  });
  assert.equal(result.duration_estimates.length, 2);
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

/* -------------------------------------------------------------------------
 * game_duration_jobs -> migration.legacy_duration_job_archive
 * ---------------------------------------------------------------------- */

function jobRow(overrides: Partial<DurationJobSourceRow> = {}): DurationJobSourceRow {
  return {
    steam_app_id: "440",
    status: "failed",
    priority: "10",
    attempts: "5",
    next_attempt_at: null,
    locked_at: null,
    locked_by: null,
    last_error_code: "provider_timeout",
    last_error_message: "Request to provider timed out after 30s.",
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-01-02 00:00:00+00",
    ...overrides,
  };
}

test("the duration job archive keeps earned failure history and drops the three retired columns", () => {
  const result = transformDurationJobArchive({ runIdentity: RUN, gameMap: mapWith("440"), rows: [jobRow()] });
  const archived = result.archive[0];
  assert.equal(archived.status, "failed");
  assert.equal(archived.attempts, 5);
  assert.equal(archived.last_error_code, "provider_timeout");
  assert.equal((archived as unknown as Record<string, unknown>).priority, undefined);
  assert.equal((archived as unknown as Record<string, unknown>).locked_by, undefined);
  assert.equal((archived as unknown as Record<string, unknown>).locked_at, undefined);
});

test("an exhausted duration job on a catalogued app keeps its state and fence durably", () => {
  const result = transformDurationJobArchive({
    runIdentity: RUN,
    gameMap: mapWith("440"),
    rows: [jobRow({ next_attempt_at: "2026-01-02 00:00:00+00" })],
  });
  assert.equal(result.terminal_rejections.length, 0, "a catalogued app is held by provider_state, not by AppID");
  assert.equal(result.provider_state.length, 1);
  const state = result.provider_state[0];
  assert.equal(state.evidence_kind, "duration");
  assert.equal(state.status, "failed");
  assert.equal(state.failure_count, 5);
  assert.equal(state.next_attempt_at?.canonicalUtc, "2026-01-02T00:00:00.000000Z");
  assert.equal(state.last_error_code, "provider_timeout");
  assert.equal(state.last_error, "Request to provider timed out after 30s.");
  // The job row records no fetch instant of its own; none is invented.
  assert.equal(state.fetched_at, null);
});

test("a retry job's backoff fence survives as failed-with-a-fence, the only shape the target permits", () => {
  const result = transformDurationJobArchive({
    runIdentity: RUN,
    gameMap: mapWith("440"),
    rows: [jobRow({ status: "retry", attempts: "2", next_attempt_at: "2026-01-02 04:00:00+00" })],
  });
  const state = result.provider_state[0];
  assert.equal(state.status, "failed");
  assert.equal(state.failure_count, 2);
  assert.equal(state.next_attempt_at?.canonicalUtc, "2026-01-02T04:00:00.000000Z");
});

test("an uncatalogued retry job with a live fence blocks instead of losing its backoff", () => {
  assert.equal(
    failureCode(() =>
      transformDurationJobArchive({
        runIdentity: RUN,
        gameMap: mapWith("220"),
        rows: [jobRow({ status: "retry", attempts: "2", next_attempt_at: "2026-01-02 04:00:00+00" })],
      }),
    ),
    "provider_physical_gap",
  );
});

test("a needs_review verdict separates 'the provider has nothing' from 'a person must decide'", () => {
  const notFound = transformDurationJobArchive({
    runIdentity: RUN,
    gameMap: mapWith("999"),
    rows: [jobRow({ status: "needs_review", last_error_code: "duration_not_found", last_error_message: null })],
  });
  assert.equal(notFound.terminal_rejections.length, 1);
  assert.equal(notFound.terminal_rejections[0].terminal_status, "not_found");
  assert.equal(notFound.terminal_rejections[0].last_error_code, "duration_not_found");

  const noTimes = transformDurationJobArchive({
    runIdentity: RUN,
    gameMap: mapWith("999"),
    rows: [jobRow({ status: "needs_review", last_error_code: "known_title_no_provider_times", last_error_message: null })],
  });
  assert.equal(noTimes.terminal_rejections[0].terminal_status, "no_match");

  // A conflict awaiting a human is review state, not a terminal rejection.
  const conflict = transformDurationJobArchive({
    runIdentity: RUN,
    gameMap: mapWith("440"),
    rows: [jobRow({ status: "needs_review", last_error_code: "duration_provider_identity_conflict" })],
  });
  assert.equal(conflict.terminal_rejections.length, 0);
  assert.equal(conflict.provider_state[0].status, "review_required");

  assert.equal(
    failureCode(() =>
      transformDurationJobArchive({
        runIdentity: RUN,
        gameMap: mapWith("999"),
        rows: [jobRow({ status: "needs_review", last_error_code: "duration_provider_identity_conflict" })],
      }),
    ),
    "provider_physical_gap",
  );
});

test("a terminal duration verdict for an uncatalogued app is keyed by AppID with its exact instants", () => {
  const result = transformDurationJobArchive({ runIdentity: RUN, gameMap: mapWith("220"), rows: [jobRow()] });
  assert.equal(result.provider_state.length, 0);
  const verdict = result.terminal_rejections[0];
  assert.equal(verdict.steam_app_id, "440");
  assert.equal(verdict.evidence_kind, "duration");
  assert.equal(verdict.terminal_status, "permanently_failed");
  assert.equal(verdict.reason, "Request to provider timed out after 30s.");
  assert.equal(verdict.attempts, 5);
  assert.equal(verdict.source_relation, "game_duration_jobs");
  assert.equal(verdict.first_requested_at?.canonicalUtc, "2026-01-01T00:00:00.000000Z");
  assert.equal(verdict.last_attempt_at.canonicalUtc, "2026-01-02T00:00:00.000000Z");
  assert.equal(result.counts.unmapped, 1);
});

test("a duplicate job AppID fails explicitly", () => {
  assert.equal(
    failureCode(() => transformDurationJobArchive({ runIdentity: RUN, gameMap: mapWith("440"), rows: [jobRow(), jobRow()] })),
    "provider_duplicate_row",
  );
});
