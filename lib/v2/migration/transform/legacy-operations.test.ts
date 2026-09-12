import assert from "node:assert/strict";
import test from "node:test";
import { RemainingTransformError } from "./remaining-shared.ts";
import {
  IMPORT_JOBS_RETIRED_SOURCE_COLUMNS,
  INTENTS_RETIRED_SOURCE_COLUMNS,
  transformLegacyOperationsBatch,
  type LegacyOperationsInput,
} from "./legacy-operations.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

const SNAPSHOT = "e".repeat(64);
const RUN = Object.freeze({ runId: "legacy-ops-run", snapshotHash: SNAPSHOT });
const ACCOUNT_A = "90000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "90000000-0000-4000-8000-00000000000b";
const ABSENT = "90000000-0000-4000-8000-0000000000ff";
const DIGEST = "b".repeat(64);
const LENDER_STEAM_ID = "76561198000000042";

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

function input(overrides: Partial<LegacyOperationsInput> = {}): LegacyOperationsInput {
  return { runIdentity: RUN, accountMap: ACCOUNT_MAP, ...overrides };
}

function workerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a0000000-0000-4000-8000-000000000001",
    worker_name: "nightly-metadata",
    status: "succeeded",
    started_at: "2026-09-01 02:00:00+00",
    finished_at: "2026-09-01 02:05:00+00",
    duration_ms: "300000",
    counts: '{"fetched":120}',
    summary: '{"note":"ok"}',
    error_message: null,
    ...overrides,
  };
}

function importRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: ACCOUNT_A,
    status: "complete",
    total_games: "120",
    imported_games: "120",
    games: '[{"appid":440}]',
    play_history_missing: "f",
    last_error: null,
    started_at: "2026-09-01 00:00:00+00",
    updated_at: "2026-09-01 00:10:00+00",
    completed_at: "2026-09-01 00:10:00+00",
    processing_token: null,
    processing_started_at: null,
    ...overrides,
  };
}

function rateLimitRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bucket: "contact_form",
    key_hash: DIGEST,
    window_started_at: "2026-09-10 12:00:00+00",
    request_count: "4",
    updated_at: "2026-09-10 12:30:00+00",
    ...overrides,
  };
}

function mergeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "b0000000-0000-4000-8000-000000000001",
    source_account_id: ACCOUNT_A,
    target_account_id: ACCOUNT_B,
    verified_steam_id: LENDER_STEAM_ID,
    merge_mode: "merged_existing",
    created_at: "2026-07-01 00:00:00+00",
    analytics_delivered_at: "2026-07-01 00:01:00+00",
    ...overrides,
  };
}

function intentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    source_account_id: ACCOUNT_A,
    source_manual_session_id: "d0000000-0000-4000-8000-000000000001",
    token_hash: DIGEST,
    created_at: "2026-08-01 00:00:00+00",
    expires_at: "2026-08-01 00:10:00+00",
    consumed_at: null,
    target_account_id: null,
    verified_steam_id: null,
    openid_response_nonce: null,
    outcome: null,
    ...overrides,
  };
}

function failureCode(execute: () => unknown): string {
  try {
    execute();
  } catch (error) {
    assert.ok(error instanceof RemainingTransformError, `expected RemainingTransformError, received ${String(error)}`);
    return error.remainingCode;
  }
  assert.fail("expected a RemainingTransformError");
}

test("a worker run's retention window is derived from its own start instant, not a clock", () => {
  const result = transformLegacyOperationsBatch(
    input({ workerRuns: [workerRow(), workerRow({ id: "a0000000-0000-4000-8000-000000000002", status: "failed", error_message: "provider 500" })] }),
  );
  const routine = result.legacy_worker_runs.find((row) => row.status === "succeeded");
  const failure = result.legacy_worker_runs.find((row) => row.status === "failed");
  assert.equal(routine?.run_class, "routine");
  assert.equal(failure?.run_class, "failure");
  // 14 days for a routine run, 30 for a failure, both from started_at.
  assert.equal(routine?.retention_until.canonicalUtc.startsWith("2026-09-15T02:00:00"), true);
  assert.equal(failure?.retention_until.canonicalUtc.startsWith("2026-10-01T02:00:00"), true);
  assert.equal(result.counts.failure_runs, 1);
});

test("retention arithmetic preserves pre-epoch microseconds and rolls into the next civil day exactly", () => {
  const result = transformLegacyOperationsBatch(input({
    workerRuns: [workerRow({
      started_at: "1969-12-18 23:59:59.999999+00",
      finished_at: "1969-12-19 00:00:00.000000+00",
    })],
  }));
  assert.equal(result.legacy_worker_runs[0].retention_until.canonicalUtc, "1970-01-01T23:59:59.999999Z");
});

test("a run still in flight is unknown rather than a failure, and keeps the shorter window", () => {
  const result = transformLegacyOperationsBatch(
    input({ workerRuns: [workerRow({ status: "running", finished_at: null, duration_ms: null })] }),
  );
  assert.equal(result.legacy_worker_runs[0].run_class, "unknown");
  assert.equal(result.legacy_worker_runs[0].retention_until.canonicalUtc.startsWith("2026-09-15T"), true);
});

test("the source's own finished/running CHECK is enforced rather than repaired", () => {
  assert.equal(
    failureCode(() => transformLegacyOperationsBatch(input({ workerRuns: [workerRow({ status: "running" })] }))),
    "remaining_order_conflict",
  );
  assert.equal(
    failureCode(() =>
      transformLegacyOperationsBatch(input({ workerRuns: [workerRow({ status: "succeeded", finished_at: null })] })),
    ),
    "remaining_order_conflict",
  );
});

test("an import job becomes an operator report and never a resumable job", () => {
  const result = transformLegacyOperationsBatch(input({ importJobs: [importRow()] }));
  const report = result.import_freeze_report[0];
  assert.equal(report.account_id, 1);
  assert.equal(report.source_user_id, ACCOUNT_A);
  assert.equal(report.total_games, 120);
  assert.equal(report.imported_games, 120);
  assert.equal(report.retention_class, "staging-30d-post-cutover");
  // The lease and payload are named as retired, and no column carries them.
  assert.equal(Object.hasOwn(report, "processing_token"), false);
  assert.equal(Object.hasOwn(report, "games"), false);
  assert.deepEqual(Object.keys(IMPORT_JOBS_RETIRED_SOURCE_COLUMNS).sort(), [
    "games",
    "processing_started_at",
    "processing_token",
  ]);
});

test("an import still running at the snapshot is counted and blocked, not resumed", () => {
  const result = transformLegacyOperationsBatch(
    input({
      importJobs: [importRow({ status: "importing", imported_games: "40", completed_at: null })],
    }),
  );
  assert.equal(result.counts.in_flight_imports, 1);
  assert.equal(result.import_freeze_report[0].status, "importing");
  const blocker = result.blockers.find((entry) => entry.code === "import_in_flight_at_snapshot");
  assert.ok(blocker);
  assert.match(blocker.decision, /D-IMP-1/);
});

test("imported above total is refused rather than clamped", () => {
  assert.equal(
    failureCode(() =>
      transformLegacyOperationsBatch(input({ importJobs: [importRow({ total_games: "10", imported_games: "11" })] })),
    ),
    "remaining_order_conflict",
  );
});

test("rate-limit rows produce nothing at all without supplied cutover evidence", () => {
  const result = transformLegacyOperationsBatch(input({ rateLimits: [rateLimitRow()] }));
  assert.equal(result.abuse_cooldowns.length, 0);
  const blocker = result.blockers.find((entry) => entry.code === "cooldown_cutover_evidence_absent");
  assert.ok(blocker, "missing cutover evidence must block");
  assert.equal(blocker.count, 1);
});

test("with an observation instant but no window length, every cooldown is unknown rather than guessed", () => {
  const result = transformLegacyOperationsBatch(
    input({
      rateLimits: [rateLimitRow()],
      cutover: { observed_at: "2026-09-11 00:00:00+00", algorithm_version: "legacy-fixed-window" },
    }),
  );
  const cooldown = result.abuse_cooldowns[0];
  assert.equal(cooldown.status, "unknown");
  assert.equal(cooldown.expires_at, null);
  assert.equal(cooldown.source_window_seconds, null);
  assert.equal(cooldown.account_id, null, "a digest is never resolved back to an account");
  assert.equal(cooldown.key_digest, DIGEST);
  assert.equal(cooldown.observed_at.canonicalUtc, "2026-09-11T00:00:00.000000Z");
  assert.ok(result.blockers.some((entry) => entry.code === "cooldown_window_length_absent"));
});

test("with a supplied window length the expiry is derived exactly, and status follows from it", () => {
  const expired = transformLegacyOperationsBatch(
    input({
      rateLimits: [rateLimitRow()],
      cutover: { observed_at: "2026-09-11 00:00:00+00", algorithm_version: "legacy-fixed-window", window_seconds: 3600 },
    }),
  );
  assert.equal(expired.abuse_cooldowns[0].status, "expired");
  assert.equal(expired.abuse_cooldowns[0].expires_at?.canonicalUtc.startsWith("2026-09-10T13:00:00"), true);

  const active = transformLegacyOperationsBatch(
    input({
      rateLimits: [rateLimitRow()],
      cutover: {
        observed_at: "2026-09-10 12:30:00+00",
        algorithm_version: "legacy-fixed-window",
        window_seconds: 86_400,
      },
    }),
  );
  assert.equal(active.abuse_cooldowns[0].status, "active");
  assert.equal(active.abuse_cooldowns[0].source_window_seconds, 86_400);
});

test("a malformed bucket or digest is refused rather than normalised", () => {
  const evidence = { observed_at: "2026-09-11 00:00:00+00", algorithm_version: "legacy-fixed-window" };
  assert.equal(
    failureCode(() =>
      transformLegacyOperationsBatch(input({ rateLimits: [rateLimitRow({ bucket: "Contact Form" })], cutover: evidence })),
    ),
    "remaining_invalid_enum",
  );
  assert.equal(
    failureCode(() =>
      transformLegacyOperationsBatch(input({ rateLimits: [rateLimitRow({ key_hash: "not-a-digest" })], cutover: evidence })),
    ),
    "remaining_text_bounds",
  );
});

test("a merge between two accounts produces a durable merge, an alias and an audit row", () => {
  const result = transformLegacyOperationsBatch(
    input({
      accountMerges: [mergeRow()],
      mergeTombstones: [{ legacy_merge_id: "b0000000-0000-4000-8000-000000000001", source_tombstone_present: true }],
    }),
  );
  const merge = result.account_merges[0];
  assert.equal(merge.mode, "merge");
  assert.equal(merge.source_account_id, 1);
  assert.equal(merge.target_account_id, 2);
  assert.equal(merge.legacy_merge_mode, "merged_existing");
  assert.equal(merge.verified_steam_id, LENDER_STEAM_ID);
  assert.equal(result.account_aliases.length, 1);
  assert.equal(result.account_aliases[0].source_public_id, ACCOUNT_A);
  assert.equal(result.account_aliases[0].expires_at, null);
  assert.equal(result.legacy_account_merge_audit[0].source_tombstone_present, true);
  assert.equal(result.legacy_account_merge_audit[0].merge_mode, "merged_existing");
});

test("a promotion in place produces no alias and uses the mode the target CHECK requires", () => {
  const result = transformLegacyOperationsBatch(
    input({ accountMerges: [mergeRow({ target_account_id: ACCOUNT_A, merge_mode: "promoted" })] }),
  );
  assert.equal(result.account_merges[0].mode, "promote");
  assert.equal(result.account_merges[0].source_account_id, result.account_merges[0].target_account_id);
  assert.equal(result.account_aliases.length, 0, "nothing was renamed, so there is no alias");
  // The legacy literal is still preserved beside the target's own mode.
  assert.equal(result.account_merges[0].legacy_merge_mode, "promoted");
});

test("a source merge mode that disagrees with the account pair is refused rather than reinterpreted", () => {
  assert.equal(
    failureCode(() => transformLegacyOperationsBatch(input({ accountMerges: [mergeRow({ merge_mode: "promoted" })] }))),
    "remaining_order_conflict",
  );
  assert.equal(
    failureCode(() => transformLegacyOperationsBatch(input({
      accountMerges: [mergeRow({ target_account_id: ACCOUNT_A, merge_mode: "merged_existing" })],
    }))),
    "remaining_order_conflict",
  );
});

test("a merge naming an account outside the map is refused", () => {
  assert.equal(
    failureCode(() =>
      transformLegacyOperationsBatch(input({ accountMerges: [mergeRow({ target_account_id: ABSENT })] })),
    ),
    "remaining_account_unmapped",
  );
});

test("an intent audit carries the outcome and never the token digest or nonce", () => {
  const result = transformLegacyOperationsBatch(
    input({
      securityIntents: [
        intentRow({
          consumed_at: "2026-08-01 00:05:00+00",
          target_account_id: ACCOUNT_B,
          verified_steam_id: LENDER_STEAM_ID,
          openid_response_nonce: "nonce-value",
          outcome: "merged_existing",
        }),
      ],
    }),
  );
  const audit = result.legacy_auth_intent_audit[0];
  assert.equal(audit.account_id, 1);
  assert.equal(audit.target_mapped_account_id, 2);
  assert.equal(audit.target_account_id, ACCOUNT_B);
  assert.equal(audit.outcome, "merged_existing");
  assert.equal(audit.verified_steam_id, LENDER_STEAM_ID);
  const asRecord = audit as unknown as Record<string, unknown>;
  assert.equal(asRecord.token_hash, undefined);
  assert.equal(asRecord.openid_response_nonce, undefined);
  assert.deepEqual(Object.keys(INTENTS_RETIRED_SOURCE_COLUMNS).sort(), [
    "openid_response_nonce",
    "source_manual_session_id",
    "token_hash",
  ]);
});

test("an unconsumed, long-past intent is not relabelled expired without a freeze instant", () => {
  const result = transformLegacyOperationsBatch(input({ securityIntents: [intentRow()] }));
  assert.equal(result.legacy_auth_intent_audit[0].outcome, null);
  assert.equal(result.legacy_auth_intent_audit[0].consumed_at, null);
});

test("an intent whose instants violate the target ordering is refused", () => {
  assert.equal(
    failureCode(() =>
      transformLegacyOperationsBatch(
        input({ securityIntents: [intentRow({ expires_at: "2026-07-01 00:00:00+00" })] }),
      ),
    ),
    "remaining_order_conflict",
  );
});

test("duplicate identities fail explicitly across every relation", () => {
  assert.equal(
    failureCode(() => transformLegacyOperationsBatch(input({ workerRuns: [workerRow(), workerRow()] }))),
    "remaining_duplicate_row",
  );
  assert.equal(
    failureCode(() => transformLegacyOperationsBatch(input({ importJobs: [importRow(), importRow()] }))),
    "remaining_duplicate_row",
  );
  assert.equal(
    failureCode(() => transformLegacyOperationsBatch(input({ accountMerges: [mergeRow(), mergeRow()] }))),
    "remaining_duplicate_row",
  );
});

test("an empty batch is valid and produces no blockers", () => {
  const result = transformLegacyOperationsBatch(input());
  assert.equal(result.legacy_worker_runs.length, 0);
  assert.equal(result.abuse_cooldowns.length, 0);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.run_identity.snapshot_hash, SNAPSHOT);
});
