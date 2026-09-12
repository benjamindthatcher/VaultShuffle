import assert from "node:assert/strict";
import test from "node:test";
import { LibraryTransformError } from "./library-shared.ts";
import {
  canonicalHistoryResult,
  transformHistoryBatch,
  type CompletionEventSourceRow,
  type HistoryTransformInput,
  type PlaytimeSnapshotSourceRow,
  type PurgeReviewSourceRow,
} from "./history.ts";
import type { LibraryRowMapRecord } from "./library.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Expectations are written directly against the destination columns. The three
 * rules under test are that daily totals stay cumulative and unrepaired, that
 * every source event keeps exactly one identity across the resolved and
 * unknown relations, and that a purge review never becomes a completion event.
 */

const SNAPSHOT = "f".repeat(64);
const RUN = Object.freeze({ runId: "history-test-run", snapshotHash: SNAPSHOT });
const ACCOUNT_A = "20000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "20000000-0000-4000-8000-00000000000b";
const ROW_A10 = "30000000-0000-4000-8000-000000000001";
const ROW_A220 = "30000000-0000-4000-8000-000000000002";
const ROW_B10 = "30000000-0000-4000-8000-000000000003";
const ROW_GONE = "30000000-0000-4000-8000-0000000000ff";
const EVENT_1 = "50000000-0000-4000-8000-000000000001";
const EVENT_2 = "50000000-0000-4000-8000-000000000002";
const EVENT_3 = "50000000-0000-4000-8000-000000000003";
const REVIEW_1 = "60000000-0000-4000-8000-000000000001";
const REVIEW_2 = "60000000-0000-4000-8000-000000000002";

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

const GAME_MAP = Object.freeze({
  run_identity: { run_id: RUN.runId, snapshot_hash: SNAPSHOT },
  entries: [
    { legacy_app_id: "10", game_id: 7, source_kind: "catalog_games" as const, source_snapshot_hash: SNAPSHOT },
    { legacy_app_id: "220", game_id: 8, source_kind: "catalog_games" as const, source_snapshot_hash: SNAPSHOT },
  ],
});

const LIBRARY_ROW_MAP: readonly LibraryRowMapRecord[] = Object.freeze([
  { legacy_id: ROW_A10, account_id: 1, game_id: 7, steam_appid: "10", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ROW_A220, account_id: 1, game_id: 8, steam_appid: "220", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ROW_B10, account_id: 2, game_id: 7, steam_appid: "10", source_snapshot_hash: SNAPSHOT },
]);

function input(overrides: Partial<HistoryTransformInput> = {}): HistoryTransformInput {
  return {
    runIdentity: RUN,
    accountMap: ACCOUNT_MAP,
    gameMap: GAME_MAP,
    libraryRowMap: LIBRARY_ROW_MAP,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PlaytimeSnapshotSourceRow> = {}): PlaytimeSnapshotSourceRow {
  return {
    user_id: ACCOUNT_A,
    captured_on: "2026-02-01",
    total_minutes: "1000",
    games_with_playtime: "3",
    created_at: "2026-02-01 23:59:59.999999+00",
    ...overrides,
  };
}

function event(overrides: Partial<CompletionEventSourceRow> = {}): CompletionEventSourceRow {
  return {
    id: EVENT_1,
    user_id: ACCOUNT_A,
    game_id: ROW_A10,
    steam_appid: "10",
    source: "sweep",
    claimed_at: "2026-02-01 00:00:00+00",
    undone_at: null,
    hours_played: null,
    estimate_minutes: null,
    price_cents: null,
    ...overrides,
  };
}

function review(overrides: Partial<PurgeReviewSourceRow> = {}): PurgeReviewSourceRow {
  return {
    id: REVIEW_1,
    user_id: ACCOUNT_A,
    game_id: ROW_A10,
    action: "keep",
    reviewed_at: "2026-02-05 00:00:00+00",
    playtime_minutes_at_review: "600",
    progress_at_review: "42",
    last_played_at_review: "2026-02-04 00:00:00+00",
    ...overrides,
  };
}

function conflictCount(
  result: { conflicts: readonly { conflict_class: string; conflict_count: number }[] },
  name: string,
): number {
  return result.conflicts
    .filter((entry) => entry.conflict_class === name)
    .reduce((total, entry) => total + entry.conflict_count, 0);
}

test("a daily snapshot is copied verbatim as a cumulative total", () => {
  const result = transformHistoryBatch(
    input({ playtimeSnapshots: [snapshot({ total_minutes: "9223372036854775807", games_with_playtime: "2147483647" })] }),
  );
  assert.deepEqual(
    result.playtime_daily.map((entry) => ({
      account_id: entry.account_id,
      activity_day: entry.activity_day.toIsoString(),
      observed_minutes: entry.observed_minutes,
      observed_minutes_semantic: entry.observed_minutes_semantic,
      games_with_playtime: entry.games_with_playtime,
      coverage: entry.coverage,
      recorded_at: entry.recorded_at.canonicalUtc,
    })),
    [
      {
        account_id: 1,
        activity_day: "2026-02-01",
        observed_minutes: "9223372036854775807",
        observed_minutes_semantic: "cumulative_total",
        games_with_playtime: 2147483647,
        coverage: "unknown",
        recorded_at: "2026-02-01T23:59:59.999999Z",
      },
    ],
  );
});

test("consecutive days keep both cumulative totals and are never differenced", () => {
  const result = transformHistoryBatch(
    input({
      playtimeSnapshots: [
        snapshot({ captured_on: "2026-02-01", total_minutes: "1000" }),
        snapshot({ captured_on: "2026-02-02", total_minutes: "1100" }),
      ],
    }),
  );
  assert.deepEqual(
    result.playtime_daily.map((entry) => entry.observed_minutes),
    ["1000", "1100"],
  );
  assert.equal(conflictCount(result, "playtime_daily_cumulative_decrease"), 0);
});

test("a decreasing cumulative series is preserved as a conflict, not repaired", () => {
  const result = transformHistoryBatch(
    input({
      playtimeSnapshots: [
        snapshot({ captured_on: "2026-02-02", total_minutes: "900" }),
        snapshot({ captured_on: "2026-02-01", total_minutes: "1000" }),
      ],
    }),
  );
  assert.deepEqual(
    result.playtime_daily.map((entry) => [entry.activity_day.toIsoString(), entry.observed_minutes]),
    [
      ["2026-02-01", "1000"],
      ["2026-02-02", "900"],
    ],
  );
  assert.equal(conflictCount(result, "playtime_daily_cumulative_decrease"), 1);
});

test("a decrease across two accounts on the same day is not reported", () => {
  const result = transformHistoryBatch(
    input({
      playtimeSnapshots: [
        snapshot({ user_id: ACCOUNT_A, captured_on: "2026-02-01", total_minutes: "1000" }),
        snapshot({ user_id: ACCOUNT_B, captured_on: "2026-02-01", total_minutes: "5" }),
      ],
    }),
  );
  assert.equal(conflictCount(result, "playtime_daily_cumulative_decrease"), 0);
});

test("civil days copy across without a timezone or an instant conversion", () => {
  const result = transformHistoryBatch(
    input({
      playtimeSnapshots: [
        snapshot({ captured_on: "2024-02-29" }),
        snapshot({ captured_on: "2026-01-01" }),
        snapshot({ captured_on: "2026-12-31" }),
      ],
    }),
  );
  assert.deepEqual(
    result.playtime_daily.map((entry) => entry.activity_day.toIsoString()),
    ["2024-02-29", "2026-01-01", "2026-12-31"],
  );
});

test("a non-existent day and a duplicate day are refused", () => {
  assert.throws(
    () => transformHistoryBatch(input({ playtimeSnapshots: [snapshot({ captured_on: "2026-02-30" })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_civil_date",
  );
  assert.throws(
    () => transformHistoryBatch(input({ playtimeSnapshots: [snapshot(), snapshot()] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_duplicate_identity",
  );
  assert.throws(
    () => transformHistoryBatch(input({ playtimeSnapshots: [snapshot({ games_with_playtime: "-1" })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_integer",
  );
});

test("a completion event that resolves through the library map keeps its whole identity", () => {
  const result = transformHistoryBatch(
    input({
      completionEvents: [
        event({
          source: "details",
          claimed_at: "2026-02-01 10:00:00.000001+00",
          undone_at: "2026-02-02 10:00:00+00",
          hours_played: "12.5",
          estimate_minutes: "600",
          price_cents: "1999",
        }),
      ],
    }),
  );
  assert.equal(result.unknown_completion_history.length, 0);
  assert.deepEqual(
    result.completion_events.map((entry) => ({
      account_id: entry.account_id,
      game_id: entry.game_id,
      occurred_at: entry.occurred_at.canonicalUtc,
      undone_at: entry.undone_at?.canonicalUtc ?? null,
      source: entry.source,
      dedupe_key: entry.dedupe_key,
      legacy_event_id: entry.legacy_event_id,
      origin_surface: entry.origin_surface,
      legacy_game_id: entry.legacy_game_id,
      legacy_steam_appid: entry.legacy_steam_appid,
      legacy_hours_played: entry.legacy_hours_played,
      legacy_hours_played_raw: entry.legacy_hours_played_raw,
      legacy_estimate_minutes: entry.legacy_estimate_minutes,
      legacy_price_cents: entry.legacy_price_cents,
      metric_provenance: entry.metric_provenance,
    })),
    [
      {
        account_id: 1,
        game_id: 7,
        occurred_at: "2026-02-01T10:00:00.000001Z",
        undone_at: "2026-02-02T10:00:00.000000Z",
        source: "user",
        dedupe_key: null,
        legacy_event_id: EVENT_1,
        origin_surface: "details",
        legacy_game_id: ROW_A10,
        legacy_steam_appid: "10",
        legacy_hours_played: "12.5",
        legacy_hours_played_raw: "12.5",
        legacy_estimate_minutes: 600,
        legacy_price_cents: 1999,
        metric_provenance: {
          hours: "legacy_double_precision_hours",
          hours_exact_in_numeric_30_12: true,
          estimate_minutes: "legacy_exact_minutes",
          price_cents: "legacy_usd_cents",
        },
      },
    ],
  );
  assert.deepEqual(result.completion_event_registry, [
    { legacy_event_id: EVENT_1, account_id: 1, record_kind: "resolved", source_snapshot_hash: SNAPSHOT },
  ]);
});

test("all six legacy surfaces survive while the actor stays 'user'", () => {
  const surfaces = ["sweep", "sweep_bulk", "library", "vault", "purge", "details"] as const;
  const result = transformHistoryBatch(
    input({
      completionEvents: surfaces.map((surface, index) =>
        event({ id: `50000000-0000-4000-8000-00000000001${index}`, source: surface }),
      ),
    }),
  );
  assert.deepEqual(
    result.completion_events.map((entry) => entry.origin_surface).sort(),
    [...surfaces].sort(),
  );
  assert.deepEqual(new Set(result.completion_events.map((entry) => entry.source)), new Set(["user"]));
});

test("the AppID fallback resolves an event whose library row is gone", () => {
  const viaAppId = transformHistoryBatch(input({ completionEvents: [event({ game_id: null, steam_appid: "220" })] }));
  assert.equal(viaAppId.completion_events[0].game_id, 8);
  assert.equal(viaAppId.completion_events[0].legacy_game_id, null);

  const staleRow = transformHistoryBatch(input({ completionEvents: [event({ game_id: ROW_GONE, steam_appid: "220" })] }));
  assert.equal(staleRow.completion_events[0].game_id, 8);
  assert.equal(staleRow.completion_events[0].legacy_game_id, ROW_GONE);
});

test("an event with no resolvable identity is retained rather than given an invented game", () => {
  const result = transformHistoryBatch(
    input({ completionEvents: [event({ id: EVENT_2, game_id: null, steam_appid: null, undone_at: "2026-02-03 00:00:00+00" })] }),
  );
  assert.equal(result.completion_events.length, 0);
  assert.deepEqual(
    result.unknown_completion_history.map((entry) => ({
      legacy_event_id: entry.legacy_event_id,
      account_id: entry.account_id,
      source_game_id: entry.source_game_id,
      source_steam_appid: entry.source_steam_appid,
      actor: entry.actor,
      origin_surface: entry.origin_surface,
      occurred_at: entry.occurred_at.canonicalUtc,
      undone_at: entry.undone_at?.canonicalUtc ?? null,
      state: entry.state,
      source_snapshot_hash: entry.source_snapshot_hash,
    })),
    [
      {
        legacy_event_id: EVENT_2,
        account_id: 1,
        source_game_id: null,
        source_steam_appid: null,
        actor: "user",
        origin_surface: "sweep",
        occurred_at: "2026-02-01T00:00:00.000000Z",
        undone_at: "2026-02-03T00:00:00.000000Z",
        state: "undone",
        source_snapshot_hash: SNAPSHOT,
      },
    ],
  );
  assert.deepEqual(result.completion_event_registry, [
    { legacy_event_id: EVENT_2, account_id: 1, record_kind: "unknown", source_snapshot_hash: SNAPSHOT },
  ]);
  assert.equal(conflictCount(result, "completion_identity_absent"), 1);
});

test("an unresolvable named identity keeps its original nullable identifiers", () => {
  const result = transformHistoryBatch(
    input({ completionEvents: [event({ game_id: ROW_GONE, steam_appid: null })] }),
  );
  assert.equal(result.unknown_completion_history[0].source_game_id, ROW_GONE);
  assert.equal(result.unknown_completion_history[0].source_steam_appid, null);
  assert.equal(conflictCount(result, "completion_identity_unresolved"), 1);
});

test("a library row from another account cannot resolve an event", () => {
  const result = transformHistoryBatch(
    input({ completionEvents: [event({ user_id: ACCOUNT_B, game_id: ROW_A220, steam_appid: null })] }),
  );
  assert.equal(result.completion_events.length, 0);
  assert.equal(result.unknown_completion_history[0].account_id, 2);
  assert.equal(conflictCount(result, "completion_library_row_cross_account"), 1);
});

test("event identity is never duplicated across the two history relations", () => {
  const result = transformHistoryBatch(
    input({
      completionEvents: [
        event({ id: EVENT_1 }),
        event({ id: EVENT_2, game_id: null, steam_appid: null }),
        event({ id: EVENT_3, game_id: ROW_A220, steam_appid: "220" }),
      ],
    }),
  );
  const ids = [
    ...result.completion_events.map((entry) => entry.legacy_event_id),
    ...result.unknown_completion_history.map((entry) => entry.legacy_event_id),
  ];
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.completion_event_registry.length, ids.length);
  assert.deepEqual(
    result.completion_event_registry.map((entry) => entry.legacy_event_id).sort(),
    [...ids].sort(),
  );

  assert.throws(
    () => transformHistoryBatch(input({ completionEvents: [event({ id: EVENT_1 }), event({ id: EVENT_1 })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_duplicate_identity",
  );
});

test("an undo that precedes its claim is withheld into a segregated exception, never loaded or reordered", () => {
  const result = transformHistoryBatch(
    input({
      completionEvents: [
        event({ id: EVENT_1, claimed_at: "2026-02-05 00:00:00+00", undone_at: "2026-02-01 00:00:00+00" }),
      ],
    }),
  );
  assert.equal(result.completion_events.length, 0);
  assert.equal(result.unknown_completion_history.length, 0);
  assert.equal(result.completion_event_registry.length, 0);
  assert.equal(result.completion_ordering_exceptions.length, 1);
  const exception = result.completion_ordering_exceptions[0];
  assert.equal(exception.legacy_event_id, EVENT_1);
  assert.equal(exception.occurred_at.canonicalUtc, "2026-02-05T00:00:00.000000Z");
  assert.equal(exception.undone_at.canonicalUtc, "2026-02-01T00:00:00.000000Z");
  assert.equal(conflictCount(result, "completion_undone_before_occurred"), 1);
});

test("an inverted event with a resolvable game identity is still withheld, not loaded as resolved history", () => {
  const result = transformHistoryBatch(
    input({
      completionEvents: [
        event({
          id: EVENT_1,
          game_id: ROW_A10,
          steam_appid: "10",
          claimed_at: "2026-02-05 00:00:00+00",
          undone_at: "2026-02-01 00:00:00+00",
        }),
        event({ id: EVENT_2, game_id: ROW_A220, steam_appid: "220" }),
      ],
    }),
  );
  assert.equal(result.completion_events.length, 1);
  assert.equal(result.completion_events[0].legacy_event_id, EVENT_2);
  assert.equal(result.completion_ordering_exceptions.length, 1);
  assert.equal(result.completion_ordering_exceptions[0].legacy_event_id, EVENT_1);
  // Every source event counted exactly once across loadable and exception paths.
  const total =
    result.completion_events.length + result.unknown_completion_history.length + result.completion_ordering_exceptions.length;
  assert.equal(total, 2);
  assert.equal(result.completion_event_registry.length, 1);
  assert.equal(result.completion_event_registry[0].legacy_event_id, EVENT_2);
});

test("an undo exactly at its claim time is normal ordering, not an exception", () => {
  const result = transformHistoryBatch(
    input({
      completionEvents: [
        event({ id: EVENT_1, claimed_at: "2026-02-05 00:00:00+00", undone_at: "2026-02-05 00:00:00+00" }),
      ],
    }),
  );
  assert.equal(result.completion_ordering_exceptions.length, 0);
  assert.equal(result.completion_events.length, 1);
  assert.equal(conflictCount(result, "completion_undone_before_occurred"), 0);
});

test("hours that exceed the target numeric scale keep their exact source text", () => {
  const result = transformHistoryBatch(
    input({ completionEvents: [event({ hours_played: "3.0999999999999996" })] }),
  );
  assert.equal(result.completion_events[0].legacy_hours_played, null);
  assert.equal(result.completion_events[0].legacy_hours_played_raw, "3.0999999999999996");
  assert.equal(result.completion_events[0].metric_provenance.hours_exact_in_numeric_30_12, false);
  assert.equal(conflictCount(result, "completion_hours_precision_exceeds_target"), 1);
});

test("a non-finite hours value is preserved as text and never becomes minutes", () => {
  for (const text of ["NaN", "Infinity", "-Infinity"]) {
    const result = transformHistoryBatch(input({ completionEvents: [event({ hours_played: text })] }));
    assert.equal(result.completion_events[0].legacy_hours_played, null);
    assert.equal(result.completion_events[0].legacy_hours_played_raw, text);
    assert.equal(result.completion_events[0].metric_provenance.hours_finite, false);
    assert.equal(conflictCount(result, "completion_hours_not_finite"), 1);
  }
});

test("malformed and negative hours never masquerade as non-finite or valid numeric data", () => {
  assert.throws(
    () => transformHistoryBatch(input({ completionEvents: [event({ hours_played: "private-note" })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_decimal",
  );
  const negative = transformHistoryBatch(input({ completionEvents: [event({ hours_played: "-1.25" })] }));
  assert.equal(negative.completion_events[0].legacy_hours_played, null);
  assert.equal(negative.completion_events[0].legacy_hours_played_raw, "-1.25");
  assert.equal(negative.completion_events[0].metric_provenance.hours_nonnegative, false);
  assert.equal(conflictCount(negative, "completion_hours_negative"), 1);
});

test("metric provenance stays a small plain JSON object", () => {
  const result = transformHistoryBatch(
    input({ completionEvents: [event({ hours_played: "1.0", estimate_minutes: "5", price_cents: "0" })] }),
  );
  const text = JSON.stringify(result.completion_events[0].metric_provenance);
  assert.equal(text.startsWith("{"), true);
  assert.ok(Buffer.byteLength(text, "utf8") <= 8192);
  assert.equal(result.completion_events[0].legacy_price_cents, 0);
});

test("a purge review keeps its decision and never becomes a completion event", () => {
  const result = transformHistoryBatch(
    input({ purgeReviews: [review({ action: "complete" })], completionEvents: [] }),
  );
  assert.equal(result.completion_events.length, 0);
  assert.equal(result.unknown_completion_history.length, 0);
  assert.equal(result.completion_event_registry.length, 0);
  assert.deepEqual(
    result.purge_review_history.map((entry) => ({
      account_id: entry.account_id,
      game_id: entry.game_id,
      steam_app_id: entry.steam_app_id,
      action: entry.action,
      reviewed_at: entry.reviewed_at.canonicalUtc,
      playtime_minutes_at_review: entry.playtime_minutes_at_review,
      progress_at_review: entry.progress_at_review,
      last_played_at_review: entry.last_played_at_review?.canonicalUtc ?? null,
      source_snapshot_hash: entry.source_snapshot_hash,
    })),
    [
      {
        account_id: 1,
        game_id: 7,
        steam_app_id: "10",
        action: "complete",
        reviewed_at: "2026-02-05T00:00:00.000000Z",
        playtime_minutes_at_review: 600,
        progress_at_review: 42,
        last_played_at_review: "2026-02-04T00:00:00.000000Z",
        source_snapshot_hash: SNAPSHOT,
      },
    ],
  );
  assert.equal(result.legacy_purge_review_archive[0].source_game_id, ROW_A10);
  assert.equal(result.legacy_purge_review_archive[0].retention_class, "staging-30d-post-cutover");
  assert.equal(conflictCount(result, "purge_complete_without_completion_event"), 1);
});

test("a complete review with a matching completion event is counted separately", () => {
  const result = transformHistoryBatch(
    input({ purgeReviews: [review({ action: "complete" })], completionEvents: [event()] }),
  );
  assert.equal(conflictCount(result, "purge_complete_with_completion_event"), 1);
  assert.equal(conflictCount(result, "purge_complete_without_completion_event"), 0);
  assert.equal(result.completion_events.length, 1);
});

test("a review whose library row is gone keeps the decision with a null identity", () => {
  const result = transformHistoryBatch(input({ purgeReviews: [review({ game_id: ROW_GONE })] }));
  assert.equal(result.purge_review_history[0].game_id, null);
  assert.equal(result.purge_review_history[0].steam_app_id, null);
  assert.equal(result.legacy_purge_review_archive[0].source_game_id, ROW_GONE);
  assert.equal(conflictCount(result, "purge_review_library_row_absent"), 1);
});

test("a preservation-gate key collision is reported without dropping a decision", () => {
  const result = transformHistoryBatch(
    input({
      purgeReviews: [review({ id: REVIEW_1 }), review({ id: REVIEW_2, game_id: ROW_A220, action: "pin" })],
    }),
  );
  assert.equal(result.purge_review_history.length, 2);
  assert.equal(conflictCount(result, "purge_review_gate_key_collision"), 1);
});

test("equal-time purge decisions sort by their full durable tuple", () => {
  const reviews = [
    review({ id: REVIEW_1, game_id: ROW_A220, action: "pin", playtime_minutes_at_review: "700" }),
    review({ id: REVIEW_2, game_id: ROW_A10, action: "keep", playtime_minutes_at_review: "600" }),
  ];
  const forward = canonicalHistoryResult(transformHistoryBatch(input({ purgeReviews: reviews })));
  const reversed = canonicalHistoryResult(
    transformHistoryBatch(input({ purgeReviews: [...reviews].reverse() })),
  );
  assert.equal(forward, reversed);
  assert.deepEqual(
    transformHistoryBatch(input({ purgeReviews: reviews })).purge_review_history.map((entry) => entry.game_id),
    [7, 8],
  );
});

test("output is identical under permuted input order", () => {
  const playtimeSnapshots = [
    snapshot({ user_id: ACCOUNT_B, captured_on: "2026-02-03", total_minutes: "7" }),
    snapshot({ captured_on: "2026-02-02", total_minutes: "1100" }),
    snapshot({ captured_on: "2026-02-01", total_minutes: "1000" }),
  ];
  const completionEvents = [
    event({ id: EVENT_3, game_id: ROW_A220, steam_appid: "220" }),
    event({ id: EVENT_1 }),
    event({ id: EVENT_2, game_id: null, steam_appid: null }),
  ];
  const purgeReviews = [
    review({ id: REVIEW_2, game_id: ROW_A220, reviewed_at: "2026-02-06 00:00:00+00" }),
    review({ id: REVIEW_1 }),
  ];
  const forward = canonicalHistoryResult(
    transformHistoryBatch(input({ playtimeSnapshots, completionEvents, purgeReviews })),
  );
  const reversed = canonicalHistoryResult(
    transformHistoryBatch(
      input({
        playtimeSnapshots: [...playtimeSnapshots].reverse(),
        completionEvents: [...completionEvents].reverse(),
        purgeReviews: [...purgeReviews].reverse(),
      }),
    ),
  );
  assert.equal(forward, reversed);
});

test("foreign runs, unmapped accounts and row bounds fail explicitly", () => {
  assert.throws(
    () => transformHistoryBatch(input({ completionEvents: [event({ run_id: "other" })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
  assert.throws(
    () =>
      transformHistoryBatch(
        input({ playtimeSnapshots: [snapshot({ user_id: "20000000-0000-4000-8000-0000000000ff" })] }),
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_account_unmapped",
  );
  assert.throws(
    () =>
      transformHistoryBatch(
        input({ playtimeSnapshots: [snapshot({ captured_on: "2026-02-01" }), snapshot({ captured_on: "2026-02-02" })] }),
        { maxRows: 1 },
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_row_limit",
  );
  assert.throws(
    () =>
      transformHistoryBatch(
        input({ libraryRowMap: [{ ...LIBRARY_ROW_MAP[0], source_snapshot_hash: "a".repeat(64) }] }),
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
});

test("failures carry no event identity or measurement", () => {
  try {
    transformHistoryBatch(input({ completionEvents: [event({ hours_played: "h".repeat(200) })] }));
    assert.fail("expected a library transform failure");
  } catch (error) {
    assert.ok(error instanceof LibraryTransformError);
    const serialized = JSON.stringify(error.toJSON());
    assert.equal(serialized.includes(EVENT_1), false);
    assert.equal(serialized.includes(ACCOUNT_A), false);
    assert.equal(serialized.includes("hhh"), false);
  }
});

test("a cumulative total at the bigint boundary stays exact text", () => {
  const maxBigint = "9223372036854775807";
  const result = transformHistoryBatch(
    input({ playtimeSnapshots: [snapshot({ total_minutes: maxBigint, games_with_playtime: "2147483647" })] }),
  );
  assert.equal(result.playtime_daily[0].observed_minutes, maxBigint);
  assert.equal(result.playtime_daily[0].games_with_playtime, 2147483647);
  // A double cannot hold this value; the text must not have gone through one.
  assert.notEqual(result.playtime_daily[0].observed_minutes, String(Number(maxBigint)));
  assert.throws(
    () => transformHistoryBatch(input({ playtimeSnapshots: [snapshot({ total_minutes: "9223372036854775808" })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_integer",
  );
});

test("an unchanged cumulative total across days is not a decrease", () => {
  const result = transformHistoryBatch(
    input({
      playtimeSnapshots: [
        snapshot({ captured_on: "2026-02-01", total_minutes: "1000" }),
        snapshot({ captured_on: "2026-02-02", total_minutes: "1000" }),
      ],
    }),
  );
  assert.equal(conflictCount(result, "playtime_daily_cumulative_decrease"), 0);
  assert.deepEqual(result.playtime_daily.map((entry) => entry.observed_minutes), ["1000", "1000"]);
});

test("games_with_playtime is copied independently of the total and never reconciled", () => {
  const result = transformHistoryBatch(
    input({ playtimeSnapshots: [snapshot({ total_minutes: "5000", games_with_playtime: "0" })] }),
  );
  assert.equal(result.playtime_daily[0].observed_minutes, "5000");
  assert.equal(result.playtime_daily[0].games_with_playtime, 0);
  assert.equal(result.playtime_daily[0].coverage, "unknown");
  assert.equal(result.playtime_daily[0].observed_minutes_semantic, "cumulative_total");
  assert.equal(result.conflicts.length, 0);
});

test("civil days order across a leap day and a year boundary without an instant", () => {
  const result = transformHistoryBatch(
    input({
      playtimeSnapshots: [
        snapshot({ captured_on: "2024-03-01", total_minutes: "40" }),
        snapshot({ captured_on: "2023-12-31", total_minutes: "10" }),
        snapshot({ captured_on: "2024-02-29", total_minutes: "30" }),
        snapshot({ captured_on: "2024-01-01", total_minutes: "20" }),
      ],
    }),
  );
  assert.deepEqual(
    result.playtime_daily.map((entry) => entry.activity_day.sourceText),
    ["2023-12-31", "2024-01-01", "2024-02-29", "2024-03-01"],
  );
  assert.deepEqual(result.playtime_daily.map((entry) => entry.observed_minutes), ["10", "20", "30", "40"]);
  assert.equal(conflictCount(result, "playtime_daily_cumulative_decrease"), 0);
  assert.throws(
    () => transformHistoryBatch(input({ playtimeSnapshots: [snapshot({ captured_on: "2023-02-29" })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_civil_date",
  );
});

test("an event names an AppID the catalogue map does not hold and stays unknown history", () => {
  const result = transformHistoryBatch(
    input({ completionEvents: [event({ game_id: null, steam_appid: "999999" })] }),
  );
  assert.equal(result.completion_events.length, 0);
  assert.deepEqual(
    result.unknown_completion_history.map((entry) => [entry.source_game_id, entry.source_steam_appid]),
    [[null, "999999"]],
  );
  assert.deepEqual(result.completion_event_registry, [
    { legacy_event_id: EVENT_1, account_id: 1, record_kind: "unknown", source_snapshot_hash: SNAPSHOT },
  ]);
  assert.equal(conflictCount(result, "completion_identity_unresolved"), 1);
});

test("a mixed batch keeps one identity per event across both history relations", () => {
  const result = transformHistoryBatch(
    input({
      completionEvents: [
        event({ id: EVENT_1, game_id: ROW_A10, steam_appid: "10" }),
        event({ id: EVENT_2, game_id: null, steam_appid: null, source: "vault" }),
        event({ id: EVENT_3, user_id: ACCOUNT_B, game_id: ROW_A10, steam_appid: "10", source: "details" }),
      ],
    }),
  );
  const ids = [
    ...result.completion_events.map((entry) => entry.legacy_event_id),
    ...result.unknown_completion_history.map((entry) => entry.legacy_event_id),
  ];
  assert.equal(new Set(ids).size, 3);
  assert.equal(result.completion_event_registry.length, 3);
  // EVENT_3 names account B's event but a library row owned by account A; the
  // AppID fallback resolves it for account B without borrowing A's row.
  const forB = result.completion_events.find((entry) => entry.account_id === 2);
  assert.equal(forB?.game_id, 7);
  assert.equal(forB?.legacy_game_id, ROW_A10);
  assert.equal(conflictCount(result, "completion_library_row_cross_account"), 1);
  assert.equal(conflictCount(result, "completion_identity_absent"), 1);
});

test("estimate and price metrics stay exact integers at the int32 boundary", () => {
  const result = transformHistoryBatch(
    input({
      completionEvents: [event({ estimate_minutes: "2147483647", price_cents: "0", hours_played: "0" })],
    }),
  );
  assert.equal(result.completion_events[0].legacy_estimate_minutes, 2147483647);
  assert.equal(result.completion_events[0].legacy_price_cents, 0);
  assert.equal(result.completion_events[0].legacy_hours_played, "0");
  assert.deepEqual(result.completion_events[0].metric_provenance, {
    hours: "legacy_double_precision_hours",
    hours_exact_in_numeric_30_12: true,
    estimate_minutes: "legacy_exact_minutes",
    price_cents: "legacy_usd_cents",
  });
  assert.throws(
    () => transformHistoryBatch(input({ completionEvents: [event({ estimate_minutes: "2147483648" })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_integer",
  );
});

test("a purge review keeps a null progress distinct from a zero progress", () => {
  const result = transformHistoryBatch(
    input({
      purgeReviews: [
        review({ id: REVIEW_1, progress_at_review: null }),
        review({ id: REVIEW_2, game_id: ROW_A220, progress_at_review: "0", reviewed_at: "2026-02-06 00:00:00+00" }),
      ],
    }),
  );
  assert.deepEqual(
    result.purge_review_history.map((entry) => entry.progress_at_review),
    [null, 0],
  );
  assert.equal(result.legacy_purge_review_archive.length, 2);
});

test("malformed JSON-shaped history inputs are refused instead of being coerced", () => {
  assert.throws(
    () => transformHistoryBatch(input({ libraryRowMap: [null as unknown as LibraryRowMapRecord] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
  assert.throws(
    () =>
      transformHistoryBatch(
        input({ libraryRowMap: [{ ...LIBRARY_ROW_MAP[0], steam_appid: 10 as unknown as string }] }),
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
  assert.throws(
    () =>
      transformHistoryBatch(
        input({ libraryRowMap: [{ ...LIBRARY_ROW_MAP[0], game_id: 8 }] }),
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_game_map_invalid",
  );
  assert.throws(
    () => transformHistoryBatch(input({ playtimeSnapshots: ["2026-02-01" as unknown as PlaytimeSnapshotSourceRow] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
  assert.throws(
    () => transformHistoryBatch(input({ purgeReviews: [review({ action: "purge" })] })),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_enum",
  );
});
