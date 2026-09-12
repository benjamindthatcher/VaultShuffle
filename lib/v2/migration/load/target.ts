import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { assertIdentifier, assertSha256, assertUuid, canonicalSha256, quoteIdentifier, quoteRelation } from "./canonical.ts";
import { encodeCopyRow } from "./copy.ts";
import { loaderFailure } from "./errors.ts";
import type { LoadPlan, PreparedRelation } from "./contract.ts";

/**
 * The only way this loader reaches a database.
 *
 * Every field is explicit. There is no URL, no connection string, no
 * environment fallback, no profile lookup, no project reference and no
 * credential handling anywhere in this module: a caller that cannot name a
 * local Unix socket directory cannot run a load at all. That is what keeps a
 * synthetic rehearsal from becoming a remote apply by accident.
 */
export type LocalTargetDescriptor = Readonly<{
  /** An absolute path to a Unix socket DIRECTORY, never a host name. */
  socketDirectory: string;
  port: number;
  user: string;
  database: string;
  /** Absolute path to the psql binary the caller has already vetted. */
  psqlPath: string;
  /** Hard bound on one statement's stdin, so a plan cannot exhaust memory. */
  maxStatementBytes?: number;
}>;

const DEFAULT_MAX_STATEMENT_BYTES = 64 * 1024 * 1024;
// A local socket directory is an absolute path. What it must NOT contain is
// anything that turns it into a host, a URL or a second argument: a colon
// (host:port), an at sign (user@host), a backslash, or surrounding whitespace.
const HOSTLIKE = /[:@\\]|^\s|\s$/;

/**
 * Refuse anything that is not an explicit local socket.
 *
 * A socket directory containing `:` or `@`, or a relative path, is how a
 * "local" descriptor turns into a TCP host or a URL. Both are refused with
 * `loader_remote_refused` rather than normalised into something that might
 * connect somewhere real.
 */
export function assertLocalTarget(descriptor: LocalTargetDescriptor): LocalTargetDescriptor {
  if (typeof descriptor !== "object" || descriptor === null) {
    throw loaderFailure("loader_contract_invalid", { field: "target" });
  }
  const { socketDirectory, port, user, database, psqlPath } = descriptor;
  if (typeof socketDirectory !== "string" || !isAbsolute(socketDirectory) || HOSTLIKE.test(socketDirectory)) {
    throw loaderFailure("loader_remote_refused", { field: "socket_directory" });
  }
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw loaderFailure("loader_remote_refused", { field: "port" });
  }
  assertIdentifier(user, "user");
  assertIdentifier(database, "database");
  if (typeof psqlPath !== "string" || psqlPath.length === 0 || HOSTLIKE.test(psqlPath)) {
    throw loaderFailure("loader_contract_invalid", { field: "psql_path" });
  }
  return descriptor;
}

export type SqlOutcome = Readonly<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * The SQLSTATE from a refusal, and nothing else.
 *
 * A diagnostic may carry the server's five-character code, which names the
 * KIND of refusal (23505 unique, 23503 foreign key, 23514 check). It must not
 * carry the message, which quotes the offending value.
 */
function sqlState(stderr: string): string {
  const match = /SQLSTATE:\s*([0-9A-Z]{5})/.exec(stderr);
  return match === null ? "unknown" : match[1];
}

function execute(descriptor: LocalTargetDescriptor, sql: string): SqlOutcome {
  const limit = descriptor.maxStatementBytes ?? DEFAULT_MAX_STATEMENT_BYTES;
  if (Buffer.byteLength(sql, "utf8") > limit) throw loaderFailure("loader_stage_limit", { field: "statement_bytes" });
  const result = spawnSync(
    descriptor.psqlPath,
    [
      "-h",
      descriptor.socketDirectory,
      "-p",
      String(descriptor.port),
      "-U",
      descriptor.user,
      "-d",
      descriptor.database,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
      "-q",
      "-A",
      "-t",
      "-f",
      "-",
    ],
    {
      input: sql,
      encoding: "utf8",
      // No inherited PG* variables: the descriptor is the only source of
      // connection facts, so a stray PGHOST cannot redirect the load.
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
        PGOPTIONS: "-c client_min_messages=warning",
        PGCONNECT_TIMEOUT: "5",
      },
    },
  );
  if (result.error !== undefined) throw loaderFailure("loader_target_failed", { field: "spawn" });
  return Object.freeze({
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  });
}

/** Run a read-only query and return its single-column rows. */
export function queryRows(descriptor: LocalTargetDescriptor, sql: string): readonly string[] {
  const outcome = execute(assertLocalTarget(descriptor), sql);
  if (!outcome.ok) throw loaderFailure("loader_target_failed", { field: "query", sqlstate: sqlState(outcome.stderr) });
  return outcome.stdout.length === 0 ? [] : outcome.stdout.split("\n");
}

export function queryValue(descriptor: LocalTargetDescriptor, sql: string): string {
  const rows = queryRows(descriptor, sql);
  if (rows.length !== 1) throw loaderFailure("loader_target_failed", { field: "query_shape" });
  return rows[0];
}

function copyStatement(relation: PreparedRelation): string {
  const columns = relation.columns.map(quoteIdentifier).join(", ");
  const body = relation.rows.map((row) => encodeCopyRow(row)).join("");
  // PostgreSQL COPY accepts explicit identity values; OVERRIDING SYSTEM VALUE
  // is INSERT syntax and is intentionally used only for the target insert.
  return `copy ${quoteRelation(relation.relation)} (${columns}) from stdin;\n${body}\\.\n`;
}

/**
 * Advance an identity sequence past the highest value this load wrote.
 *
 * Writing a generated identity explicitly leaves the sequence untouched, so
 * the first runtime insert would collide with a migrated row. `setval` with
 * `is_called = true` from the table's own max is the deterministic repair, and
 * it is part of the same transaction as the rows it repairs.
 */
function sequenceStatement(relation: PreparedRelation): string {
  if (relation.identityColumn === null) return "";
  const column = quoteIdentifier(relation.identityColumn);
  const table = quoteRelation(relation.relation);
  return `select setval(pg_get_serial_sequence('${relation.relation}', '${assertIdentifier(
    relation.identityColumn,
  )}'), coalesce((select max(${column}) from ${table}), 1), (select count(*) > 0 from ${table}));\n`;
}

/**
 * One `migration.applied_steps` row, in the applied schema's own shape:
 * `(run_id, phase)` is the primary key, `status` is one of its four literals,
 * and both instants are supplied by the caller rather than read from a clock
 * here, so a replay is reproducible and a test is deterministic.
 */
export type AppliedStep = Readonly<{
  runId: string;
  phase: string;
  relation: string;
  rows: number;
  checksum: string;
  startedAt: string;
  finishedAt: string;
}>;

export type SourceRelationAccounting = Readonly<{
  relation: string;
  sourceRows: number;
  loadedRows: number;
  archivedRows: number;
  conflictRows: number;
}>;

export type RunLoadMetadata = Readonly<{
  runId: string;
  snapshotKey: string;
  snapshotHash: string;
  startedAt: string;
  finishedAt: string;
  schemaFingerprint: string;
  manifestFingerprint: string;
  transformFingerprint: string;
  stagingFingerprint: string;
}>;

/**
 * Apply the whole plan in ONE transaction, with replay and run guards.
 *
 * Three properties matter and are enforced by the SQL this builds, not by
 * convention:
 *
 * 1. **All or nothing.** Every relation, every sequence repair and every
 *    bookkeeping row is in one transaction. A failure anywhere rolls back the
 *    whole load, so a partial target is not a reachable state.
 * 2. **A replay cannot change history.** `migration.applied_steps` is written
 *    with `on conflict do nothing` and then read back: if a step already
 *    exists with a different checksum, the transaction aborts with
 *    `loader_replay_mismatch` rather than overwriting it.
 * 3. **A run cannot be mixed.** Every step carries the run id, and the guard
 *    below refuses to write into a target whose recorded run identity is a
 *    different one.
 */
export function applyLoadPlan(
  descriptor: LocalTargetDescriptor,
  plan: LoadPlan,
  run: RunLoadMetadata,
  steps: readonly AppliedStep[],
  sourceAccounting: readonly SourceRelationAccounting[],
): Readonly<{ rowsWritten: number }> {
  assertLocalTarget(descriptor);
  assertUuid(run.runId, "run_id");
  assertSha256(run.snapshotHash, "snapshot_hash");
  assertSha256(run.schemaFingerprint, "schema_fingerprint");
  assertSha256(run.manifestFingerprint, "manifest_fingerprint");
  assertSha256(run.transformFingerprint, "transform_fingerprint");
  assertSha256(run.stagingFingerprint, "staging_fingerprint");
  const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const metadata = canonicalSha256({
    snapshotKey: run.snapshotKey,
    snapshotHash: run.snapshotHash,
    startedAt: run.startedAt,
    schemaFingerprint: run.schemaFingerprint,
    manifestFingerprint: run.manifestFingerprint,
    transformFingerprint: run.transformFingerprint,
    stagingFingerprint: run.stagingFingerprint,
  });
  const statements: string[] = [
    "begin;",
    "set local timezone = 'UTC';",
    `select pg_advisory_xact_lock(hashtextextended(${literal(run.runId)}, 0));`,
    ...plan.relations.map((relation) => `lock table ${quoteRelation(relation.relation)} in share row exclusive mode;`),
    `do $$
     declare v_run migration.runs%rowtype; v_meta text;
     begin
       select * into v_run from migration.runs where run_id = ${literal(run.runId)}::uuid for update;
       if found then
         if v_run.snapshot_key <> ${literal(run.snapshotKey)}
            or encode(v_run.source_snapshot_hash, 'hex') <> ${literal(run.snapshotHash)}
            or v_run.started_at <> ${literal(run.startedAt)}::timestamptz
            or v_run.status <> 'succeeded' then
           raise exception 'loader_run_mismatch';
         end if;
         select details->>'metadata_checksum' into v_meta
           from migration.applied_steps
          where run_id = ${literal(run.runId)}::uuid and phase = 'loader:metadata';
         if v_meta is distinct from ${literal(metadata)} then
           raise exception 'loader_run_mismatch';
         end if;
       else
         insert into migration.runs
           (run_id, snapshot_key, source_snapshot_hash, started_at, status, current_phase)
         values (${literal(run.runId)}::uuid, ${literal(run.snapshotKey)}, decode(${literal(run.snapshotHash)}, 'hex'),
           ${literal(run.startedAt)}::timestamptz, 'running', 'load');
         insert into migration.applied_steps
           (run_id, phase, status, started_at, finished_at, source_snapshot_hash, details)
         values (${literal(run.runId)}::uuid, 'loader:metadata', 'complete',
           ${literal(run.startedAt)}::timestamptz, ${literal(run.finishedAt)}::timestamptz,
           decode(${literal(run.snapshotHash)}, 'hex'),
           jsonb_build_object('metadata_checksum', ${literal(metadata)},
             'schema_fingerprint', ${literal(run.schemaFingerprint)},
             'manifest_fingerprint', ${literal(run.manifestFingerprint)},
             'transform_fingerprint', ${literal(run.transformFingerprint)},
             'staging_fingerprint', ${literal(run.stagingFingerprint)}));
       end if;
     end $$;`,
  ];

  // COPY first enters transaction-local typed tables. Target rows are written
  // only after replay metadata and every step checksum have been checked.
  for (const [index, relation] of plan.relations.entries()) {
    const temp = `loader_stage_${index}`;
    statements.push(`create temp table ${quoteIdentifier(temp)} (like ${quoteRelation(relation.relation)} including all) on commit drop;`);
    if (relation.rows.length > 0) {
      statements.push(copyStatement({ ...relation, relation: `pg_temp.${temp}` }));
    }
  }
  for (const step of steps) {
    statements.push(
      `do $$
       declare
         v_details jsonb;
       begin
         select details into v_details from migration.applied_steps
          where run_id = ${literal(step.runId)}::uuid and phase = ${literal(step.phase)};
         if v_details is not null and
            (v_details->>'checksum' <> ${literal(assertSha256(step.checksum, "step_checksum"))}
             or v_details->>'relation' <> ${literal(step.relation)}
             or (v_details->>'rows')::bigint <> ${step.rows}) then
           raise exception 'loader_replay_mismatch';
         end if;
       end $$;`,
    );
  }

  for (const [index, relation] of plan.relations.entries()) {
    if (relation.rows.length === 0) continue;
    const columns = relation.columns.map(quoteIdentifier).join(", ");
    const override = relation.identityColumn === null ? "" : " overriding system value";
    statements.push(
      `insert into ${quoteRelation(relation.relation)} (${columns})${override}
       select ${columns} from ${quoteIdentifier(`loader_stage_${index}`)}
       where not exists (select 1 from migration.runs where run_id = ${literal(run.runId)}::uuid and status = 'succeeded');`,
    );
  }
  for (const relation of plan.relations) {
    if (relation.identityColumn === null || relation.rows.length === 0) continue;
    statements.push(sequenceStatement(relation));
  }

  // The exact typed target multiset must equal the typed staging multiset.
  // EXCEPT ALL catches duplicate, missing, extra and swapped rows without
  // rendering private values into process output.
  for (const [index, relation] of plan.relations.entries()) {
    const columns = relation.columns.map(quoteIdentifier).join(", ");
    statements.push(
      `do $$ begin
         if exists (
           (select ${columns} from ${quoteRelation(relation.relation)}
              except all select ${columns} from ${quoteIdentifier(`loader_stage_${index}`)})
           union all
           (select ${columns} from ${quoteIdentifier(`loader_stage_${index}`)}
              except all select ${columns} from ${quoteRelation(relation.relation)})
         ) then raise exception 'loader_reconciliation_failed'; end if;
       end $$;`,
    );
  }

  for (const step of steps) {
    statements.push(
      `insert into migration.applied_steps
         (run_id, phase, status, started_at, finished_at, source_snapshot_hash, details)
       values (${literal(step.runId)}::uuid, ${literal(step.phase)}, 'complete',
         ${literal(step.startedAt)}::timestamptz, ${literal(step.finishedAt)}::timestamptz,
         decode(${literal(run.snapshotHash)}, 'hex'),
         jsonb_build_object('relation', ${literal(step.relation)}, 'rows', ${step.rows},
           'checksum', ${literal(step.checksum)}))
       on conflict (run_id, phase) do nothing;`,
    );
  }
  for (const accounting of sourceAccounting) {
    statements.push(
      `insert into migration.relation_counts
         (run_id, relation_name, source_rows, loaded_rows, archived_rows, conflict_rows, source_snapshot_hash)
       values (${literal(run.runId)}::uuid, ${literal(accounting.relation)}, ${accounting.sourceRows},
         ${accounting.loadedRows}, ${accounting.archivedRows}, ${accounting.conflictRows}, decode(${literal(run.snapshotHash)}, 'hex'))
       on conflict (run_id, relation_name) do nothing;`,
      `do $$ declare v migration.relation_counts%rowtype; begin
         select * into strict v from migration.relation_counts
          where run_id = ${literal(run.runId)}::uuid and relation_name = ${literal(accounting.relation)};
         if v.source_rows <> ${accounting.sourceRows} or v.loaded_rows <> ${accounting.loadedRows}
            or v.archived_rows <> ${accounting.archivedRows} or v.conflict_rows <> ${accounting.conflictRows}
            or encode(v.source_snapshot_hash, 'hex') <> ${literal(run.snapshotHash)} then
           raise exception 'loader_replay_mismatch';
         end if;
       end $$;`,
    );
  }
  statements.push(
    `update migration.runs
        set status = 'succeeded', finished_at = ${literal(run.finishedAt)}::timestamptz, current_phase = 'publish'
      where run_id = ${literal(run.runId)}::uuid and status = 'running';`,
  );
  statements.push("commit;");
  const outcome = execute(descriptor, statements.join("\n"));
  if (!outcome.ok) {
    if (outcome.stderr.includes("loader_replay_mismatch")) {
      throw loaderFailure("loader_replay_mismatch", { field: "applied_steps" });
    }
    if (outcome.stderr.includes("loader_run_mismatch")) {
      throw loaderFailure("loader_run_mismatch", { field: "run_metadata" });
    }
    if (outcome.stderr.includes("loader_reconciliation_failed")) {
      throw loaderFailure("loader_reconciliation_failed", { field: "transaction" });
    }
    throw loaderFailure("loader_target_failed", { field: "transaction", sqlstate: sqlState(outcome.stderr) });
  }
  return Object.freeze({ rowsWritten: plan.totalRows });
}

/**
 * Refuse a target whose applied schema is not the one the plan was built for.
 *
 * The fingerprint is computed from the target's own catalogue — every relation
 * and column the loader may write — so a column added, dropped or retyped
 * since the plan was prepared is a mismatch rather than a surprise at COPY
 * time. It is the loader's half of the immutable-migration contract.
 */
export function readSchemaFingerprint(
  descriptor: LocalTargetDescriptor,
  relations: readonly string[],
): string {
  const names = relations.map((relation) => `'${assertQualified(relation)}'`).join(", ");
  const rows = queryRows(
    descriptor,
    `select format('%s.%s|%s|%s|%s', table_schema, table_name, column_name, data_type, is_nullable)
       from information_schema.columns
      where table_schema || '.' || table_name in (${names})
      order by table_schema, table_name, column_name;`,
  );
  return rows.join("\n");
}

function assertQualified(relation: string): string {
  const [schema, name] = relation.split(".");
  assertIdentifier(schema ?? "", "schema");
  assertIdentifier(name ?? "", "relation");
  return relation;
}
