import assert from "node:assert/strict";
import test from "node:test";
import { LibraryTransformError } from "./library-shared.ts";
import {
  canonicalLibraryResult,
  transformLibraryBatch,
  type LibraryTransformInput,
  type UserGamesSourceRow,
} from "./library.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Expectations here are written independently of the transform: each assertion
 * names the exact record the M1/M3 destination should receive, derived from the
 * source values by hand rather than by re-running the production logic.
 */

const SNAPSHOT = "b".repeat(64);
const RUN = Object.freeze({ runId: "library-test-run", snapshotHash: SNAPSHOT });

const ACCOUNT_A = "20000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "20000000-0000-4000-8000-00000000000b";
const ROW_1 = "30000000-0000-4000-8000-000000000001";
const ROW_2 = "30000000-0000-4000-8000-000000000002";
const ROW_3 = "30000000-0000-4000-8000-000000000003";
const LENDER = "76561198000000042";

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

function gameMap(
  entries: readonly (readonly [string, number])[] = [["10", 7], ["220", 8], ["4294967295", 9]],
): LibraryTransformInput["gameMap"] {
  return {
    run_identity: { run_id: RUN.runId, snapshot_hash: SNAPSHOT },
    entries: entries.map(([appId, gameId]) => ({
      legacy_app_id: appId,
      game_id: gameId,
      source_kind: "catalog_games" as const,
      source_snapshot_hash: SNAPSHOT,
    })),
  };
}

function row(overrides: Partial<UserGamesSourceRow> = {}): UserGamesSourceRow {
  return {
    id: ROW_1,
    user_id: ACCOUNT_A,
    ownership: "Owned",
    status: "In Progress",
    hours_played: "1.5",
    completion_percentage: "0",
    date_added: null,
    notes: "",
    created_at: "2026-01-02 03:04:05.000000+00",
    updated_at: "2026-01-02 03:04:06.000000+00",
    last_played_at: null,
    completed_at: null,
    slept_at: null,
    completion_suggestion_dismissed_at: null,
    completion_suggestion_dismissed_playtime: null,
    previous_active_status: null,
    catalog_steam_appid: "10",
    last_observed_played_at: null,
    recency_source: null,
    recency_evidence_at: null,
    observed_playtime_minutes: "90",
    review_requested_at: null,
    access_source: "owned",
    family_owner_steam_id: null,
    family_verified_at: null,
    ...overrides,
  };
}

function input(rows: readonly UserGamesSourceRow[], map = gameMap()): LibraryTransformInput {
  return { runIdentity: RUN, accountMap: ACCOUNT_MAP, gameMap: map, userGames: rows };
}

function conflictCount(result: { conflicts: readonly { conflict_class: string; conflict_count: number }[] }, name: string): number {
  return result.conflicts
    .filter((entry) => entry.conflict_class === name)
    .reduce((total, entry) => total + entry.conflict_count, 0);
}

test("an owned personal row produces exactly one compact library row with exact minutes", () => {
  const result = transformLibraryBatch(input([row()]));
  assert.deepEqual(result.library_games, [{ account_id: 1, game_id: 7, playtime_minutes: 90 }]);
  assert.equal(result.retired_library_games.length, 0);
  assert.equal(result.family_access_candidates.length, 0);
  assert.equal(result.game_state.length, 0);
  assert.deepEqual(result.library_row_map, [
    { legacy_id: ROW_1, account_id: 1, game_id: 7, steam_appid: "10", source_snapshot_hash: SNAPSHOT },
  ]);
});

test("unknown minutes stay unknown and a zero legacy hours value never becomes an observed zero", () => {
  const result = transformLibraryBatch(
    input([row({ observed_playtime_minutes: null, hours_played: "0.0" })]),
  );
  assert.deepEqual(result.library_games, [{ account_id: 1, game_id: 7, playtime_minutes: null }]);
  // The import writer coalesces unknown minutes to zero before rounding, so a
  // zero hours value beside unknown minutes is reproducible and needs no
  // durable exception row.
  assert.equal(result.legacy_library_evidence[0].reproducible_from_observed, true);
  assert.equal(result.library_legacy_measurements.length, 0);
});

test("unknown minutes with nonzero legacy hours are preserved as an unreproducible exception", () => {
  const result = transformLibraryBatch(
    input([row({ observed_playtime_minutes: null, hours_played: "12.5" })]),
  );
  assert.equal(result.library_games[0].playtime_minutes, null);
  assert.equal(result.legacy_library_evidence[0].reproducible_from_observed, false);
  assert.deepEqual(
    result.library_legacy_measurements.map((entry) => ({
      steam_app_id: entry.steam_app_id,
      discrepancy_kind: entry.discrepancy_kind,
      legacy_hours_played: entry.legacy_hours_played,
      legacy_hours_played_raw: entry.legacy_hours_played_raw,
      observed_minutes_at_freeze: entry.observed_minutes_at_freeze,
      authorship: entry.authorship,
      authorship_evidence: entry.authorship_evidence,
    })),
    [
      {
        steam_app_id: "10",
        discrepancy_kind: "unknown_minutes_with_hours",
        legacy_hours_played: "12.5",
        legacy_hours_played_raw: "12.5",
        observed_minutes_at_freeze: null,
        authorship: "unknown",
        authorship_evidence: null,
      },
    ],
  );
  assert.equal(conflictCount(result, "library_playtime_precedence_unresolved"), 1);
});

test("the legacy hours formula is reproduced exactly at its rounding boundaries", () => {
  // 3 minutes is a tie for the 1dp import rounding: 3/60*10 = 0.5 tenths.
  const reproducible = transformLibraryBatch(input([row({ observed_playtime_minutes: "3", hours_played: "0.1" })]));
  assert.equal(reproducible.legacy_library_evidence[0].reproducible_from_observed, true);
  assert.equal(reproducible.library_legacy_measurements.length, 0);

  const notReproducible = transformLibraryBatch(input([row({ observed_playtime_minutes: "3", hours_played: "0.0" })]));
  assert.equal(notReproducible.legacy_library_evidence[0].reproducible_from_observed, false);
  assert.equal(notReproducible.library_legacy_measurements[0].discrepancy_kind, "hours_not_reproducible");

  // 2147483647 minutes is the int32 ceiling: 2147483647/6 rounds to 357913941.
  const ceiling = transformLibraryBatch(
    input([row({ observed_playtime_minutes: "2147483647", hours_played: "35791394.1" })]),
  );
  assert.equal(ceiling.legacy_library_evidence[0].reproducible_from_observed, true);
});

test("a discrepancy never asserts authorship", () => {
  const result = transformLibraryBatch(input([row({ observed_playtime_minutes: "60", hours_played: "9.9" })]));
  const measurement = result.library_legacy_measurements[0];
  assert.equal(measurement.authorship, "unknown");
  assert.equal(measurement.authorship_evidence, null);
  assert.match(
    result.conflicts.find((entry) => entry.conflict_class === "library_playtime_precedence_unresolved")?.decision ?? "",
    /does not prove authorship/,
  );
});

test("a nonzero derived completion percentage is exception evidence and never a manual override", () => {
  const result = transformLibraryBatch(
    input([row({ completion_percentage: "42", completed_at: "2026-02-01 00:00:00+00" })]),
  );
  assert.equal(result.game_state.length, 1);
  assert.equal(result.game_state[0].manual_progress, null);
  assert.deepEqual(
    result.library_legacy_measurements.map((entry) => [
      entry.discrepancy_kind,
      entry.legacy_completion_percentage,
      entry.legacy_completion_percentage_raw,
    ]),
    [["completion_percentage_only", "42", "42"]],
  );
});

test("a zero completion percentage is the import default and is not an exception", () => {
  const result = transformLibraryBatch(input([row({ completion_percentage: "0" })]));
  assert.equal(result.library_legacy_measurements.length, 0);
  assert.equal(result.legacy_library_evidence[0].completion_percentage, "0");
});

test("date_added is retained as opaque text and is never parsed as a date", () => {
  const result = transformLibraryBatch(input([row({ date_added: "03/09/2026" })]));
  assert.deepEqual(
    result.library_legacy_measurements.map((entry) => [entry.discrepancy_kind, entry.legacy_date_added_raw]),
    [["date_added_text_only", "03/09/2026"]],
  );
  assert.equal(result.legacy_library_evidence[0].date_added_raw, "03/09/2026");
  assert.equal(result.legacy_library_evidence[0].reproducible_from_observed, false);
});

test("a family row contributes access, never personal playtime", () => {
  const result = transformLibraryBatch(
    input([
      row({
        access_source: "family",
        observed_playtime_minutes: null,
        hours_played: "0.0",
        family_owner_steam_id: LENDER,
        family_verified_at: "2026-02-03 04:05:06.000007+00",
      }),
    ]),
  );
  assert.equal(result.library_games.length, 0);
  assert.equal(result.retired_library_games.length, 0);
  assert.equal(result.family_access_candidates.length, 1);
  const candidate = result.family_access_candidates[0];
  assert.equal(candidate.account_id, 1);
  assert.equal(candidate.game_id, 7);
  assert.equal(candidate.lender_steam_id, LENDER);
  assert.equal(candidate.lender_steam_id_status, "source");
  assert.equal(candidate.provenance, "verified");
  assert.equal(candidate.observed_at?.canonicalUtc, "2026-02-03T04:05:06.000007Z");
  assert.equal(candidate.source_snapshot_hash, SNAPSHOT);
});

test("an unverified family row keeps inferred provenance and uses the source update instant", () => {
  const result = transformLibraryBatch(
    input([row({ access_source: "family", family_owner_steam_id: LENDER, family_verified_at: null })]),
  );
  const candidate = result.family_access_candidates[0];
  assert.equal(candidate.provenance, "inferred");
  assert.equal(candidate.observed_at?.canonicalUtc, "2026-01-02T03:04:06.000000Z");
  assert.equal(candidate.observed_at_status, "source");
  assert.equal(conflictCount(result, "family_access_observed_at_unprovable"), 0);
});

test("a family row without a lender identity becomes orphan evidence, never a fabricated member", () => {
  const missing = transformLibraryBatch(input([row({ access_source: "family", family_owner_steam_id: null })]));
  assert.equal(missing.family_access_candidates[0].lender_steam_id_status, "missing");
  assert.equal(conflictCount(missing, "family_lender_identity_missing"), 1);

  const malformed = transformLibraryBatch(input([row({ access_source: "family", family_owner_steam_id: "not-a-steam-id" })]));
  assert.equal(malformed.family_access_candidates[0].lender_steam_id_status, "malformed");
  assert.equal(malformed.family_access_candidates[0].lender_steam_id, null);
  assert.equal(malformed.family_access_candidates[0].lender_steam_id_raw, "not-a-steam-id");
  assert.equal(conflictCount(malformed, "family_lender_identity_malformed"), 1);

  const zero = transformLibraryBatch(input([row({ access_source: "family", family_owner_steam_id: "00000000000000000" })]));
  assert.equal(zero.family_access_candidates[0].lender_steam_id_status, "malformed");
  assert.equal(zero.family_access_candidates[0].lender_steam_id_raw, "00000000000000000");
});

test("a wishlist row becomes a retired measurement carrying the verbatim legacy ownership, with no invented loss instant", () => {
  const result = transformLibraryBatch(input([row({ ownership: "Wishlist", observed_playtime_minutes: "5", hours_played: "0.1" })]));
  assert.equal(result.library_games.length, 0);
  assert.deepEqual(result.retired_library_games, [
    {
      account_id: 1,
      game_id: 7,
      last_personal_minutes: 5,
      last_observed_at: null,
      access_lost_at: null,
      access_lost_at_status: "unprovable_source_instant",
      loss_reason: "unknown",
      legacy_ownership: "Wishlist",
    },
  ]);
  assert.equal(conflictCount(result, "retired_wishlist_access_lost_at_unprovable"), 1);
  assert.equal(result.conflicts.find((entry) => entry.conflict_class === "retired_wishlist_access_lost_at_unprovable")?.details.status, "resolved");
});

test("a wishlist family row still produces a family access candidate carrying ownership='Wishlist'", () => {
  // library.ts no longer decides whether this candidate confers access -- that
  // decision (root's 11 September follow-up) belongs to family.ts, which
  // knows about resolved lenders. This test only proves the row map/candidate
  // hand-off still carries the fact through unchanged.
  const result = transformLibraryBatch(
    input([row({ ownership: "Wishlist", access_source: "family", family_owner_steam_id: LENDER })]),
  );
  assert.equal(result.retired_library_games.length, 0);
  assert.equal(result.library_games.length, 0);
  assert.equal(result.family_access_candidates.length, 1);
  assert.equal(result.family_access_candidates[0].ownership, "Wishlist");
  assert.equal(result.family_access_candidates[0].lender_steam_id, LENDER);
});

test("game_state is emitted only when the M1 disjunction is satisfied", () => {
  const suppressed = transformLibraryBatch(input([row({ notes: "   " })]));
  assert.equal(suppressed.game_state.length, 0);
  assert.equal(conflictCount(suppressed, "library_notes_whitespace_only"), 1);

  const emitted = transformLibraryBatch(
    input([
      row({
        status: "Slept",
        notes: "  keep this  ",
        completed_at: "2026-02-01 10:00:00+00",
        slept_at: "2026-02-02 10:00:00+00",
        previous_active_status: "Sampled",
        review_requested_at: "2026-02-03 10:00:00+00",
        completion_suggestion_dismissed_at: "2026-02-04 10:00:00+00",
        completion_suggestion_dismissed_playtime: "2",
      }),
    ]),
  );
  assert.deepEqual(
    emitted.game_state.map((entry) => ({
      account_id: entry.account_id,
      game_id: entry.game_id,
      completed_at: entry.completed_at?.canonicalUtc,
      blacklisted: entry.blacklisted,
      previous_active_status: entry.previous_active_status,
      manual_progress: entry.manual_progress,
      notes: entry.notes,
      review_requested_at: entry.review_requested_at?.canonicalUtc,
      completion_dismissed_at: entry.completion_dismissed_at?.canonicalUtc,
      completion_dismissed_playtime: entry.completion_dismissed_playtime,
    })),
    [
      {
        account_id: 1,
        game_id: 7,
        completed_at: "2026-02-01T10:00:00.000000Z",
        blacklisted: true,
        previous_active_status: "Sampled",
        manual_progress: null,
        notes: "  keep this  ",
        review_requested_at: "2026-02-03T10:00:00.000000Z",
        completion_dismissed_at: "2026-02-04T10:00:00.000000Z",
        completion_dismissed_playtime: 120,
      },
    ],
  );
});

test("a dismissal baseline with no state field is reported rather than invented into a state row", () => {
  const result = transformLibraryBatch(input([row({ completion_suggestion_dismissed_playtime: "1.5" })]));
  assert.equal(result.game_state.length, 0);
  assert.equal(conflictCount(result, "library_dismissal_baseline_without_state"), 1);
  assert.equal(result.legacy_library_evidence[0].evidence.completion_dismissed_playtime, "90");
  assert.equal(result.legacy_library_evidence[0].evidence.completion_dismissed_hours_raw, "1.5");
});

test("dismissal source hours convert to exact minutes while raw hours remain audit evidence", () => {
  const exact = transformLibraryBatch(
    input([
      row({
        completion_suggestion_dismissed_at: "2026-02-04 10:00:00+00",
        completion_suggestion_dismissed_playtime: "0.05",
      }),
    ]),
  );
  assert.equal(exact.game_state[0].completion_dismissed_playtime, 3);
  assert.equal(exact.legacy_library_evidence[0].evidence.completion_dismissed_hours_raw, "0.05");

  const zero = transformLibraryBatch(
    input([
      row({
        completion_suggestion_dismissed_at: "2026-02-04 10:00:00+00",
        completion_suggestion_dismissed_playtime: "0",
      }),
    ]),
  );
  assert.equal(zero.game_state[0].completion_dismissed_playtime, 0);
  assert.equal(zero.legacy_library_evidence[0].evidence.completion_dismissed_hours_raw, "0");

  const absent = transformLibraryBatch(
    input([row({ completion_suggestion_dismissed_at: "2026-02-04 10:00:00+00" })]),
  );
  assert.equal(absent.game_state[0].completion_dismissed_playtime, null);
  assert.equal("completion_dismissed_hours_raw" in absent.legacy_library_evidence[0].evidence, false);
});

test("observed_at is sourced from recency_evidence_at (the receipt time), never last_observed_played_at directly", () => {
  const exact = transformLibraryBatch(
    input([
      row({
        recency_source: "steam_exact",
        recency_evidence_at: "2026-02-05 06:07:08.000009+00",
        last_observed_played_at: "2026-02-05 06:07:09+00",
        last_played_at: "2026-02-04 00:00:00+00",
      }),
    ]),
  );
  assert.deepEqual(
    exact.game_activity.map((entry) => ({
      account_id: entry.account_id,
      game_id: entry.game_id,
      last_observed_minutes: entry.last_observed_minutes,
      last_played_at: entry.last_played_at?.canonicalUtc,
      legacy_last_played_at: entry.legacy_last_played_at?.canonicalUtc ?? null,
      observed_at: entry.observed_at.canonicalUtc,
      evidence_source: entry.evidence_source,
      recency_evidence_kind: entry.recency_evidence_kind,
      interval_started_at: entry.interval_started_at,
      interval_ended_at: entry.interval_ended_at,
    })),
    [
      {
        account_id: 1,
        game_id: 7,
        last_observed_minutes: 90,
        // last_played_at (target) takes last_observed_played_at, which is what
        // lib/recency.ts treats as the product's notion of last played.
        last_played_at: "2026-02-05T06:07:09.000000Z",
        // The raw legacy last_played_at is a distinct fact here, so it is kept
        // durably beside it rather than only in the purged staging evidence.
        legacy_last_played_at: "2026-02-04T00:00:00.000000Z",
        // observed_at (the receipt time) takes recency_evidence_at.
        observed_at: "2026-02-05T06:07:08.000009Z",
        evidence_source: "steam_api",
        recency_evidence_kind: "steam_exact",
        interval_started_at: null,
        // No play-session interval is fabricated from a receipt timestamp.
        interval_ended_at: null,
      },
    ],
  );
  // The staging copy still carries both readings for reconciliation, but it is
  // no longer the only copy of the divergent one.
  assert.equal(exact.legacy_library_evidence[0].evidence.last_played_at_raw, "2026-02-04T00:00:00.000000Z");
  assert.equal(
    exact.legacy_library_evidence[0].evidence.last_observed_played_at_raw,
    "2026-02-05T06:07:09.000000Z",
  );

  // observed_playtime_change and steam_exact: recency_evidence_at is set
  // under the same writer condition as last_observed_played_at (both non-null
  // together).
  const risen = transformLibraryBatch(
    input([
      row({
        recency_source: "observed_playtime_change",
        recency_evidence_at: "2026-02-05 00:00:00+00",
        last_observed_played_at: "2026-02-05 00:00:00+00",
      }),
    ]),
  );
  assert.equal(risen.game_activity[0].evidence_source, "steam_api");
  assert.equal(risen.game_activity[0].recency_evidence_kind, "observed_playtime_change");
  assert.equal(risen.game_activity[0].last_played_at?.canonicalUtc, "2026-02-05T00:00:00.000000Z");

  // apply_steam_recent_window (20260825191500) deliberately leaves
  // last_observed_played_at unset while still setting recency_evidence_at.
  const window = transformLibraryBatch(
    input([
      row({
        recency_source: "steam_recent_window",
        recency_evidence_at: "2026-02-06 00:00:00+00",
        last_observed_played_at: null,
      }),
    ]),
  );
  assert.equal(window.game_activity[0].recency_evidence_kind, "steam_recent_window");
  assert.equal(window.game_activity[0].last_played_at, null);
  assert.equal(window.game_activity[0].observed_at.canonicalUtc, "2026-02-06T00:00:00.000000Z");
});

test("a recency signal with no receipt time blocks as an exception rather than guessing one", () => {
  // No reviewed writer ever leaves recency_evidence_at null while
  // last_observed_played_at is set; this combination is not proven
  // impossible (no source CHECK forbids it), so it blocks rather than
  // reusing last_observed_played_at as the receipt time.
  const result = transformLibraryBatch(
    input([row({ recency_source: null, recency_evidence_at: null, last_observed_played_at: "2026-02-05 00:00:00+00" })]),
  );
  assert.equal(result.game_activity.length, 0);
  assert.equal(result.recency_exceptions.length, 1);
  assert.equal(result.recency_exceptions[0].reason, "receipt_time_absent_with_recency_signal");
  assert.equal(result.recency_exceptions[0].last_observed_played_at?.canonicalUtc, "2026-02-05T00:00:00.000000Z");
  assert.equal(conflictCount(result, "completion_undone_before_occurred"), 0);
});

test("a receipt time with no recency kind blocks as an exception", () => {
  const result = transformLibraryBatch(
    input([row({ recency_source: null, recency_evidence_at: "2026-02-06 00:00:00+00" })]),
  );
  assert.equal(result.game_activity.length, 0);
  assert.equal(result.recency_exceptions.length, 1);
  assert.equal(result.recency_exceptions[0].reason, "receipt_time_without_recency_kind");
});

test("a receipt time and kind with no representable minutes or last-played instant blocks as an exception", () => {
  const result = transformLibraryBatch(
    input([
      row({
        observed_playtime_minutes: null,
        hours_played: "0.0",
        last_played_at: null,
        last_observed_played_at: null,
        recency_source: "steam_recent_window",
        recency_evidence_at: "2026-02-06 00:00:00+00",
      }),
    ]),
  );
  assert.equal(result.game_activity.length, 0);
  assert.equal(result.recency_exceptions.length, 1);
  assert.equal(result.recency_exceptions[0].reason, "receipt_time_without_minutes_or_last_played");
  assert.equal(result.recency_exceptions[0].recency_source, "steam_recent_window");
});

test("both raw last-played readings survive durably when they disagree, in either direction and with either one null", () => {
  const activity = (source: Partial<UserGamesSourceRow>) =>
    transformLibraryBatch(
      input([row({ recency_source: "steam_exact", recency_evidence_at: "2026-02-07 00:00:00+00", ...source })]),
    ).game_activity[0];

  // Unequal non-null pair, observed ahead of raw (the reviewed writers' usual
  // shape): both readings are kept, the raw one durably beside the target.
  const ahead = activity({
    last_played_at: "2026-02-04 00:00:00+00",
    last_observed_played_at: "2026-02-05 00:00:00+00",
  });
  assert.equal(ahead.last_played_at?.canonicalUtc, "2026-02-05T00:00:00.000000Z");
  assert.equal(ahead.legacy_last_played_at?.canonicalUtc, "2026-02-04T00:00:00.000000Z");

  // Inverted: the raw reading is AFTER the observed one. No reviewed writer
  // produces this and no source CHECK forbids it, so it is stored as found and
  // neither timestamp is silently replaced by the other.
  const inverted = activity({
    last_played_at: "2026-02-06 00:00:00+00",
    last_observed_played_at: "2026-02-05 00:00:00+00",
  });
  assert.equal(inverted.last_played_at?.canonicalUtc, "2026-02-05T00:00:00.000000Z");
  assert.equal(inverted.legacy_last_played_at?.canonicalUtc, "2026-02-06T00:00:00.000000Z");

  // One null: a raw reading with no observed counterpart is still a fact, and
  // app.game_activity.last_played_at stays honestly null.
  const rawOnly = activity({ last_played_at: "2026-02-04 00:00:00+00", last_observed_played_at: null });
  assert.equal(rawOnly.last_played_at, null);
  assert.equal(rawOnly.legacy_last_played_at?.canonicalUtc, "2026-02-04T00:00:00.000000Z");

  // The mirror case loses nothing: there is no raw reading to preserve.
  const observedOnly = activity({ last_played_at: null, last_observed_played_at: "2026-02-05 00:00:00+00" });
  assert.equal(observedOnly.last_played_at?.canonicalUtc, "2026-02-05T00:00:00.000000Z");
  assert.equal(observedOnly.legacy_last_played_at, null);

  // Equal readings are one fact, not two; nothing is duplicated.
  const equal = activity({
    last_played_at: "2026-02-05 00:00:00+00",
    last_observed_played_at: "2026-02-05 00:00:00.000000+00",
  });
  assert.equal(equal.legacy_last_played_at, null);
});

test("a minutes-only baseline with zero recency evidence names the durable destination it actually reaches", () => {
  const owned = transformLibraryBatch(input([row({ last_observed_played_at: null })]));
  assert.equal(owned.game_activity.length, 0);
  assert.equal(owned.recency_exceptions.length, 0);
  assert.equal(conflictCount(owned, "library_activity_baseline_only_suppressed"), 1);
  // The minutes are not lost: they already survive in app.library_games.
  assert.equal(owned.library_games[0].playtime_minutes, 90);
  assert.equal(
    owned.conflicts.find((entry) => entry.conflict_class === "library_activity_baseline_only_suppressed")?.details
      .destination,
    "app.library_games",
  );

  // A personal wishlist row never enters app.library_games, so claiming that
  // destination for it would be a false redundancy claim. Its minutes survive
  // in app.retired_library_games.last_personal_minutes instead.
  const wishlist = transformLibraryBatch(input([row({ ownership: "Wishlist", hours_played: "1.5" })]));
  assert.equal(wishlist.library_games.length, 0);
  assert.equal(wishlist.game_activity.length, 0);
  assert.equal(wishlist.retired_library_games[0].last_personal_minutes, 90);
  assert.equal(conflictCount(wishlist, "library_activity_baseline_only_suppressed"), 0);
  assert.equal(conflictCount(wishlist, "library_activity_baseline_only_suppressed_retired"), 1);
  assert.equal(
    wishlist.conflicts.find(
      (entry) => entry.conflict_class === "library_activity_baseline_only_suppressed_retired",
    )?.details.destination,
    "app.retired_library_games",
  );

  // Both in one batch: each keeps its own destination rather than collapsing
  // into a single aggregate that names only one of them.
  const mixed = transformLibraryBatch(
    input([
      row({ id: ROW_1, catalog_steam_appid: "10" }),
      row({ id: ROW_2, catalog_steam_appid: "220", ownership: "Wishlist", hours_played: "1.5" }),
    ]),
  );
  assert.equal(conflictCount(mixed, "library_activity_baseline_only_suppressed"), 1);
  assert.equal(conflictCount(mixed, "library_activity_baseline_only_suppressed_retired"), 1);
});

test("a family row's measurement is never assigned to the borrowing account, and never silently dropped", () => {
  // Minutes alone: no personal destination exists for a family row at all
  // (app.library_games and app.retired_library_games are personal-only), so
  // the metric is withheld with its exact value rather than suppressed under a
  // redundancy claim that does not hold.
  const baseline = transformLibraryBatch(
    input([row({ access_source: "family", family_owner_steam_id: LENDER, observed_playtime_minutes: "90" })]),
  );
  assert.equal(baseline.game_activity.length, 0);
  assert.equal(baseline.library_games.length, 0);
  assert.equal(conflictCount(baseline, "library_activity_baseline_only_suppressed"), 0);
  assert.equal(baseline.recency_exceptions.length, 1);
  assert.equal(baseline.recency_exceptions[0].reason, "family_access_measurement_unassignable");
  assert.equal(baseline.recency_exceptions[0].observed_playtime_minutes, "90");
  // The access fact itself still flows to the family transform unchanged.
  assert.equal(baseline.family_access_candidates.length, 1);

  // Complete, well-formed recency evidence: this would otherwise have been a
  // loadable app.game_activity row keyed by the borrowing account, attributing
  // a reading of uncertain provenance to it.
  const recency = transformLibraryBatch(
    input([
      row({
        access_source: "family",
        family_owner_steam_id: LENDER,
        recency_source: "steam_exact",
        recency_evidence_at: "2026-02-05 00:00:00+00",
        last_observed_played_at: "2026-02-05 00:00:00+00",
        last_played_at: "2026-02-04 00:00:00+00",
      }),
    ]),
  );
  assert.equal(recency.game_activity.length, 0);
  assert.equal(recency.recency_exceptions.length, 1);
  assert.equal(recency.recency_exceptions[0].reason, "family_access_measurement_unassignable");
  assert.equal(recency.recency_exceptions[0].recency_evidence_at?.canonicalUtc, "2026-02-05T00:00:00.000000Z");
  assert.equal(recency.recency_exceptions[0].last_played_at?.canonicalUtc, "2026-02-04T00:00:00.000000Z");
  assert.equal(
    recency.recency_exceptions[0].last_observed_played_at?.canonicalUtc,
    "2026-02-05T00:00:00.000000Z",
  );

  // A family row with nothing to place produces no exception at all.
  const empty = transformLibraryBatch(
    input([
      row({
        access_source: "family",
        family_owner_steam_id: LENDER,
        observed_playtime_minutes: null,
        hours_played: "0.0",
      }),
    ]),
  );
  assert.equal(empty.recency_exceptions.length, 0);
  assert.equal(empty.game_activity.length, 0);
});

test("every withheld exception is countable in the redacted conflict report, with no raw value in it", () => {
  const result = transformLibraryBatch(
    input([
      // receipt_time_absent_with_recency_signal
      row({ id: ROW_1, catalog_steam_appid: "10", last_observed_played_at: "2026-02-05 00:00:00+00" }),
      // receipt_time_without_recency_kind
      row({ id: ROW_2, catalog_steam_appid: "220", recency_evidence_at: "2026-02-06 00:00:00+00" }),
      // family_access_measurement_unassignable
      row({
        id: ROW_3,
        catalog_steam_appid: "4294967295",
        access_source: "family",
        family_owner_steam_id: LENDER,
      }),
    ]),
  );
  assert.equal(result.recency_exceptions.length, 3);
  const accounted =
    conflictCount(result, "library_recency_receipt_time_absent") +
    conflictCount(result, "library_recency_receipt_time_without_kind") +
    conflictCount(result, "library_recency_without_minutes_or_last_played") +
    conflictCount(result, "library_family_measurement_unassignable");
  assert.equal(accounted, result.recency_exceptions.length);
  // Every one blocks: the pre-commit gate reads this stream, so none of them
  // may be reported as resolved.
  for (const entry of result.conflicts) {
    if (entry.details.destination !== "recency_exceptions") continue;
    assert.equal(entry.details.status, "unresolved");
    assert.doesNotMatch(entry.decision, /[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.doesNotMatch(entry.decision, /7656\d{13}/);
    assert.doesNotMatch(entry.decision, /2026-02-0/);
  }
});

test("Completed needs an instant while Slept status alone authoritatively becomes Blacklisted", () => {
  const completed = transformLibraryBatch(input([row({ status: "Completed", completed_at: null })]));
  assert.equal(conflictCount(completed, "library_status_terminal_disagreement"), 1);
  assert.equal(completed.game_state.length, 0);

  const slept = transformLibraryBatch(input([row({ status: "Slept", slept_at: null })]));
  assert.equal(conflictCount(slept, "library_status_terminal_disagreement"), 0);
  assert.equal(slept.game_state.length, 1);
  assert.equal(slept.game_state[0].blacklisted, true);
});

test("the same AppID in two accounts produces two independent rows", () => {
  const result = transformLibraryBatch(
    input([
      row({ id: ROW_1, user_id: ACCOUNT_A, catalog_steam_appid: "220", observed_playtime_minutes: "60", hours_played: "1.0" }),
      row({ id: ROW_2, user_id: ACCOUNT_B, catalog_steam_appid: "220", observed_playtime_minutes: "120", hours_played: "2.0" }),
    ]),
  );
  assert.deepEqual(result.library_games, [
    { account_id: 1, game_id: 8, playtime_minutes: 60 },
    { account_id: 2, game_id: 8, playtime_minutes: 120 },
  ]);
});

test("output is identical under permuted input order", () => {
  const rows = [
    row({ id: ROW_1, user_id: ACCOUNT_B, catalog_steam_appid: "4294967295", observed_playtime_minutes: "1", hours_played: "0.0" }),
    row({ id: ROW_2, user_id: ACCOUNT_A, catalog_steam_appid: "220", observed_playtime_minutes: "600", hours_played: "10.0" }),
    row({ id: ROW_3, user_id: ACCOUNT_A, catalog_steam_appid: "10", observed_playtime_minutes: null, hours_played: "0.0" }),
  ];
  const forward = canonicalLibraryResult(transformLibraryBatch(input(rows)));
  const reversed = canonicalLibraryResult(transformLibraryBatch(input([...rows].reverse())));
  const rotated = canonicalLibraryResult(transformLibraryBatch(input([rows[1], rows[2], rows[0]])));
  assert.equal(forward, reversed);
  assert.equal(forward, rotated);
});

test("duplicate and conflicting identities fail explicitly", () => {
  assert.throws(
    () => transformLibraryBatch(input([row({ id: ROW_1 }), row({ id: ROW_1, catalog_steam_appid: "220" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_duplicate_identity",
  );
  assert.throws(
    () => transformLibraryBatch(input([row({ id: ROW_1 }), row({ id: ROW_2 })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_duplicate_identity",
  );
});

test("a missing account or catalogue identity fails rather than resolving to a default", () => {
  const unmappedAccount = row({ user_id: "20000000-0000-4000-8000-0000000000ff" });
  assert.throws(
    () => transformLibraryBatch(input([unmappedAccount])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_account_unmapped",
  );
  assert.throws(
    () => transformLibraryBatch(input([row({ catalog_steam_appid: "999" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_game_unmapped",
  );
});

test("a map or row from another run is refused", () => {
  assert.throws(
    () => transformLibraryBatch(input([row({ run_id: "other-run" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
  const foreignMap = {
    run_identity: { run_id: "other-run", snapshot_hash: SNAPSHOT },
    entries: gameMap().entries,
  };
  assert.throws(
    () => transformLibraryBatch(input([row()], foreignMap)),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
  const foreignHash = {
    run_identity: { run_id: RUN.runId, snapshot_hash: SNAPSHOT },
    entries: [{ legacy_app_id: "10", game_id: 7, source_kind: "catalog_games" as const, source_snapshot_hash: "c".repeat(64) }],
  };
  assert.throws(
    () => transformLibraryBatch(input([row()], foreignHash)),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
  const invalidKind = {
    run_identity: { run_id: RUN.runId, snapshot_hash: SNAPSHOT },
    entries: [
      {
        legacy_app_id: "10",
        game_id: 7,
        source_kind: "not-a-source-kind",
        source_snapshot_hash: SNAPSHOT,
      },
    ],
  } as unknown as LibraryTransformInput["gameMap"];
  assert.throws(
    () => transformLibraryBatch(input([row()], invalidKind)),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_game_map_invalid",
  );
});

test("values that cannot reach a destination without loss fail explicitly", () => {
  assert.throws(
    () => transformLibraryBatch(input([row({ completion_suggestion_dismissed_playtime: "0.001" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_unrepresentable_value",
  );
  assert.throws(
    () => transformLibraryBatch(input([row({ notes: "n".repeat(10_001) })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_unrepresentable_value",
  );
  assert.throws(
    () => transformLibraryBatch(input([row({ date_added: "d".repeat(129) })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_unrepresentable_value",
  );
});

test("target overflow and out-of-range identities are refused", () => {
  assert.throws(
    () => transformLibraryBatch(input([row({ observed_playtime_minutes: "2147483648" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_integer",
  );
  assert.throws(
    () =>
      transformLibraryBatch(
        input([row({ catalog_steam_appid: "4294967296" })], gameMap([["4294967296", 11]])),
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_app_id_out_of_range",
  );
  assert.throws(
    () => transformLibraryBatch(input([row({ completion_suggestion_dismissed_playtime: "2147483648" })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_target_overflow",
  );
});

test("an explicit row bound is enforced before the working set is built", () => {
  assert.throws(
    () => transformLibraryBatch(input([row({ id: ROW_1 }), row({ id: ROW_2, catalog_steam_appid: "220" })]), { maxRows: 1 }),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_row_limit",
  );
});

test("failures carry a stable code and count only, never a private value", () => {
  const secretNote = "SECRET-NOTE-VALUE";
  try {
    transformLibraryBatch(input([row({ notes: `${secretNote}${"x".repeat(10_001)}` })]));
    assert.fail("expected a library transform failure");
  } catch (error) {
    assert.ok(error instanceof LibraryTransformError);
    const serialized = JSON.stringify(error.toJSON());
    assert.equal(serialized.includes(secretNote), false);
    assert.equal(serialized.includes(ACCOUNT_A), false);
    assert.equal(serialized.includes(ROW_1), false);
    assert.deepEqual(error.diagnostics, [
      { code: "library_unrepresentable_value", relation: "user_games", field: "notes", count: 1 },
    ]);
  }
});

test("UTC offsets and microsecond precision survive without a Date round trip", () => {
  const result = transformLibraryBatch(
    input([
      row({
        completed_at: "2026-03-01 00:00:00.000001+05:30",
        last_observed_played_at: "2025-12-31 23:59:59.999999-00",
        last_played_at: "2024-02-29 12:00:00+00",
        recency_source: "steam_exact",
        recency_evidence_at: "2026-01-01 08:15:00.000042+04:00",
      }),
    ]),
  );
  assert.equal(result.game_state[0].completed_at?.canonicalUtc, "2026-02-28T18:30:00.000001Z");
  // observed_at (the receipt time) takes recency_evidence_at, not last_observed_played_at.
  assert.equal(result.game_activity[0].observed_at.canonicalUtc, "2026-01-01T04:15:00.000042Z");
  assert.equal(result.game_activity[0].last_played_at?.canonicalUtc, "2025-12-31T23:59:59.999999Z");
});

test("every staging evidence payload stays a plain JSON object within its bound", () => {
  const result = transformLibraryBatch(
    input([row({ date_added: "03/09/2026", recency_source: "steam_exact", last_observed_played_at: "2026-02-05 00:00:00+00" })]),
  );
  for (const entry of result.legacy_library_evidence) {
    const text = JSON.stringify(entry.evidence);
    assert.equal(text.startsWith("{"), true);
    assert.ok(Buffer.byteLength(text, "utf8") <= 32_768);
  }
});

test("legacy hours beyond the numeric(30,12) destination keep exact text and a NULL numeric", () => {
  // numeric(30, 12) holds 12 fractional digits; this value needs 13, so the
  // only lossless destination is the exact raw text column.
  const result = transformLibraryBatch(
    input([row({ hours_played: "1.0000000000001", observed_playtime_minutes: "60" })]),
  );
  assert.equal(result.legacy_library_evidence[0].legacy_hours_played, null);
  assert.equal(result.legacy_library_evidence[0].legacy_hours_played_raw, "1.0000000000001");
  assert.equal(result.legacy_library_evidence[0].evidence.legacy_hours_numeric, "precision_exceeds_target");
  assert.equal(result.library_legacy_measurements[0].legacy_hours_played, null);
  assert.equal(result.library_legacy_measurements[0].legacy_hours_played_raw, "1.0000000000001");
  assert.equal(conflictCount(result, "library_hours_precision_exceeds_target"), 1);
});

test("legacy hours beyond the numeric(30,12) magnitude are not silently widened", () => {
  // 19 integer digits scaled by 12 needs 31 digits; numeric(30, 12) holds 30.
  const result = transformLibraryBatch(
    input([row({ hours_played: "1000000000000000000.5", observed_playtime_minutes: "60" })]),
  );
  assert.equal(result.legacy_library_evidence[0].legacy_hours_played, null);
  assert.equal(result.legacy_library_evidence[0].legacy_hours_played_raw, "1000000000000000000.5");
  assert.equal(conflictCount(result, "library_hours_precision_exceeds_target"), 1);
});

test("a legacy hours value one digit inside the destination scale is written exactly", () => {
  const result = transformLibraryBatch(
    input([row({ hours_played: "1.000000000001", observed_playtime_minutes: "60" })]),
  );
  assert.equal(result.legacy_library_evidence[0].legacy_hours_played, "1.000000000001");
  assert.equal(result.legacy_library_evidence[0].evidence.legacy_hours_numeric, undefined);
  assert.equal(conflictCount(result, "library_hours_precision_exceeds_target"), 0);
});

test("a negative legacy hours value is raw evidence and is never clamped or negated", () => {
  const result = transformLibraryBatch(input([row({ hours_played: "-1.5", observed_playtime_minutes: "90" })]));
  assert.equal(result.legacy_library_evidence[0].legacy_hours_played, null);
  assert.equal(result.legacy_library_evidence[0].legacy_hours_played_raw, "-1.5");
  assert.equal(result.library_legacy_measurements[0].legacy_hours_played, null);
  assert.equal(result.library_legacy_measurements[0].legacy_hours_played_raw, "-1.5");
  assert.equal(result.library_legacy_measurements[0].discrepancy_kind, "hours_not_reproducible");
  assert.equal(result.library_legacy_measurements[0].authorship, "unknown");
  assert.equal(conflictCount(result, "library_hours_negative"), 1);
  // The row itself survives: one library row, one map row, one evidence row.
  assert.equal(result.library_games.length, 1);
  assert.equal(result.library_row_map.length, 1);
});

test("the notes bound is the target's trimmed length, and the stored text stays verbatim", () => {
  // app.game_state.notes checks length(btrim(notes)) between 1 and 10000, so
  // 10000 note characters with surrounding spaces is a row the target accepts.
  const body = "n".repeat(10_000);
  const padded = `   ${body}  `;
  const accepted = transformLibraryBatch(input([row({ notes: padded })]));
  assert.equal(accepted.game_state.length, 1);
  assert.equal(accepted.game_state[0].notes, padded);
  assert.throws(
    () => transformLibraryBatch(input([row({ notes: `   ${"n".repeat(10_001)}  ` })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_unrepresentable_value",
  );
});

test("exact int32 and AppID boundaries survive without a float round trip", () => {
  const result = transformLibraryBatch(
    input([
      row({
        catalog_steam_appid: "4294967295",
        observed_playtime_minutes: "2147483647",
        // Math.round(((2147483647 / 60) * 10)) / 10 === 35791394.1
        hours_played: "35791394.1",
      }),
    ]),
  );
  assert.deepEqual(result.library_games, [{ account_id: 1, game_id: 9, playtime_minutes: 2147483647 }]);
  assert.equal(result.library_row_map[0].steam_appid, "4294967295");
  assert.equal(result.legacy_library_evidence[0].reproducible_from_observed, true);
  assert.equal(result.library_legacy_measurements.length, 0);
});

test("a non-canonical AppID spelling is refused rather than silently re-rendered", () => {
  assert.throws(
    () => transformLibraryBatch(input([row({ catalog_steam_appid: "010" })], gameMap([["010", 12]]))),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_app_id_out_of_range",
  );
  assert.throws(
    () => transformLibraryBatch(input([row({ catalog_steam_appid: "0" })], gameMap([["0", 12]]))),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_app_id_out_of_range",
  );
});

test("malformed JSON-shaped inputs are refused instead of being coerced", () => {
  const notAnObjectEntry = {
    run_identity: { run_id: RUN.runId, snapshot_hash: SNAPSHOT },
    entries: ["10"],
  } as unknown as LibraryTransformInput["gameMap"];
  assert.throws(
    () => transformLibraryBatch(input([row()], notAnObjectEntry)),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
  assert.throws(
    () =>
      transformLibraryBatch({
        runIdentity: RUN,
        accountMap: { legacy_id: ACCOUNT_A } as unknown as readonly AccountMapTargetRecord[],
        gameMap: gameMap(),
        userGames: [row()],
      }),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
  assert.throws(
    () => transformLibraryBatch(input([null as unknown as UserGamesSourceRow])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
  assert.throws(
    () => transformLibraryBatch(input([row({ notes: 7 as unknown as string })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
});

test("a mixed batch keeps every destination separate for the same AppID across accounts", () => {
  const result = transformLibraryBatch(
    input([
      row({ id: ROW_1, user_id: ACCOUNT_A, catalog_steam_appid: "220", observed_playtime_minutes: "60", hours_played: "1.0" }),
      row({
        id: ROW_2,
        user_id: ACCOUNT_B,
        catalog_steam_appid: "220",
        access_source: "family",
        family_owner_steam_id: LENDER,
        observed_playtime_minutes: "600",
        hours_played: "10.0",
      }),
      row({ id: ROW_3, user_id: ACCOUNT_B, catalog_steam_appid: "10", ownership: "Wishlist", observed_playtime_minutes: null, hours_played: "0.0" }),
    ]),
  );
  assert.deepEqual(result.library_games, [{ account_id: 1, game_id: 8, playtime_minutes: 60 }]);
  assert.deepEqual(result.retired_library_games.map((entry) => [entry.account_id, entry.game_id]), [[2, 7]]);
  assert.deepEqual(
    result.family_access_candidates.map((entry) => [entry.account_id, entry.game_id, entry.lender_steam_id]),
    [[2, 8, LENDER]],
  );
  // The family row's 600 minutes never reach any personal destination.
  assert.equal(result.library_games.some((entry) => entry.playtime_minutes === 600), false);
  assert.equal(result.retired_library_games[0].last_personal_minutes, null);
  assert.equal(result.library_row_map.length, 3);
});
