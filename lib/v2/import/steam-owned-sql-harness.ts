import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createSteamOwned10kFixture,
  type SteamOwned10kFixture
} from "./steam-owned-10k-fixture.ts";
import {
  runSteamOwnedSnapshotJob,
  resumeSteamOwnedSnapshotPublish,
  type SteamOwnedJobClaim,
  type SteamOwnedJobDatabase,
  type SteamOwnedJobRunResult,
  type SteamOwnedJobOrchestratorOptions,
  type SteamOwnedPreparedPublish,
  type SteamOwnedSnapshotPublishResult,
  type SteamOwnedSnapshotRetryResult,
  type SteamOwnedSnapshotTransport
} from "./steam-owned-job-orchestrator.ts";
import type { SteamOwnedFetchComplete } from "./steam-owned-fetch.ts";
import {
  DEFAULT_MAX_GAMES,
  MAX_TIMESTAMPTZ_EPOCH_SECONDS
} from "./steam-owned-snapshot.ts";

/**
 * These names and positional argument arrays mirror database/v2/M2-contract.md.
 * The mapping core has no SQL client or implicit connection; a caller may opt
 * into the bounded local psql adapter below when the migration is frozen.
 */
export const M2_SQL_FUNCTIONS = {
  claimJob: "ops.claim_job",
  publishOwnedSnapshot: "ops.publish_owned_snapshot",
  retryJob: "ops.retry_job"
} as const;

export type M2SqlFunctionName = typeof M2_SQL_FUNCTIONS[keyof typeof M2_SQL_FUNCTIONS];

export type M2SqlCall = {
  functionName: M2SqlFunctionName;
  /** Positional values in the exact frozen function order. */
  args: readonly unknown[];
};

/** A psql, pg, or Supabase test adapter supplied by the caller. */
export type M2SqlInvoker = (call: M2SqlCall) => Promise<unknown>;

export type PsqlM2SqlInvokerOptions = {
  /** Explicit executable; no shell is involved. */
  psqlPath: string;
  host: string;
  port: number;
  user: string;
  database: string;
  timeoutMs?: number;
  /** Role that owns the narrow worker execute grants in the fixture DB. */
  workerRole: string;
  /** Explicitly enables the transaction-local fixture guard when true. */
  fixtureMode: boolean;
};

export type M2PsqlQueryContext = {
  /** Optional for query inspection; required by the psql invoker. */
  workerRole?: string;
  /** Defaults to false for query inspection. */
  fixtureMode?: boolean;
};

export const DEFAULT_PSQL_M2_TIMEOUT_MS = 60_000;
export const MAX_PSQL_M2_TIMEOUT_MS = 120_000;
// A PostgreSQL literal can double every apostrophe in the 8 MiB canonical
// limit, so leave room for worst-case escaping plus the fixed statement.
const MAX_PSQL_M2_STDIN_BYTES = 18 * 1024 * 1024;
const MAX_PSQL_M2_STDOUT_BYTES = 4 * 1024 * 1024;

export type M2SqlHarnessHooks = {
  onCall?: (call: M2SqlCall) => void;
  onPublishRow?: (row: M2OwnedPublishRow) => void;
  onRetryRow?: (row: M2OwnedRetryRow) => void;
};

export type M2OwnedPublishRow = {
  result: "applied" | "already_applied" | "stale";
  jobId: string;
  accountId: number | null;
  generation: string | null;
  appliedGeneration: string | null;
  snapshotHash: Uint8Array | null;
  observedCount: number | null;
  libraryChanged: number;
  activityChanged: number;
  retiredCount: number;
  sweepDeferredCount: number;
  enrichmentEnqueued: number;
  acknowledged: boolean;
};

export type M2OwnedRetryRow = {
  status: SteamOwnedSnapshotRetryResult["status"];
  retryAt: string | null;
  attempt: number;
  acknowledged: boolean;
};

export type M2ClaimLane = "interactive" | "background";

export type ClaimOneM2OwnedSnapshotResult =
  | { status: "claimed"; claim: SteamOwnedJobClaim }
  | { status: "not_claimed"; blockCode: string | null; retryAt: string | null }
  | { status: "invalid_claim_row" }
  | { status: "db_error"; phase: "claim"; code: "claim_failed" };

export type RunSteamOwned10kSqlFixtureOptions = {
  sql: M2SqlInvoker;
  nowEpochSeconds: () => number;
  lane?: M2ClaimLane;
  visibilitySeconds?: number;
  signal?: AbortSignal;
  fixture?: SteamOwned10kFixture;
  hooks?: M2SqlHarnessHooks;
};

export type RunSteamOwned10kSqlFixtureResult =
  | ClaimOneM2OwnedSnapshotResult
  | {
      status: "ran";
      claim: SteamOwnedJobClaim;
      result: SteamOwnedJobRunResult;
      fetchCount: number;
      fixture: SteamOwned10kFixture;
    };

export type RunClaimedSteamOwnedSqlOptions = {
  sql: M2SqlInvoker;
  nowEpochSeconds: () => number;
  transport: SteamOwnedSnapshotTransport;
  signal?: AbortSignal;
  hooks?: M2SqlHarnessHooks;
};

/**
 * Create a deliberately opt-in local psql transport. It is kept separate
 * from the normal application path: callers must provide the executable and
 * connection coordinates, and every value is sent as a structured SQL
 * literal over stdin with no shell interpolation. The returned function makes
 * one SQL process per RPC and never retries a failed call.
 */
export function createPsqlM2SqlInvoker(options: PsqlM2SqlInvokerOptions): M2SqlInvoker {
  const checked = validatePsqlOptions(options);
  if (checked === null) throw new Error("invalid psql M2 harness options");
  return async (call) => {
    const query = buildM2PsqlQuery(call, checked.timeoutMs, checked);
    const queryBytes = new TextEncoder().encode(query).byteLength;
    if (queryBytes > MAX_PSQL_M2_STDIN_BYTES) {
      throw new Error("M2 psql query exceeds the bounded input size");
    }
    return runPsqlQuery(checked, query);
  };
}

/**
 * Render one of the frozen M2 calls for psql. All caller data is quoted as a
 * PostgreSQL literal and then cast to the contract type; the function names
 * and casts are fixed constants. This is exported so an isolated SQL test can
 * inspect or execute the exact statement without copying the parameter logic.
 */
export function buildM2PsqlQuery(
  call: M2SqlCall,
  timeoutMs = DEFAULT_PSQL_M2_TIMEOUT_MS,
  context: M2PsqlQueryContext = {}
): string {
  if (!isIntegerInRange(timeoutMs, 1, MAX_PSQL_M2_TIMEOUT_MS)) {
    throw new Error("invalid psql M2 timeout");
  }
  const workerRole = context.workerRole;
  const fixtureMode = context.fixtureMode ?? false;
  if ((workerRole !== undefined && !sqlIdentifier(workerRole))
    || typeof fixtureMode !== "boolean"
    || (fixtureMode && workerRole === undefined)) {
    throw new Error("invalid psql M2 session context");
  }
  const statement = buildM2PsqlStatement(call);
  const jsonRow = buildM2PsqlJsonRow(call.functionName);
  const setup = [
    "begin;",
    `set local statement_timeout = ${timeoutMs};`,
    "set local timezone = 'UTC';",
    "set local standard_conforming_strings = on;"
  ];
  if (workerRole !== undefined) setup.push(`set local role ${pgIdentifier(workerRole)};`);
  setup.push(`set local app.m2_fixture = '${fixtureMode ? "on" : "off"}';`);
  return [
    ...setup,
    "select coalesce(json_agg(",
    jsonRow,
    "), '[]'::json)::text",
    `from (${statement}) as result_row;`,
    "commit;"
  ].join("\n");
}

/**
 * Adapt the three frozen M2 definer functions to the pure orchestrator. The
 * adapter intentionally rejects a SQL row whose result/status is outside the
 * contract; a draft database returning `invalid` or `failed` is surfaced as a
 * sanitized orchestrator db_error rather than being treated as success.
 */
export function createM2SqlDatabase(
  sql: M2SqlInvoker,
  hooks: M2SqlHarnessHooks = {}
): SteamOwnedJobDatabase {
  return {
    publishOwnedSnapshot: async (call) => {
      const sqlCall: M2SqlCall = {
        functionName: M2_SQL_FUNCTIONS.publishOwnedSnapshot,
        // p_job_id, p_lease_token, p_result, p_canonical_json,
        // p_content_hash, p_body_observed_at, p_message_id
        args: [
          call.jobId,
          call.leaseToken,
          call.result,
          call.canonicalJson,
          call.contentHash,
          call.bodyObservedAt,
          call.messageId
        ]
      };
      hooks.onCall?.(sqlCall);
      const row = parseM2PublishRow(await sql(sqlCall));
      if (row === null
        || call.result.status === "complete"
          && row.result !== "stale"
          && (row.snapshotHash === null || row.observedCount !== call.result.gameCount)) {
        throw new Error("M2 publish returned an invalid row");
      }
      hooks.onPublishRow?.(row);
      return {
        result: row.result,
        acknowledged: row.acknowledged
      } satisfies SteamOwnedSnapshotPublishResult;
    },
    retryJob: async (call) => {
      const sqlCall: M2SqlCall = {
        functionName: M2_SQL_FUNCTIONS.retryJob,
        // p_job_id, p_lease_token, p_error_code, p_error_detail,
        // p_provider_retry_at, p_retry_policy, p_message_id
        args: [
          call.jobId,
          call.leaseToken,
          call.errorCode,
          call.errorDetail,
          call.providerRetryAt,
          call.retryPolicy,
          call.messageId
        ]
      };
      hooks.onCall?.(sqlCall);
      const row = parseM2RetryRow(await sql(sqlCall));
      if (row === null) throw new Error("M2 retry returned an invalid row");
      hooks.onRetryRow?.(row);
      return row satisfies SteamOwnedSnapshotRetryResult;
    }
  };
}

/**
 * Call ops.claim_job exactly once and map its DB-derived identity into the
 * orchestrator claim. This is a one-attempt fixture harness, not a queue
 * poller: an unrelated catalogue row is rejected and never discarded.
 */
export async function claimOneM2OwnedSnapshot(
  sql: M2SqlInvoker,
  options: {
    lane?: M2ClaimLane;
    visibilitySeconds?: number;
    hooks?: M2SqlHarnessHooks;
  } = {}
): Promise<ClaimOneM2OwnedSnapshotResult> {
  if (typeof sql !== "function" || !isRecord(options)) {
    return { status: "db_error", phase: "claim", code: "claim_failed" };
  }
  const lane = options.lane ?? "background";
  const visibilitySeconds = options.visibilitySeconds ?? 120;
  if ((lane !== "interactive" && lane !== "background")
    || !isIntegerInRange(visibilitySeconds, 15, 300)) {
    return { status: "invalid_claim_row" };
  }

  const sqlCall: M2SqlCall = {
    functionName: M2_SQL_FUNCTIONS.claimJob,
    // p_lane, p_visibility_seconds
    args: [lane, visibilitySeconds]
  };
  options.hooks?.onCall?.(sqlCall);

  let raw: unknown;
  try {
    raw = await sql(sqlCall);
  } catch {
    return { status: "db_error", phase: "claim", code: "claim_failed" };
  }
  const rows = sqlRows(raw);
  if (rows === null || rows.length !== 1) return { status: "invalid_claim_row" };
  const row = rows[0];
  if (row.claimed === false) {
    return {
      status: "not_claimed",
      blockCode: boundedText(row.block_code),
      retryAt: sqlTimestampToIso(row.retry_at)
    };
  }
  const claim = parseClaimRow(row);
  return claim === null
    ? { status: "invalid_claim_row" }
    : { status: "claimed", claim };
}

/**
 * Execute one claimed fixture attempt through the actual normalizer output,
 * the pure orchestrator, and the exact SQL publish/retry argument mapping.
 * No live transport is supplied even if a real claim accidentally says live.
 */
export async function runSteamOwned10kFixtureAgainstM2Sql(
  options: RunSteamOwned10kSqlFixtureOptions
): Promise<RunSteamOwned10kSqlFixtureResult> {
  if (!isRecord(options)
    || typeof options.sql !== "function"
    || typeof options.nowEpochSeconds !== "function") {
    return { status: "db_error", phase: "claim", code: "claim_failed" };
  }
  const claimResult = await claimOneM2OwnedSnapshot(options.sql, {
    lane: options.lane,
    visibilitySeconds: options.visibilitySeconds,
    hooks: options.hooks
  });
  if (claimResult.status !== "claimed") return claimResult;

  const fixture = options.fixture ?? createSteamOwned10kFixture();
  let fetchCount = 0;
  const result = await runClaimedSteamOwnedSnapshotAgainstM2Sql(claimResult.claim, {
    sql: options.sql,
    nowEpochSeconds: options.nowEpochSeconds,
    signal: options.signal,
    hooks: options.hooks,
    transport: async (_claim, signal) => {
      if (signal.aborted) throw new Error("fixture transport cancelled");
      fetchCount += 1;
      // The game evidence is historical and remains in canonicalJson/hash;
      // only receipt provenance is sampled from the SQL/worker clock here.
      const observedAt = options.nowEpochSeconds();
      if (!isIntegerInRange(observedAt, 0, MAX_TIMESTAMPTZ_EPOCH_SECONDS)) {
        throw new Error("fixture observation clock is invalid");
      }
      return snapshotAtObservation(fixture.snapshot, observedAt);
    }
  });
  return { status: "ran", claim: claimResult.claim, result, fetchCount, fixture };
}

function snapshotAtObservation(
  snapshot: SteamOwnedFetchComplete,
  observationTimeEpochSeconds: number
): SteamOwnedFetchComplete {
  return {
    ...snapshot,
    provenance: {
      ...snapshot.provenance,
      observationTimeEpochSeconds
    }
  };
}

/**
 * Run one already-mapped claim with an explicitly injected result transport.
 * This is useful for exercising private, invalid, and deferred outcomes with
 * the same real SQL adapter while keeping all provider I/O in the test.
 */
export async function runClaimedSteamOwnedSnapshotAgainstM2Sql(
  claim: SteamOwnedJobClaim,
  options: RunClaimedSteamOwnedSqlOptions
): Promise<SteamOwnedJobRunResult> {
  if (!isRecord(options)
    || typeof options.sql !== "function"
    || typeof options.nowEpochSeconds !== "function"
    || typeof options.transport !== "function") {
    return { status: "refused", reason: "invalid_dependencies" };
  }
  const orchestratorOptions: SteamOwnedJobOrchestratorOptions = {
    db: createM2SqlDatabase(options.sql, options.hooks),
    nowEpochSeconds: options.nowEpochSeconds,
    signal: options.signal,
    transports: {
      fixture: options.transport
    }
  };
  return runSteamOwnedSnapshotJob(claim, orchestratorOptions);
}

/** Resume only a prepared publish; this function never invokes a transport. */
export async function resumeM2SqlPreparedPublish(
  prepared: SteamOwnedPreparedPublish,
  sql: M2SqlInvoker,
  hooks: M2SqlHarnessHooks = {}
): Promise<SteamOwnedJobRunResult> {
  return resumeSteamOwnedSnapshotPublish(prepared, {
    db: createM2SqlDatabase(sql, hooks)
  });
}

export type M2PublishVerificationExpected = {
  gameCount: number;
  contentHash: string;
  changed?: Partial<{
    libraryChanged: number;
    activityChanged: number;
    retiredCount: number;
    sweepDeferredCount: number;
    enrichmentEnqueued: number;
  }>;
};

/**
 * Assert the fields that a real SQL integration must return for the fixture.
 * In particular, a second identical publish can pass `changed` values of zero
 * to prove the transaction made no duplicate row changes. The helper consumes
 * actual SQL output; it does not emulate the publisher or normalize JSON.
 */
export function assertM2PublishRowForFixture(
  raw: unknown,
  expected: M2PublishVerificationExpected
): M2OwnedPublishRow {
  const row = parseM2PublishRow(raw);
  if (row === null) throw new Error("M2 publish result is outside the frozen contract");
  if (!isIntegerInRange(expected.gameCount, 0, DEFAULT_MAX_GAMES)) {
    throw new Error("fixture game count is outside the frozen bound");
  }
  if (row.observedCount !== expected.gameCount) {
    throw new Error("M2 publish observed_count does not match the fixture");
  }
  const expectedHash = decodeHexHash(expected.contentHash);
  if (expectedHash === null || row.snapshotHash === null || !bytesEqual(row.snapshotHash, expectedHash)) {
    throw new Error("M2 publish snapshot_hash does not match the fixture");
  }
  for (const [key, value] of Object.entries(expected.changed ?? {})) {
    if (row[key as keyof Pick<M2OwnedPublishRow, "libraryChanged" | "activityChanged" | "retiredCount" | "sweepDeferredCount" | "enrichmentEnqueued">] !== value) {
      throw new Error(`M2 publish ${key} changed count does not match the fixture expectation`);
    }
  }
  return row;
}

type CheckedPsqlM2SqlInvokerOptions = PsqlM2SqlInvokerOptions & {
  timeoutMs: number;
};

function validatePsqlOptions(
  options: PsqlM2SqlInvokerOptions
): CheckedPsqlM2SqlInvokerOptions | null {
  if (!isRecord(options)
    || !boundedConnectionText(options.psqlPath, 1024)
    || !boundedConnectionText(options.host, 255)
    || !boundedConnectionText(options.user, 128)
    || !boundedConnectionText(options.database, 128)
    || !isIntegerInRange(options.port, 1, 65_535)
    || !sqlIdentifier(options.workerRole)
    || typeof options.fixtureMode !== "boolean") {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PSQL_M2_TIMEOUT_MS;
  if (!isIntegerInRange(timeoutMs, 1, MAX_PSQL_M2_TIMEOUT_MS)) return null;
  return { ...options, timeoutMs };
}

function buildM2PsqlStatement(call: M2SqlCall): string {
  if (!isRecord(call) || !isM2SqlFunctionName(call.functionName) || !Array.isArray(call.args)) {
    throw new Error("invalid M2 SQL call");
  }
  if (call.functionName === M2_SQL_FUNCTIONS.claimJob) {
    if (call.args.length !== 2
      || (call.args[0] !== "interactive" && call.args[0] !== "background")
      || !isIntegerInRange(call.args[1], 15, 300)) {
      throw new Error("invalid M2 claim arguments");
    }
    return `select * from ops.claim_job(${pgText(call.args[0])}, ${pgInteger(call.args[1])})`;
  }

  if (call.functionName === M2_SQL_FUNCTIONS.publishOwnedSnapshot) {
    if (call.args.length !== 7) throw new Error("invalid M2 publish arguments");
    const [jobId, leaseToken, result, canonicalJson, contentHash, bodyObservedAt, messageId] = call.args;
    return [
      "select * from ops.publish_owned_snapshot(",
      `${pgUuid(jobId)},`,
      `${pgUuid(leaseToken)},`,
      `${pgJsonb(result)},`,
      `${pgNullableText(canonicalJson)},`,
      `${pgNullableBytea(contentHash)},`,
      `${pgNullableTimestamp(bodyObservedAt)},`,
      `${pgNullableBigint(messageId)})`
    ].join("\n");
  }

  if (call.args.length !== 7) throw new Error("invalid M2 retry arguments");
  const [jobId, leaseToken, errorCode, errorDetail, providerRetryAt, retryPolicy, messageId] = call.args;
  if (retryPolicy !== "retryable" && retryPolicy !== "deferred" && retryPolicy !== "non_retryable") {
    throw new Error("invalid M2 retry policy");
  }
  return [
    "select * from ops.retry_job(",
    `${pgUuid(jobId)},`,
    `${pgUuid(leaseToken)},`,
    `${pgText(errorCode)},`,
    `${pgText(errorDetail)},`,
    `${pgNullableTimestamp(providerRetryAt)},`,
    `${pgText(retryPolicy)},`,
    `${pgNullableBigint(messageId)})`
  ].join("\n");
}

/**
 * JSON.parse cannot represent PostgreSQL bigint values without rounding them.
 * The claim adapter therefore casts every declared bigint output to text while
 * building the JSON row. The parser keeps those values as decimal strings.
 */
function buildM2PsqlJsonRow(functionName: M2SqlFunctionName): string {
  if (functionName === M2_SQL_FUNCTIONS.claimJob) {
    return [
      "json_build_object(",
      "'claimed', result_row.claimed,",
      "'block_code', result_row.block_code,",
      "'retry_at', result_row.retry_at,",
      "'job_id', result_row.job_id,",
      "'message_id', result_row.message_id::text,",
      "'job_kind', result_row.job_kind,",
      "'account_id', result_row.account_id,",
      "'game_id', result_row.game_id,",
      "'provider', result_row.provider,",
      "'provider_subject', result_row.provider_subject::text,",
      "'provider_mode', result_row.provider_mode,",
      "'generation', result_row.generation::text,",
      "'catalog_revision', result_row.catalog_revision::text,",
      "'lease_token', result_row.lease_token,",
      "'attempt', result_row.attempt,",
      "'attempt_id', result_row.attempt_id,",
      "'attempt_token', result_row.attempt_token,",
      "'charged_at', result_row.charged_at,",
      "'fetch_started_at', result_row.fetch_started_at,",
      "'lease_expires_at', result_row.lease_expires_at,",
      "'global_daily_remaining', result_row.global_daily_remaining::text,",
      "'background_daily_remaining', result_row.background_daily_remaining::text,",
      "'global_tokens', result_row.global_tokens,",
      "'background_tokens', result_row.background_tokens",
      ")"
    ].join("\n");
  }

  if (functionName === M2_SQL_FUNCTIONS.publishOwnedSnapshot) {
    return [
      "json_build_object(",
      "'result', result_row.result,",
      "'job_id', result_row.job_id,",
      "'account_id', result_row.account_id,",
      "'generation', result_row.generation::text,",
      "'applied_generation', result_row.applied_generation::text,",
      "'snapshot_hash', case when result_row.snapshot_hash is null then null else",
      "  '\\x' || encode(result_row.snapshot_hash, 'hex') end,",
      "'observed_count', result_row.observed_count,",
      "'library_changed', result_row.library_changed,",
      "'activity_changed', result_row.activity_changed,",
      "'retired_count', result_row.retired_count,",
      "'sweep_deferred_count', result_row.sweep_deferred_count,",
      "'enrichment_enqueued', result_row.enrichment_enqueued,",
      "'acknowledged', result_row.acknowledged",
      ")"
    ].join("\n");
  }

  return [
    "json_build_object(",
    "'status', result_row.status,",
    "'retry_at', result_row.retry_at,",
    "'attempt', result_row.attempt,",
    "'acknowledged', result_row.acknowledged",
    ")"
  ].join("\n");
}

function runPsqlQuery(
  options: CheckedPsqlM2SqlInvokerOptions,
  query: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.psqlPath, [
        "-X",
        "-q",
        "-A",
        "-t",
        "-w",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        options.host,
        "-p",
        String(options.port),
        "-U",
        options.user,
        "-d",
        options.database,
        "-f",
        "-"
      ], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          LC_ALL: "C",
          PAGER: "cat",
          PSQL_PAGER: "off"
        } as unknown as NodeJS.ProcessEnv
      }) as ChildProcessWithoutNullStreams;
    } catch {
      reject(new Error("M2 psql invocation failed"));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    const stdoutChunks: Uint8Array[] = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("M2 psql invocation timed out"));
    }, options.timeoutMs);
    const finishError = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    child.stdout.on("data", (chunk: Uint8Array) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_PSQL_M2_STDOUT_BYTES) {
        child.kill("SIGTERM");
        finishError("M2 psql output exceeds the bounded size");
        return;
      }
      stdoutChunks.push(new Uint8Array(chunk));
    });
    // Never retain database error text; the caller receives only a fixed code.
    child.stderr.resume();
    child.stdin.on("error", () => finishError("M2 psql input failed"));
    child.on("error", () => finishError("M2 psql invocation failed"));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("M2 psql call failed"));
        return;
      }
      const output = decodeBytes(stdoutChunks, stdoutBytes).trim();
      if (output.length === 0) {
        resolve([]);
        return;
      }
      try {
        resolve(JSON.parse(output) as unknown);
      } catch {
        reject(new Error("M2 psql returned invalid JSON"));
      }
    });
    child.stdin.end(query, "utf8");
  });
}

function decodeBytes(chunks: Uint8Array[], byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function pgJsonb(value: unknown): string {
  if (!isRecord(value) || Array.isArray(value)) throw new Error("M2 result must be an object");
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error("M2 result cannot be serialized");
  }
  if (typeof json !== "string") throw new Error("M2 result cannot be serialized");
  return `${pgLiteral(json)}::jsonb`;
}

function pgUuid(value: unknown): string {
  if (typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("M2 identifier is not a UUID");
  }
  return `${pgLiteral(value)}::uuid`;
}

function pgText(value: unknown): string {
  if (typeof value !== "string") throw new Error("M2 text argument is invalid");
  return `${pgLiteral(value)}::text`;
}

function pgNullableText(value: unknown): string {
  return value === null ? "NULL::text" : pgText(value);
}

function pgNullableTimestamp(value: unknown): string {
  if (value === null) return "NULL::timestamptz";
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error("M2 timestamp argument is invalid");
  }
  return `${pgLiteral(value)}::timestamptz`;
}

function pgNullableBytea(value: unknown): string {
  if (value === null) return "NULL::bytea";
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("M2 hash argument is invalid");
  }
  let hex = "";
  for (const byte of value) hex += byte.toString(16).padStart(2, "0");
  return `${pgLiteral(`\\x${hex}`)}::bytea`;
}

function pgNullableBigint(value: unknown): string {
  if (value === null) return "NULL::bigint";
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error("M2 bigint argument is invalid");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt("9223372036854775807")) throw new Error("M2 bigint argument is out of range");
  return `${pgLiteral(value)}::bigint`;
}

function pgInteger(value: unknown): string {
  if (!isIntegerInRange(value, 0, 2_147_483_647)) throw new Error("M2 integer argument is invalid");
  return `${String(value)}::integer`;
}

function pgLiteral(value: string): string {
  if (value.includes("\u0000")) throw new Error("M2 SQL literal contains NUL");
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z_][a-z0-9_]{0,62}$/.test(value);
}

function pgIdentifier(value: string): string {
  if (!sqlIdentifier(value)) throw new Error("M2 SQL role identifier is invalid");
  return `"${value}"`;
}

function isM2SqlFunctionName(value: unknown): value is M2SqlFunctionName {
  return value === M2_SQL_FUNCTIONS.claimJob
    || value === M2_SQL_FUNCTIONS.publishOwnedSnapshot
    || value === M2_SQL_FUNCTIONS.retryJob;
}

function boundedConnectionText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\u0000");
}

function parseM2PublishRow(raw: unknown): M2OwnedPublishRow | null {
  const rows = sqlRows(raw);
  if (rows === null || rows.length !== 1) return null;
  const row = rows[0];
  const result = row.result;
  if (result !== "applied" && result !== "already_applied" && result !== "stale") return null;
  const jobId = boundedText(row.job_id);
  const accountId = nullableIntegerValue(row.account_id, 1, 2_147_483_647);
  const generation = nullableDecimalIntegerText(row.generation, false);
  const appliedGeneration = nullableDecimalIntegerText(row.applied_generation, false);
  const snapshotHash = byteaValue(row.snapshot_hash);
  const observedCount = nullableIntegerValue(row.observed_count, 0, Number.MAX_SAFE_INTEGER);
  const libraryChanged = integerValue(row.library_changed, 0, Number.MAX_SAFE_INTEGER);
  const activityChanged = integerValue(row.activity_changed, 0, Number.MAX_SAFE_INTEGER);
  const retiredCount = integerValue(row.retired_count, 0, Number.MAX_SAFE_INTEGER);
  const sweepDeferredCount = integerValue(row.sweep_deferred_count, 0, Number.MAX_SAFE_INTEGER);
  const enrichmentEnqueued = integerValue(row.enrichment_enqueued, 0, Number.MAX_SAFE_INTEGER);
  if (jobId === null
    || invalidNullable(row.account_id, accountId)
    || invalidNullable(row.generation, generation)
    || invalidNullable(row.applied_generation, appliedGeneration)
    || invalidNullable(row.observed_count, observedCount)
    || invalidNonnullable(row.snapshot_hash, snapshotHash)
    || libraryChanged === null || activityChanged === null || retiredCount === null
    || sweepDeferredCount === null || enrichmentEnqueued === null
    || typeof row.acknowledged !== "boolean") {
    return null;
  }
  return {
    result,
    jobId,
    accountId,
    generation,
    appliedGeneration,
    snapshotHash,
    observedCount,
    libraryChanged,
    activityChanged,
    retiredCount,
    sweepDeferredCount,
    enrichmentEnqueued,
    acknowledged: row.acknowledged
  };
}

function parseM2RetryRow(raw: unknown): M2OwnedRetryRow | null {
  const rows = sqlRows(raw);
  if (rows === null || rows.length !== 1) return null;
  const row = rows[0];
  const statuses: readonly SteamOwnedSnapshotRetryResult["status"][] = [
    "retryable", "deferred", "non_retryable", "stale", "failed", "cancelled", "already_applied"
  ];
  if (typeof row.status !== "string" || !statuses.includes(row.status as SteamOwnedSnapshotRetryResult["status"])) return null;
  const attempt = integerValue(row.attempt, 0, 10);
  const retryAt = sqlTimestampToIso(row.retry_at);
  if (attempt === null || (row.retry_at !== null && row.retry_at !== undefined && retryAt === null)
    || typeof row.acknowledged !== "boolean") return null;
  return {
    status: row.status as SteamOwnedSnapshotRetryResult["status"],
    retryAt,
    attempt,
    acknowledged: row.acknowledged
  };
}

function parseClaimRow(row: Record<string, unknown>): SteamOwnedJobClaim | null {
  if (row.claimed !== true
    || row.job_kind !== "owned_snapshot"
    || row.provider !== "steam"
    || row.game_id !== null
    || row.catalog_revision !== null) return null;
  const jobId = boundedText(row.job_id);
  const rawMessageId = row.message_id;
  const messageId = rawMessageId === null || rawMessageId === undefined
    ? null
    : positiveDecimal(rawMessageId, false);
  const steamId = positiveDecimal(row.provider_subject, true);
  const providerMode = row.provider_mode;
  const generation = decimalIntegerText(row.generation, false);
  const leaseToken = boundedText(row.lease_token);
  const attemptId = boundedText(row.attempt_id);
  const attemptToken = boundedText(row.attempt_token);
  const chargedAt = sqlTimestampToIso(row.charged_at);
  const fetchStartedAt = sqlTimestampToIso(row.fetch_started_at);
  const leaseExpiresAt = sqlTimestampToIso(row.lease_expires_at);
  const accountId = integerValue(row.account_id, 1, 2_147_483_647);
  const attempt = integerValue(row.attempt, 1, 10);
  if (jobId === null || steamId === null || generation === null || leaseToken === null
    || attemptId === null || attemptToken === null || chargedAt === null
    || fetchStartedAt === null || leaseExpiresAt === null || accountId === null
    || attempt === null
    || (rawMessageId !== null && rawMessageId !== undefined && messageId === null)
    || (providerMode !== "disabled" && providerMode !== "fixture" && providerMode !== "live")) {
    return null;
  }
  return {
    claimed: true,
    jobId,
    messageId,
    jobKind: "owned_snapshot",
    accountId,
    gameId: null,
    provider: "steam",
    steamId,
    providerMode,
    generation,
    catalogRevision: null,
    leaseToken,
    attempt,
    attemptId,
    attemptToken,
    chargedAt,
    fetchStartedAt,
    leaseExpiresAt
  };
}

function sqlRows(raw: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.some((value) => !isRecord(value))) return raw.length === 0 ? [] : null;
    return raw as Record<string, unknown>[];
  }
  // Node pg returns { rows }, while a psql wrapper commonly returns the rows
  // array directly. Supporting both keeps the harness client-agnostic.
  if (isRecord(raw) && Array.isArray(raw.rows)) return sqlRows(raw.rows);
  return isRecord(raw) ? [raw] : null;
}

function byteaValue(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value !== "string" || !/^\\x[0-9a-fA-F]{64}$/.test(value)) return null;
  return decodeHexHash(value.slice(2));
}

function decodeHexHash(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decimalIntegerText(value: unknown, positive: boolean): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  const pattern = positive ? /^[1-9][0-9]*$/ : /^(?:0|[1-9][0-9]*)$/;
  if (!pattern.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed < BigInt(positive ? 1 : 0)) return null;
  } catch {
    return null;
  }
  return value;
}

function nullableDecimalIntegerText(value: unknown, positive: boolean): string | null {
  return value === null || value === undefined ? null : decimalIntegerText(value, positive);
}

function positiveDecimal(value: unknown, steamId: boolean): string | null {
  const text = decimalIntegerText(value, true);
  if (text === null) return null;
  const signedBigintMax = BigInt("9223372036854775807");
  if (steamId && (text.length > 19 || BigInt(text) > signedBigintMax)) return null;
  if (!steamId && BigInt(text) > signedBigintMax) return null;
  return text;
}

function integerValue(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function nullableIntegerValue(value: unknown, minimum: number, maximum: number): number | null {
  return value === null || value === undefined ? null : integerValue(value, minimum, maximum);
}

function invalidNullable(raw: unknown, parsed: string | number | null): boolean {
  return raw !== null && raw !== undefined && parsed === null;
}

function invalidNonnullable(raw: unknown, parsed: Uint8Array | null): boolean {
  return raw !== null && raw !== undefined && parsed === null;
}

function sqlTimestampToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let parsed: number;
  if (value instanceof Date) {
    parsed = value.getTime();
  } else {
    if (typeof value !== "string"
      || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) return null;
    parsed = Date.parse(value);
  }
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const seconds = parsed / 1_000;
  if (seconds > MAX_TIMESTAMPTZ_EPOCH_SECONDS) return null;
  const date = new Date(parsed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
