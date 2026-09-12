import {
  BlockerCollector,
  INT32_MAX,
  boundedText,
  booleanValue,
  cell,
  enumValue,
  instant,
  integerValue,
  jsonDocument,
  nullableCell,
  remainingAccountMap,
  remainingFailure,
  remainingRow,
  remainingRows,
  remainingRun,
  requireColumns,
  requireOrder,
  sha256Hex,
  steamIdText,
  uuidText,
  type AccountMapIndex,
  type AccountMapTargetRecord,
  type PgTimestamp,
  type RemainingBlocker,
  type RemainingRunIdentity,
} from "./remaining-shared.ts";
import { ScalarError, timestampFromEpochMicros } from "./scalars.ts";

/**
 * Bounded legacy operations: worker runs, the import freeze report, rate-limit
 * cooldown evidence, and the residual identity audits (account merges and
 * manual profile security intents).
 *
 * Nothing here restarts work. A worker run becomes a bounded, expiring record;
 * an in-flight import becomes a report for an operator, never a resumed job; a
 * rate-limit window becomes evidence with an explicitly recorded algorithm and
 * observation instant, never an activated cooldown; and an intent audit
 * carries no token digest or nonce at all.
 *
 * Three facts the source does not carry are required from the caller rather
 * than invented: the cutover observation instant, the cooldown algorithm
 * version, and (optionally) the source window length. Absent evidence produces
 * a blocker and no rows — never a `now()` stamp, a guessed window, or a reset
 * counter.
 */

const WORKER_RUNS_RELATION = "metadata_worker_runs";
const IMPORT_JOBS_RELATION = "steam_import_jobs";
const RATE_LIMITS_RELATION = "api_rate_limits";
const MERGES_RELATION = "account_merges";
const INTENTS_RELATION = "manual_profile_security_intents";

export const WORKER_RUNS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "worker_name",
  "status",
  "started_at",
  "finished_at",
  "duration_ms",
  "counts",
  "summary",
  "error_message",
]);

export const IMPORT_JOBS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "user_id",
  "status",
  "total_games",
  "imported_games",
  "games",
  "play_history_missing",
  "last_error",
  "started_at",
  "updated_at",
  "completed_at",
  "processing_token",
  "processing_started_at",
]);

export const RATE_LIMITS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "bucket",
  "key_hash",
  "window_started_at",
  "request_count",
  "updated_at",
]);

export const MERGES_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "source_account_id",
  "target_account_id",
  "verified_steam_id",
  "merge_mode",
  "created_at",
  "analytics_delivered_at",
]);

export const INTENTS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "source_account_id",
  "source_manual_session_id",
  "token_hash",
  "created_at",
  "expires_at",
  "consumed_at",
  "target_account_id",
  "verified_steam_id",
  "openid_response_nonce",
  "outcome",
]);

/** Source columns that reach no destination here, and why. */
export const IMPORT_JOBS_RETIRED_SOURCE_COLUMNS = Object.freeze({
  games:
    "The in-flight owned-games payload. Every game it names is already migrated through user_games, and the payload is re-fetchable by re-running the import; migration.legacy_import_freeze_report deliberately has no column for it.",
  processing_token:
    "A worker lease token, not a job identity. Carrying it would let a v2 worker believe it holds a lease taken before the freeze.",
  processing_started_at:
    "The lease acquisition instant, meaningless once the lease is not carried. The report's timing questions are answered by started_at/updated_at/completed_at.",
} as const);

export const INTENTS_RETIRED_SOURCE_COLUMNS = Object.freeze({
  token_hash:
    "A live promotion-token digest. migration.legacy_auth_intent_audit has no column for it by design: an audit of who attempted what must not carry the credential that would let the attempt be replayed.",
  openid_response_nonce:
    "A provider nonce bound to a completed callback. It cannot be reused and has no audit value; the audit keeps the outcome instead.",
  source_manual_session_id:
    "Carried as legacy_session_id, the audit's own column for the manual session the intent was raised from.",
} as const);

/**
 * `metadata_worker_runs.status` -> the retention class of the archived row.
 *
 * `ops.legacy_worker_runs` enforces 14 days for a routine run and 30 for a
 * failure, both measured from the source run start. A `running` row is a run
 * that had not finished at the snapshot: its outcome is genuinely unknown, and
 * the shorter window applies because an unknown run is not evidence of a
 * failure.
 */
const RUN_CLASS_BY_STATUS = Object.freeze({
  succeeded: "routine",
  partial: "failure",
  failed: "failure",
  running: "unknown",
} as const);

const ROUTINE_RETENTION_DAYS = 14;
const FAILURE_RETENTION_DAYS = 30;
const MICROS_PER_DAY = BigInt(86_400) * BigInt(1_000_000);

export type LegacyWorkerRunRecord = Readonly<{
  legacy_id: string;
  worker_name: string;
  status: string;
  run_class: "routine" | "failure" | "unknown";
  started_at: PgTimestamp;
  finished_at: PgTimestamp | null;
  duration_ms: number | null;
  counts: Readonly<{ text: string; utf8Bytes: number }>;
  summary: Readonly<{ text: string; utf8Bytes: number }>;
  error_message: string | null;
  /** started_at + the class window, as exact microseconds; no clock is read. */
  retention_until: Readonly<{ epochMicros: bigint; canonicalUtc: string }>;
  retention_class: "bounded-operational";
  source_snapshot_hash: string;
}>;

export type ImportFreezeReportRecord = Readonly<{
  account_id: number;
  source_user_id: string;
  status: string;
  total_games: number;
  imported_games: number;
  play_history_missing: boolean;
  last_error: string | null;
  started_at: PgTimestamp;
  updated_at: PgTimestamp;
  completed_at: PgTimestamp | null;
  retention_class: "staging-30d-post-cutover";
  source_snapshot_hash: string;
}>;

export type AbuseCooldownRecord = Readonly<{
  bucket: string;
  /** 64 lowercase hex characters; the loader decodes it to a 32-byte digest. */
  key_digest: string;
  /** Always NULL: a digest is not reversible into an account, and guessing
   * one would attach a stranger's cooldown to a real person. */
  account_id: null;
  window_started_at: PgTimestamp;
  source_window_seconds: number | null;
  request_count: number;
  source_updated_at: PgTimestamp;
  observed_at: PgTimestamp;
  expires_at: PgTimestamp | null;
  algorithm_version: string;
  status: "active" | "expired" | "unknown";
  source_snapshot_hash: string;
}>;

export type AccountMergeRecord = Readonly<{
  source_account_id: number;
  target_account_id: number;
  mode: "promote" | "merge";
  verified_steam_id: string;
  reason: string;
  created_at: PgTimestamp;
  legacy_merge_id: string;
  legacy_merge_mode: string;
  source_public_id: string;
  target_public_id: string;
  analytics_delivered_at: PgTimestamp | null;
}>;

export type AccountAliasRecord = Readonly<{
  source_account_id: number;
  target_account_id: number;
  source_public_id: string;
  created_at: PgTimestamp;
  /** NULL: the source records no alias expiry, and inventing one would decide
   * when a person's old link stops working. */
  expires_at: null;
}>;

export type LegacyMergeAuditRecord = Readonly<{
  legacy_merge_id: string;
  mapped_source_account_id: number;
  mapped_target_account_id: number;
  source_account_id: string;
  target_account_id: string;
  verified_steam_id: string;
  merge_mode: "promoted" | "merged_existing";
  created_at: PgTimestamp;
  analytics_delivered_at: PgTimestamp | null;
  source_tombstone_present: boolean;
  retention_class: "staging-30d-post-cutover";
  source_snapshot_hash: string;
}>;

export type LegacyAuthIntentAuditRecord = Readonly<{
  legacy_intent_id: string;
  account_id: number;
  source_account_id: string;
  legacy_session_id: string | null;
  created_at: PgTimestamp;
  expires_at: PgTimestamp;
  consumed_at: PgTimestamp | null;
  target_account_id: string | null;
  target_mapped_account_id: number | null;
  verified_steam_id: string | null;
  outcome: string | null;
  retention_class: "staging-30d-post-cutover";
  source_snapshot_hash: string;
}>;

/**
 * Facts no source column carries, supplied by the caller as exact text.
 *
 * `observed_at` is the real instant the rate-limit population was read; it is
 * the difference between "this cooldown had expired when we looked" and a
 * guess. `algorithm_version` names the bucket algorithm the windows belong to,
 * so a later bridge can tell whether the recorded windows are still meaningful.
 * `window_seconds` is optional: without it no expiry can be computed and every
 * row is recorded as `unknown` rather than assumed active or expired.
 */
export type CutoverEvidence = Readonly<{
  observed_at: string;
  algorithm_version: string;
  window_seconds?: number | null;
}>;

/** Merge evidence produced by the identity transform, consumed verbatim. */
export type MergeTombstoneEvidence = Readonly<{
  legacy_merge_id: string;
  source_tombstone_present: boolean;
}>;

export type LegacyOperationsInput = Readonly<{
  runIdentity: RemainingRunIdentity;
  accountMap: readonly AccountMapTargetRecord[];
  workerRuns?: readonly object[];
  importJobs?: readonly object[];
  rateLimits?: readonly object[];
  accountMerges?: readonly object[];
  securityIntents?: readonly object[];
  /** Required before any `api_rate_limits` row can be represented. */
  cutover?: CutoverEvidence | null;
  /** `source_tombstone_present` per merge, from the identity transform. */
  mergeTombstones?: readonly MergeTombstoneEvidence[];
}>;

export type LegacyOperationsResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  legacy_worker_runs: readonly LegacyWorkerRunRecord[];
  import_freeze_report: readonly ImportFreezeReportRecord[];
  abuse_cooldowns: readonly AbuseCooldownRecord[];
  account_merges: readonly AccountMergeRecord[];
  account_aliases: readonly AccountAliasRecord[];
  legacy_account_merge_audit: readonly LegacyMergeAuditRecord[];
  legacy_auth_intent_audit: readonly LegacyAuthIntentAuditRecord[];
  blockers: readonly RemainingBlocker[];
  counts: Readonly<{
    worker_runs: number;
    failure_runs: number;
    import_reports: number;
    in_flight_imports: number;
    rate_limit_rows: number;
    cooldowns_emitted: number;
    merges: number;
    aliases: number;
    intents: number;
  }>;
}>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** started_at + N days, in exact microseconds. */
function retentionUntil(startedAt: PgTimestamp, days: number): Readonly<{ epochMicros: bigint; canonicalUtc: string }> {
  const micros = startedAt.epochMicros + BigInt(days) * MICROS_PER_DAY;
  try {
    const result = timestampFromEpochMicros(micros, { field: "retention_until" });
    return Object.freeze({ epochMicros: result.epochMicros, canonicalUtc: result.canonicalUtc });
  } catch (error) {
    if (error instanceof ScalarError) {
      return remainingFailure("remaining_invalid_timestamp", WORKER_RUNS_RELATION, "retention_until");
    }
    throw error;
  }
}

function lookupAccount(
  accounts: AccountMapIndex,
  legacyId: string,
  relation: string,
  field: string,
): number {
  try {
    return accounts.lookup(legacyId);
  } catch {
    remainingFailure("remaining_account_unmapped", relation, field);
  }
}

export function transformLegacyOperationsBatch(input: LegacyOperationsInput): LegacyOperationsResult {
  if (typeof input !== "object" || input === null) {
    remainingFailure("remaining_input_invalid", "legacy_operations_input");
  }
  const run = remainingRun(input.runIdentity);
  const accounts = remainingAccountMap(input.accountMap, run);
  const blockers = new BlockerCollector();

  /* ---- ops.legacy_worker_runs ------------------------------------------ */
  const workerRuns: LegacyWorkerRunRecord[] = [];
  const seenRunIds = new Set<string>();
  let failureRuns = 0;
  for (const raw of remainingRows(input.workerRuns ?? [], WORKER_RUNS_RELATION)) {
    const row = remainingRow(raw, WORKER_RUNS_RELATION, run);
    requireColumns(row, WORKER_RUNS_SOURCE_COLUMNS, WORKER_RUNS_RELATION);
    const legacyId = uuidText(cell(row, "id", WORKER_RUNS_RELATION), WORKER_RUNS_RELATION, "id") as {
      original: string;
      canonical: string;
    };
    if (seenRunIds.has(legacyId.canonical)) remainingFailure("remaining_duplicate_row", WORKER_RUNS_RELATION, "id");
    seenRunIds.add(legacyId.canonical);
    const status = enumValue(
      cell(row, "status", WORKER_RUNS_RELATION),
      ["running", "succeeded", "partial", "failed"] as const,
      WORKER_RUNS_RELATION,
      "status",
    );
    const runClass = RUN_CLASS_BY_STATUS[status];
    if (runClass === "failure") failureRuns += 1;
    const startedAt = instant(cell(row, "started_at", WORKER_RUNS_RELATION), WORKER_RUNS_RELATION, "started_at", true) as PgTimestamp;
    const finishedAt = instant(nullableCell(row, "finished_at", WORKER_RUNS_RELATION), WORKER_RUNS_RELATION, "finished_at", false);
    requireOrder(startedAt, finishedAt, WORKER_RUNS_RELATION, "finished_at");
    // The source's own CHECK: a running row has no finish, everything else has.
    if ((status === "running") !== (finishedAt === null)) {
      remainingFailure("remaining_order_conflict", WORKER_RUNS_RELATION, "finished_at");
    }
    workerRuns.push(
      Object.freeze({
        legacy_id: legacyId.original,
        worker_name: boundedText(cell(row, "worker_name", WORKER_RUNS_RELATION), WORKER_RUNS_RELATION, "worker_name", {
          min: 1,
          max: 200,
          measure: "btrim",
        }) as string,
        status,
        run_class: runClass,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: integerValue(
          nullableCell(row, "duration_ms", WORKER_RUNS_RELATION),
          WORKER_RUNS_RELATION,
          "duration_ms",
          { min: BigInt(0), max: INT32_MAX },
          false,
        ),
        counts: jsonDocument(cell(row, "counts", WORKER_RUNS_RELATION), WORKER_RUNS_RELATION, "counts", {
          topLevel: "object",
          maxBytes: 65_536,
        }) as Readonly<{ text: string; utf8Bytes: number }>,
        summary: jsonDocument(cell(row, "summary", WORKER_RUNS_RELATION), WORKER_RUNS_RELATION, "summary", {
          topLevel: "object",
          maxBytes: 65_536,
        }) as Readonly<{ text: string; utf8Bytes: number }>,
        error_message: boundedText(
          nullableCell(row, "error_message", WORKER_RUNS_RELATION),
          WORKER_RUNS_RELATION,
          "error_message",
          { min: 1, max: 20_000, nullable: true },
        ),
        retention_until: retentionUntil(
          startedAt,
          runClass === "failure" ? FAILURE_RETENTION_DAYS : ROUTINE_RETENTION_DAYS,
        ),
        retention_class: "bounded-operational" as const,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  /* ---- migration.legacy_import_freeze_report --------------------------- */
  const importReports: ImportFreezeReportRecord[] = [];
  const seenImportAccounts = new Set<string>();
  let inFlightImports = 0;
  for (const raw of remainingRows(input.importJobs ?? [], IMPORT_JOBS_RELATION)) {
    const row = remainingRow(raw, IMPORT_JOBS_RELATION, run);
    requireColumns(row, IMPORT_JOBS_SOURCE_COLUMNS, IMPORT_JOBS_RELATION);
    const sourceUser = uuidText(cell(row, "user_id", IMPORT_JOBS_RELATION), IMPORT_JOBS_RELATION, "user_id") as {
      original: string;
      canonical: string;
    };
    if (seenImportAccounts.has(sourceUser.canonical)) {
      remainingFailure("remaining_duplicate_row", IMPORT_JOBS_RELATION, "user_id");
    }
    seenImportAccounts.add(sourceUser.canonical);
    const accountId = lookupAccount(accounts, sourceUser.original, IMPORT_JOBS_RELATION, "user_id");
    const status = enumValue(
      cell(row, "status", IMPORT_JOBS_RELATION),
      ["importing", "complete", "failed"] as const,
      IMPORT_JOBS_RELATION,
      "status",
    );
    const totalGames = integerValue(cell(row, "total_games", IMPORT_JOBS_RELATION), IMPORT_JOBS_RELATION, "total_games", {
      min: BigInt(0),
      max: INT32_MAX,
    }) as number;
    const importedGames = integerValue(
      cell(row, "imported_games", IMPORT_JOBS_RELATION),
      IMPORT_JOBS_RELATION,
      "imported_games",
      { min: BigInt(0), max: INT32_MAX },
    ) as number;
    if (importedGames > totalGames) {
      remainingFailure("remaining_order_conflict", IMPORT_JOBS_RELATION, "imported_games");
    }
    const startedAt = instant(cell(row, "started_at", IMPORT_JOBS_RELATION), IMPORT_JOBS_RELATION, "started_at", true) as PgTimestamp;
    const updatedAt = instant(cell(row, "updated_at", IMPORT_JOBS_RELATION), IMPORT_JOBS_RELATION, "updated_at", true) as PgTimestamp;
    const completedAt = instant(nullableCell(row, "completed_at", IMPORT_JOBS_RELATION), IMPORT_JOBS_RELATION, "completed_at", false);
    requireOrder(startedAt, updatedAt, IMPORT_JOBS_RELATION, "updated_at");
    requireOrder(startedAt, completedAt, IMPORT_JOBS_RELATION, "completed_at");
    // The payload and the lease are validated for shape, then deliberately
    // not carried; see IMPORT_JOBS_RETIRED_SOURCE_COLUMNS.
    jsonDocument(cell(row, "games", IMPORT_JOBS_RELATION), IMPORT_JOBS_RELATION, "games", {
      topLevel: "array",
      maxBytes: 64 * 1024 * 1024,
    });
    uuidText(nullableCell(row, "processing_token", IMPORT_JOBS_RELATION), IMPORT_JOBS_RELATION, "processing_token", false);
    instant(
      nullableCell(row, "processing_started_at", IMPORT_JOBS_RELATION),
      IMPORT_JOBS_RELATION,
      "processing_started_at",
      false,
    );

    if (status === "importing") {
      inFlightImports += 1;
      blockers.record(
        "import_in_flight_at_snapshot",
        IMPORT_JOBS_RELATION,
        "status",
        "UNRESOLVED until the real freeze (D-IMP-1): this account's Steam import was still running when the snapshot was taken, so its v2 library may be partial. Plan 14.2 settles that in-flight jobs are NOT resumed, and the freeze report records the account so an operator can ask for a re-run. WHICH accounts are affected cannot be known before the actual freeze, so this count is evidence from this snapshot, not the cutover answer.",
      );
    }

    importReports.push(
      Object.freeze({
        account_id: accountId,
        source_user_id: sourceUser.original,
        status,
        total_games: totalGames,
        imported_games: importedGames,
        play_history_missing: booleanValue(
          cell(row, "play_history_missing", IMPORT_JOBS_RELATION),
          IMPORT_JOBS_RELATION,
          "play_history_missing",
        ),
        last_error: boundedText(nullableCell(row, "last_error", IMPORT_JOBS_RELATION), IMPORT_JOBS_RELATION, "last_error", {
          min: 1,
          max: 20_000,
          nullable: true,
        }),
        started_at: startedAt,
        updated_at: updatedAt,
        completed_at: completedAt,
        retention_class: "staging-30d-post-cutover" as const,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  /* ---- ops.abuse_cooldowns --------------------------------------------- */
  const cooldowns: AbuseCooldownRecord[] = [];
  const rateLimitRows = remainingRows(input.rateLimits ?? [], RATE_LIMITS_RELATION);
  const cutover = input.cutover ?? null;
  let observedAt: PgTimestamp | null = null;
  let algorithmVersion: string | null = null;
  let windowSeconds: number | null = null;
  if (cutover !== null) {
    observedAt = instant(cutover.observed_at, "cutover_evidence", "observed_at", true);
    algorithmVersion = boundedText(cutover.algorithm_version, "cutover_evidence", "algorithm_version", {
      min: 1,
      max: 120,
      measure: "btrim",
    });
    if (cutover.window_seconds !== undefined && cutover.window_seconds !== null) {
      if (!Number.isSafeInteger(cutover.window_seconds) || cutover.window_seconds <= 0) {
        remainingFailure("remaining_invalid_integer", "cutover_evidence", "window_seconds");
      }
      windowSeconds = cutover.window_seconds;
    }
  }

  if (rateLimitRows.length > 0 && (observedAt === null || algorithmVersion === null)) {
    blockers.record(
      "cooldown_cutover_evidence_absent",
      RATE_LIMITS_RELATION,
      "observed_at",
      "UNRESOLVED for root: ops.abuse_cooldowns requires an observation instant and the algorithm version the recorded windows belong to, and api_rate_limits carries neither. Reading a clock here would date every legacy window at migration time and silently extend or expire real cooldowns. No cooldown row is emitted until that evidence is supplied; the source rows are untouched and no cooldown is reset, extended or activated.",
      rateLimitRows.length,
    );
  } else if (rateLimitRows.length > 0) {
    if (windowSeconds === null) {
      blockers.record(
        "cooldown_window_length_absent",
        RATE_LIMITS_RELATION,
        "window_started_at",
        "UNRESOLVED for root (D-ABUSE-3): the source records when a window started but not how long it lasts, so whether a legacy cooldown is still binding cannot be derived from the row alone. Every cooldown is recorded with status 'unknown' and a NULL expiry rather than being assumed active (which would punish people for pre-cutover traffic) or expired (which would drop a live limit). Supplying the bucket's window length resolves the status deterministically.",
        rateLimitRows.length,
      );
    }
    const seenBuckets = new Set<string>();
    for (const raw of rateLimitRows) {
      const row = remainingRow(raw, RATE_LIMITS_RELATION, run);
      requireColumns(row, RATE_LIMITS_SOURCE_COLUMNS, RATE_LIMITS_RELATION);
      const bucket = cell(row, "bucket", RATE_LIMITS_RELATION);
      if (!/^[a-z0-9_]{1,64}$/.test(bucket)) {
        remainingFailure("remaining_invalid_enum", RATE_LIMITS_RELATION, "bucket");
      }
      const keyDigest = sha256Hex(cell(row, "key_hash", RATE_LIMITS_RELATION), RATE_LIMITS_RELATION, "key_hash") as string;
      const bucketKey = `${bucket} ${keyDigest}`;
      if (seenBuckets.has(bucketKey)) remainingFailure("remaining_duplicate_row", RATE_LIMITS_RELATION, "key_hash");
      seenBuckets.add(bucketKey);
      const windowStartedAt = instant(
        cell(row, "window_started_at", RATE_LIMITS_RELATION),
        RATE_LIMITS_RELATION,
        "window_started_at",
        true,
      ) as PgTimestamp;
      const sourceUpdatedAt = instant(
        cell(row, "updated_at", RATE_LIMITS_RELATION),
        RATE_LIMITS_RELATION,
        "updated_at",
        true,
      ) as PgTimestamp;
      requireOrder(windowStartedAt, sourceUpdatedAt, RATE_LIMITS_RELATION, "updated_at");
      let expiresAt: PgTimestamp | null = null;
      let status: AbuseCooldownRecord["status"] = "unknown";
      if (windowSeconds !== null) {
        const expiryMicros = windowStartedAt.epochMicros + BigInt(windowSeconds) * BigInt(1_000_000);
        const millis = Number(expiryMicros / BigInt(1000));
        const fraction = expiryMicros - BigInt(millis) * BigInt(1000);
        const canonical = `${new Date(millis).toISOString().replace("Z", "")}${fraction.toString().padStart(3, "0")}Z`;
        expiresAt = Object.freeze({
          epochMicros: expiryMicros,
          epochMicrosText: expiryMicros.toString(10),
          canonicalUtc: canonical,
          sourceText: canonical,
          toJSON: () => canonical,
        }) as unknown as PgTimestamp;
        status = expiryMicros <= (observedAt as PgTimestamp).epochMicros ? "expired" : "active";
      }
      cooldowns.push(
        Object.freeze({
          bucket,
          key_digest: keyDigest,
          account_id: null,
          window_started_at: windowStartedAt,
          source_window_seconds: windowSeconds,
          request_count: integerValue(
            cell(row, "request_count", RATE_LIMITS_RELATION),
            RATE_LIMITS_RELATION,
            "request_count",
            { min: BigInt(1), max: INT32_MAX },
          ) as number,
          source_updated_at: sourceUpdatedAt,
          observed_at: observedAt as PgTimestamp,
          expires_at: expiresAt,
          algorithm_version: algorithmVersion as string,
          status,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
    }
  }

  /* ---- ops.account_merges / ops.account_aliases / merge audit ---------- */
  const merges: AccountMergeRecord[] = [];
  const aliases: AccountAliasRecord[] = [];
  const mergeAudit: LegacyMergeAuditRecord[] = [];
  const tombstoneById = new Map<string, boolean>();
  for (const entry of input.mergeTombstones ?? []) {
    const parsed = uuidText(entry.legacy_merge_id, "merge_tombstones", "legacy_merge_id") as {
      original: string;
      canonical: string;
    };
    tombstoneById.set(parsed.canonical, entry.source_tombstone_present === true);
  }
  const seenMergeIds = new Set<string>();
  for (const raw of remainingRows(input.accountMerges ?? [], MERGES_RELATION)) {
    const row = remainingRow(raw, MERGES_RELATION, run);
    requireColumns(row, MERGES_SOURCE_COLUMNS, MERGES_RELATION);
    const mergeId = uuidText(cell(row, "id", MERGES_RELATION), MERGES_RELATION, "id") as {
      original: string;
      canonical: string;
    };
    if (seenMergeIds.has(mergeId.canonical)) remainingFailure("remaining_duplicate_row", MERGES_RELATION, "id");
    seenMergeIds.add(mergeId.canonical);
    const sourceAccount = uuidText(cell(row, "source_account_id", MERGES_RELATION), MERGES_RELATION, "source_account_id") as {
      original: string;
      canonical: string;
    };
    const targetAccount = uuidText(cell(row, "target_account_id", MERGES_RELATION), MERGES_RELATION, "target_account_id") as {
      original: string;
      canonical: string;
    };
    const mappedSource = lookupAccount(accounts, sourceAccount.original, MERGES_RELATION, "source_account_id");
    const mappedTarget = lookupAccount(accounts, targetAccount.original, MERGES_RELATION, "target_account_id");
    const legacyMode = enumValue(
      cell(row, "merge_mode", MERGES_RELATION),
      ["promoted", "merged_existing"] as const,
      MERGES_RELATION,
      "merge_mode",
    );
    const steamId = steamIdText(cell(row, "verified_steam_id", MERGES_RELATION), MERGES_RELATION, "verified_steam_id") as string;
    const createdAt = instant(cell(row, "created_at", MERGES_RELATION), MERGES_RELATION, "created_at", true) as PgTimestamp;
    const analyticsDeliveredAt = instant(
      nullableCell(row, "analytics_delivered_at", MERGES_RELATION),
      MERGES_RELATION,
      "analytics_delivered_at",
      false,
    );
    requireOrder(createdAt, analyticsDeliveredAt, MERGES_RELATION, "analytics_delivered_at");

    // Preserve the source relation's semantic CHECK before deriving the v2
    // spelling.  Otherwise a corrupt `promoted` row could silently become a
    // merge (or the reverse) merely because the target validates a different
    // literal vocabulary.
    if (
      (legacyMode === "promoted" && mappedSource !== mappedTarget) ||
      (legacyMode === "merged_existing" && mappedSource === mappedTarget)
    ) {
      remainingFailure("remaining_order_conflict", MERGES_RELATION, "merge_mode");
    }

    // ops.account_merges' CHECK ties the mode to whether the two accounts are
    // the same row: promote means one account was raised in place, merge means
    // two rows became one. The legacy literal is kept verbatim beside it in
    // legacy_merge_mode rather than being translated away.
    const mode: "promote" | "merge" = mappedSource === mappedTarget ? "promote" : "merge";
    merges.push(
      Object.freeze({
        source_account_id: mappedSource,
        target_account_id: mappedTarget,
        mode,
        verified_steam_id: steamId,
        reason: `legacy account_merges.merge_mode=${legacyMode}`,
        created_at: createdAt,
        legacy_merge_id: mergeId.original,
        legacy_merge_mode: legacyMode,
        source_public_id: sourceAccount.original,
        target_public_id: targetAccount.original,
        analytics_delivered_at: analyticsDeliveredAt,
      }),
    );
    if (mode === "merge") {
      // ops.account_aliases requires the two to differ; a promotion has no
      // alias because nothing was renamed.
      aliases.push(
        Object.freeze({
          source_account_id: mappedSource,
          target_account_id: mappedTarget,
          source_public_id: sourceAccount.original,
          created_at: createdAt,
          expires_at: null,
        }),
      );
    }
    mergeAudit.push(
      Object.freeze({
        legacy_merge_id: mergeId.original,
        mapped_source_account_id: mappedSource,
        mapped_target_account_id: mappedTarget,
        source_account_id: sourceAccount.original,
        target_account_id: targetAccount.original,
        verified_steam_id: steamId,
        merge_mode: legacyMode,
        created_at: createdAt,
        analytics_delivered_at: analyticsDeliveredAt,
        source_tombstone_present: tombstoneById.get(mergeId.canonical) ?? false,
        retention_class: "staging-30d-post-cutover" as const,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  /* ---- migration.legacy_auth_intent_audit ------------------------------ */
  const intents: LegacyAuthIntentAuditRecord[] = [];
  const seenIntentIds = new Set<string>();
  for (const raw of remainingRows(input.securityIntents ?? [], INTENTS_RELATION)) {
    const row = remainingRow(raw, INTENTS_RELATION, run);
    requireColumns(row, INTENTS_SOURCE_COLUMNS, INTENTS_RELATION);
    const intentId = uuidText(cell(row, "id", INTENTS_RELATION), INTENTS_RELATION, "id") as {
      original: string;
      canonical: string;
    };
    if (seenIntentIds.has(intentId.canonical)) remainingFailure("remaining_duplicate_row", INTENTS_RELATION, "id");
    seenIntentIds.add(intentId.canonical);
    const sourceAccount = uuidText(cell(row, "source_account_id", INTENTS_RELATION), INTENTS_RELATION, "source_account_id") as {
      original: string;
      canonical: string;
    };
    const accountId = lookupAccount(accounts, sourceAccount.original, INTENTS_RELATION, "source_account_id");
    const sessionId = uuidText(
      nullableCell(row, "source_manual_session_id", INTENTS_RELATION),
      INTENTS_RELATION,
      "source_manual_session_id",
      false,
    );
    const createdAt = instant(cell(row, "created_at", INTENTS_RELATION), INTENTS_RELATION, "created_at", true) as PgTimestamp;
    const expiresAt = instant(cell(row, "expires_at", INTENTS_RELATION), INTENTS_RELATION, "expires_at", true) as PgTimestamp;
    const consumedAt = instant(nullableCell(row, "consumed_at", INTENTS_RELATION), INTENTS_RELATION, "consumed_at", false);
    requireOrder(createdAt, expiresAt, INTENTS_RELATION, "expires_at");
    requireOrder(createdAt, consumedAt, INTENTS_RELATION, "consumed_at");
    const targetAccount = uuidText(
      nullableCell(row, "target_account_id", INTENTS_RELATION),
      INTENTS_RELATION,
      "target_account_id",
      false,
    );
    // The audit's own CHECK pairs the two target columns, so an unmapped
    // target is refused rather than half-written.
    const targetMapped =
      targetAccount === null ? null : lookupAccount(accounts, targetAccount.original, INTENTS_RELATION, "target_account_id");
    // The token digest and provider nonce are validated for shape and then
    // deliberately not carried; see INTENTS_RETIRED_SOURCE_COLUMNS.
    sha256Hex(cell(row, "token_hash", INTENTS_RELATION), INTENTS_RELATION, "token_hash");
    nullableCell(row, "openid_response_nonce", INTENTS_RELATION);

    intents.push(
      Object.freeze({
        legacy_intent_id: intentId.original,
        account_id: accountId,
        source_account_id: sourceAccount.original,
        legacy_session_id: sessionId === null ? null : sessionId.original,
        created_at: createdAt,
        expires_at: expiresAt,
        consumed_at: consumedAt,
        target_account_id: targetAccount === null ? null : targetAccount.original,
        target_mapped_account_id: targetMapped,
        verified_steam_id: steamIdText(
          nullableCell(row, "verified_steam_id", INTENTS_RELATION),
          INTENTS_RELATION,
          "verified_steam_id",
          false,
        ),
        // The source outcome is kept exactly as found. An intent that has
        // simply run out of time is NOT relabelled 'expired' here: that would
        // need a freeze instant this transform refuses to invent, and the
        // expiry is already derivable from expires_at.
        outcome: nullableCell(row, "outcome", INTENTS_RELATION),
        retention_class: "staging-30d-post-cutover" as const,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  workerRuns.sort((left, right) => compareText(left.legacy_id, right.legacy_id));
  importReports.sort((left, right) => left.account_id - right.account_id);
  cooldowns.sort(
    (left, right) => compareText(left.bucket, right.bucket) || compareText(left.key_digest, right.key_digest),
  );
  merges.sort((left, right) => compareText(left.legacy_merge_id, right.legacy_merge_id));
  aliases.sort((left, right) => left.source_account_id - right.source_account_id);
  mergeAudit.sort((left, right) => compareText(left.legacy_merge_id, right.legacy_merge_id));
  intents.sort((left, right) => compareText(left.legacy_intent_id, right.legacy_intent_id));

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    legacy_worker_runs: Object.freeze(workerRuns),
    import_freeze_report: Object.freeze(importReports),
    abuse_cooldowns: Object.freeze(cooldowns),
    account_merges: Object.freeze(merges),
    account_aliases: Object.freeze(aliases),
    legacy_account_merge_audit: Object.freeze(mergeAudit),
    legacy_auth_intent_audit: Object.freeze(intents),
    blockers: blockers.toRecords(),
    counts: Object.freeze({
      worker_runs: workerRuns.length,
      failure_runs: failureRuns,
      import_reports: importReports.length,
      in_flight_imports: inFlightImports,
      rate_limit_rows: rateLimitRows.length,
      cooldowns_emitted: cooldowns.length,
      merges: merges.length,
      aliases: aliases.length,
      intents: intents.length,
    }),
  });
}
