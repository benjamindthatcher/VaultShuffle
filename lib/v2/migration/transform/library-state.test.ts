import assert from "node:assert/strict";
import test from "node:test";
import { parsePgTimestamptz, type PgTimestamp } from "./scalars.ts";
import { LibraryTransformError } from "./library-shared.ts";
import {
  canonicalLegacyStateResult,
  transformLegacyGameState,
  type LegacyGameStateInput,
  type LegacyGameStateSourceRow,
} from "./library-state.ts";
import type { AuthoritativeLibraryFact } from "./library.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * The stale child must never become authority. These expectations are written
 * against the destination columns directly: the bounded staging copy takes
 * every source field verbatim, and only rows whose evidence is not reproducible
 * from the authoritative library row are marked for durable promotion.
 */

const SNAPSHOT = "d".repeat(64);
const RUN = Object.freeze({ runId: "state-test-run", snapshotHash: SNAPSHOT });
const ACCOUNT_A = "20000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "20000000-0000-4000-8000-00000000000b";

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

function instant(text: string): PgTimestamp {
  const parsed = parsePgTimestamptz(text);
  assert.ok(parsed !== null);
  return parsed;
}

function stateRow(overrides: Partial<LegacyGameStateSourceRow> = {}): LegacyGameStateSourceRow {
  return {
    user_id: ACCOUNT_A,
    appid: "10",
    completed_at: null,
    slept_at: null,
    prev_active_status: null,
    dismissed_at: null,
    dismissed_playtime: null,
    review_requested_at: null,
    last_played_at: null,
    last_observed_played_at: null,
    recency_source: null,
    recency_evidence_at: null,
    family_owner_steam_id: null,
    family_verified_at: null,
    ...overrides,
  };
}

function fact(overrides: Partial<AuthoritativeLibraryFact> = {}): AuthoritativeLibraryFact {
  return {
    account_id: 1,
    steam_appid: "10",
    completed_at: null,
    dismissed_at: null,
    dismissed_playtime: null,
    review_requested_at: null,
    last_played_at: null,
    last_observed_at: null,
    recency_evidence_at: null,
    family_owner_steam_id: null,
    family_verified_at: null,
    ...overrides,
    source_snapshot_hash: overrides.source_snapshot_hash ?? SNAPSHOT,
  };
}

function input(
  rows: readonly LegacyGameStateSourceRow[],
  facts: readonly AuthoritativeLibraryFact[],
): LegacyGameStateInput {
  return { runIdentity: RUN, accountMap: ACCOUNT_MAP, userGameState: rows, authoritativeFacts: facts };
}

function conflictCount(
  result: { conflicts: readonly { conflict_class: string; conflict_count: number }[] },
  name: string,
): number {
  return result.conflicts
    .filter((entry) => entry.conflict_class === name)
    .reduce((total, entry) => total + entry.conflict_count, 0);
}

test("the transform produces no runtime state or activity relation at all", () => {
  const result = transformLegacyGameState(input([stateRow()], [fact()]));
  assert.deepEqual(Object.keys(result).sort(), [
    "conflicts",
    "game_state_legacy_measurements",
    "legacy_user_game_state_audit",
    "run_identity",
  ]);
});

test("a stale row that agrees with the library row stays reconciliation-only", () => {
  const result = transformLegacyGameState(
    input(
      [stateRow({ completed_at: "2026-01-01 00:00:00+00", last_played_at: "2026-01-02 00:00:00+00" })],
      [
        fact({
          completed_at: instant("2026-01-01 00:00:00+00"),
          last_played_at: instant("2026-01-02 00:00:00+00"),
        }),
      ],
    ),
  );
  assert.equal(result.legacy_user_game_state_audit.length, 1);
  assert.equal(result.legacy_user_game_state_audit[0].evidence_disposition, "reconcile_only");
  assert.equal(result.legacy_user_game_state_audit[0].retention_class, "staging-30d-post-cutover");
  assert.equal(result.game_state_legacy_measurements.length, 0);
});

test("every retained source field reaches staging while the obsolete Sleep timestamp is discarded", () => {
  const result = transformLegacyGameState(
    input(
      [
        stateRow({
          user_id: ACCOUNT_B,
          appid: "4294967295",
          completed_at: "2026-01-01 01:02:03.000004+00",
          slept_at: "2026-01-02 00:00:00+00",
          prev_active_status: "2",
          dismissed_at: "2026-01-03 00:00:00+00",
          dismissed_playtime: "12.500",
          review_requested_at: "2026-01-04 00:00:00+00",
          last_played_at: "2026-01-05 00:00:00+00",
          last_observed_played_at: "2026-01-06 00:00:00+00",
          recency_source: "3",
          recency_evidence_at: "2026-01-07 00:00:00+00",
          family_owner_steam_id: "76561198000000042",
          family_verified_at: "2026-01-08 00:00:00+00",
        }),
      ],
      [fact({ account_id: 2, steam_appid: "4294967295" })],
    ),
  );
  const audit = result.legacy_user_game_state_audit[0];
  assert.equal(audit.account_id, 2);
  assert.equal(audit.source_user_id, ACCOUNT_B);
  assert.equal(audit.steam_appid, "4294967295");
  assert.equal(audit.raw_completed_at?.canonicalUtc, "2026-01-01T01:02:03.000004Z");
  assert.equal(Object.hasOwn(audit, "raw_slept_at"), false);
  assert.equal(audit.raw_prev_active_status, 2);
  assert.equal(audit.raw_recency_code, 3);
  // Source numeric precision is preserved rather than narrowed to an integer.
  assert.equal(audit.raw_dismissed_playtime, "12.500");
  assert.equal(audit.raw_family_owner_steam_id, "76561198000000042");
  assert.equal(audit.source_snapshot_hash, SNAPSHOT);
});

test("an unresolved smallint code book is promoted as sole evidence", () => {
  const prev = transformLegacyGameState(input([stateRow({ prev_active_status: "1" })], [fact()]));
  assert.equal(prev.legacy_user_game_state_audit[0].evidence_disposition, "durable_sparse_required");
  assert.deepEqual(
    prev.game_state_legacy_measurements.map((entry) => [
      entry.account_id,
      entry.steam_app_id,
      entry.source_user_id,
      entry.evidence_reason,
      entry.raw_prev_active_status,
    ]),
    [[1, "10", ACCOUNT_A, "unresolved_codebook", 1]],
  );
  assert.equal(conflictCount(prev, "state_unresolved_codebook"), 1);

  const recency = transformLegacyGameState(input([stateRow({ recency_source: "2" })], [fact()]));
  assert.equal(recency.game_state_legacy_measurements[0].evidence_reason, "unresolved_codebook");
  assert.equal(recency.game_state_legacy_measurements[0].raw_recency_code, 2);
});

test("a fractional dismissal baseline is promoted at source precision, never rounded", () => {
  const result = transformLegacyGameState(input([stateRow({ dismissed_playtime: "7.25" })], [fact()]));
  assert.equal(result.game_state_legacy_measurements[0].evidence_reason, "multiple");
  assert.equal(result.game_state_legacy_measurements[0].raw_dismissed_playtime, "7.25");
  assert.equal(conflictCount(result, "state_non_integral_dismissed_playtime"), 1);
  // The disagreement with the authoritative NULL is a separate reason, so the
  // combined reason is 'multiple' rather than either one alone.
  assert.equal(conflictCount(result, "state_stale_conflict"), 1);
});

test("an integral dismissal baseline that matches the library row is not promoted", () => {
  const result = transformLegacyGameState(
    input([stateRow({ dismissed_playtime: "30" })], [fact({ dismissed_playtime: "30" })]),
  );
  assert.equal(result.game_state_legacy_measurements.length, 0);
  assert.equal(result.legacy_user_game_state_audit[0].evidence_disposition, "reconcile_only");
});

test("a timestamp disagreement is promoted and never coalesced into current state", () => {
  const result = transformLegacyGameState(
    input(
      [stateRow({ completed_at: "2026-01-01 00:00:00+00" })],
      [fact({ completed_at: instant("2026-01-01 00:00:01+00") })],
    ),
  );
  assert.equal(result.game_state_legacy_measurements[0].evidence_reason, "stale_conflict");
  assert.equal(result.game_state_legacy_measurements[0].raw_completed_at?.canonicalUtc, "2026-01-01T00:00:00.000000Z");
  assert.equal(conflictCount(result, "state_stale_conflict"), 1);
});

test("stale family evidence is preserved without creating access or verification", () => {
  const result = transformLegacyGameState(
    input(
      [stateRow({ family_owner_steam_id: "76561198000000042", family_verified_at: "2026-01-09 00:00:00+00" })],
      [fact()],
    ),
  );
  assert.equal(result.game_state_legacy_measurements[0].evidence_reason, "source_provenance");
  assert.equal(conflictCount(result, "state_family_provenance_conflict"), 1);
  assert.match(
    result.conflicts.find((entry) => entry.conflict_class === "state_family_provenance_conflict")?.decision ?? "",
    /never used to create family access/,
  );
});

test("a stale row with no authoritative library row is promoted and reported", () => {
  const result = transformLegacyGameState(input([stateRow({ completed_at: "2026-01-01 00:00:00+00" })], []));
  assert.equal(result.game_state_legacy_measurements[0].evidence_reason, "stale_conflict");
  assert.equal(conflictCount(result, "state_orphan_row"), 1);
});

test("an all-NULL stale tuple that still disagrees cannot be promoted and stays in staging", () => {
  const result = transformLegacyGameState(
    input([stateRow()], [fact({ completed_at: instant("2026-01-01 00:00:00+00") })]),
  );
  assert.equal(result.game_state_legacy_measurements.length, 0);
  assert.equal(result.legacy_user_game_state_audit[0].evidence_disposition, "reconcile_only");
  assert.equal(conflictCount(result, "state_empty_conflict_row"), 1);
});

test("output is identical under permuted input order", () => {
  const rows = [
    stateRow({ user_id: ACCOUNT_B, appid: "220", prev_active_status: "1" }),
    stateRow({ user_id: ACCOUNT_A, appid: "4294967295", recency_source: "3" }),
    stateRow({ user_id: ACCOUNT_A, appid: "10" }),
  ];
  const facts = [fact({ account_id: 2, steam_appid: "220" }), fact({ steam_appid: "4294967295" }), fact()];
  const forward = canonicalLegacyStateResult(transformLegacyGameState(input(rows, facts)));
  const reversed = canonicalLegacyStateResult(transformLegacyGameState(input([...rows].reverse(), [...facts].reverse())));
  assert.equal(forward, reversed);
});

test("duplicate keys, foreign runs and out-of-domain codes fail explicitly", () => {
  assert.throws(
    () => transformLegacyGameState(input([stateRow(), stateRow()], [fact()])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_duplicate_identity",
  );
  assert.throws(
    () => transformLegacyGameState(input([stateRow({ run_id: "other" })], [fact()])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
  assert.throws(
    () => transformLegacyGameState(input([stateRow({ prev_active_status: "32768" })], [fact()])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_integer",
  );
  assert.throws(
    () => transformLegacyGameState(input([stateRow({ prev_active_status: "0" })], [fact()])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_enum",
  );
  assert.throws(
    () => transformLegacyGameState(input([stateRow({ recency_source: "4" })], [fact()])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_invalid_enum",
  );
  assert.throws(
    () => transformLegacyGameState(input([stateRow({ appid: "0" })], [fact()])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_app_id_out_of_range",
  );
});

test("authoritative hand-off rejects a foreign run and malformed scalar cache", () => {
  assert.throws(
    () => transformLegacyGameState(input([stateRow()], [fact({ source_snapshot_hash: "e".repeat(64) })])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_mixed_run_identity",
  );
  assert.throws(
    () =>
      transformLegacyGameState(
        input([stateRow()], [fact({ completed_at: "not-a-pg-timestamp" as unknown as PgTimestamp })]),
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_input_invalid",
  );
});

test("an over-long family owner value is refused rather than truncated for the durable relation", () => {
  assert.throws(
    () => transformLegacyGameState(input([stateRow({ family_owner_steam_id: "x".repeat(201) })], [fact()])),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_unrepresentable_value",
  );
});

test("failures carry no private value", () => {
  try {
    transformLegacyGameState(input([stateRow({ family_owner_steam_id: "9".repeat(201) })], [fact()]));
    assert.fail("expected a library transform failure");
  } catch (error) {
    assert.ok(error instanceof LibraryTransformError);
    const serialized = JSON.stringify(error.toJSON());
    assert.equal(serialized.includes("9".repeat(20)), false);
    assert.equal(serialized.includes(ACCOUNT_A), false);
  }
});

test("an explicit row bound is enforced", () => {
  assert.throws(
    () =>
      transformLegacyGameState(input([stateRow({ appid: "10" }), stateRow({ appid: "220" })], [fact()]), { maxRows: 1 }),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_row_limit",
  );
});

test("an over-long family owner that needs no promotion stays whole in staging", () => {
  // The authoritative row carries the identical text, so nothing disagrees and
  // nothing has to narrow to the durable relation's 200-character bound.
  const owner = "x".repeat(400);
  const result = transformLegacyGameState(
    input([stateRow({ family_owner_steam_id: owner })], [fact({ family_owner_steam_id: owner })]),
  );
  assert.equal(result.game_state_legacy_measurements.length, 0);
  assert.equal(result.legacy_user_game_state_audit.length, 1);
  assert.equal(result.legacy_user_game_state_audit[0].raw_family_owner_steam_id, owner);
  assert.equal(result.legacy_user_game_state_audit[0].evidence_disposition, "reconcile_only");
  assert.equal(conflictCount(result, "state_family_owner_over_durable_bound"), 1);
});

test("the durable owner bound counts characters, as PostgreSQL length() does", () => {
  // 200 astral characters are 400 UTF-16 code units but length() = 200, which
  // the durable column accepts; measuring the JavaScript length would reject a
  // value the target can hold.
  const owner = "\u{1F600}".repeat(200);
  assert.equal(owner.length, 400);
  const result = transformLegacyGameState(
    input([stateRow({ family_owner_steam_id: owner })], [fact({ family_owner_steam_id: null })]),
  );
  assert.equal(result.game_state_legacy_measurements.length, 1);
  assert.equal(result.game_state_legacy_measurements[0].raw_family_owner_steam_id, owner);
  assert.equal(result.game_state_legacy_measurements[0].evidence_reason, "source_provenance");

  assert.throws(
    () =>
      transformLegacyGameState(
        input([stateRow({ family_owner_steam_id: `${owner}\u{1F600}` })], [fact({ family_owner_steam_id: null })]),
      ),
    (error: unknown) => error instanceof LibraryTransformError && error.libraryCode === "library_unrepresentable_value",
  );
});

test("dismissal baselines are compared by exact value, not by spelling", () => {
  const agreeing = transformLegacyGameState(
    input(
      [stateRow({ dismissed_at: "2026-01-01 00:00:00+00", dismissed_playtime: "12.0" })],
      [fact({ dismissed_at: instant("2026-01-01 00:00:00+00"), dismissed_playtime: "12" })],
    ),
  );
  assert.equal(agreeing.game_state_legacy_measurements.length, 0);
  assert.equal(conflictCount(agreeing, "state_stale_conflict"), 0);
  // The staging copy still keeps the source spelling's own scale.
  assert.equal(agreeing.legacy_user_game_state_audit[0].raw_dismissed_playtime, "12.0");

  const disagreeing = transformLegacyGameState(
    input(
      [stateRow({ dismissed_at: "2026-01-01 00:00:00+00", dismissed_playtime: "12.01" })],
      [fact({ dismissed_at: instant("2026-01-01 00:00:00+00"), dismissed_playtime: "12" })],
    ),
  );
  assert.equal(disagreeing.game_state_legacy_measurements.length, 1);
  assert.equal(disagreeing.game_state_legacy_measurements[0].evidence_reason, "multiple");
  assert.equal(conflictCount(disagreeing, "state_stale_conflict"), 1);
});

test("the same AppID under two accounts is two independent staging rows", () => {
  const result = transformLegacyGameState(
    input(
      [
        stateRow({ user_id: ACCOUNT_A, appid: "220", recency_source: "2" }),
        stateRow({ user_id: ACCOUNT_B, appid: "220" }),
      ],
      [fact({ account_id: 1, steam_appid: "220" }), fact({ account_id: 2, steam_appid: "220" })],
    ),
  );
  assert.deepEqual(
    result.legacy_user_game_state_audit.map((entry) => [entry.account_id, entry.steam_appid, entry.evidence_disposition]),
    [
      [1, "220", "durable_sparse_required"],
      [2, "220", "reconcile_only"],
    ],
  );
  assert.deepEqual(
    result.game_state_legacy_measurements.map((entry) => [entry.account_id, entry.steam_app_id]),
    [[1, "220"]],
  );
});

test("microsecond timestamp disagreement is detected without a Date round trip", () => {
  const result = transformLegacyGameState(
    input(
      [stateRow({ completed_at: "2026-03-01 00:00:00.000002+00" })],
      [fact({ completed_at: instant("2026-03-01 00:00:00.000001+00") })],
    ),
  );
  assert.equal(result.game_state_legacy_measurements.length, 1);
  assert.equal(
    result.game_state_legacy_measurements[0].raw_completed_at?.canonicalUtc,
    "2026-03-01T00:00:00.000002Z",
  );
  assert.equal(conflictCount(result, "state_stale_conflict"), 1);

  const identical = transformLegacyGameState(
    input(
      [stateRow({ completed_at: "2026-03-01 05:30:00.000001+05:30" })],
      [fact({ completed_at: instant("2026-03-01 00:00:00.000001+00") })],
    ),
  );
  assert.equal(identical.game_state_legacy_measurements.length, 0);
});
