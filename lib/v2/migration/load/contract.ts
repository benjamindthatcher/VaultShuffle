import { assertIdentifier, assertQualifiedRelation } from "./canonical.ts";
import { loaderFailure } from "./errors.ts";
import { targetCell, type TargetColumn, type TargetScalarKind, type TargetValue } from "./copy.ts";

/**
 * The target load contract: which relations this loader may write, which
 * columns it writes into each, and in what order.
 *
 * Nothing here is derived from a transform's output shape at run time. A
 * relation the contract does not name cannot be written at all, and a column
 * the spec does not name cannot be filled — so a transform that grows a field
 * cannot silently start writing somewhere new, and a typo cannot become a
 * table name. The spec is also what makes the COPY encoding total: every
 * column declares the PostgreSQL type it is encoded for.
 */

export type TargetRelationSpec = Readonly<{
  /** `schema.relation`, exactly as it exists in the applied migrations. */
  relation: string;
  columns: readonly TargetColumn[];
  /**
   * Relations that must be loaded before this one. Foreign keys are the usual
   * reason; the support policy row and the reco snapshot parent are others.
   */
  dependsOn?: readonly string[];
  /**
   * A `generated always as identity` column this loader writes explicitly
   * (with `overriding system value`), and whose sequence must then be advanced
   * past the highest written value so the first runtime insert does not
   * collide.
   */
  identityColumn?: string;
  /**
   * A column whose value the target generates and the loader must read back
   * rather than supply — the reco snapshot id is the only one today.
   */
  generatedColumn?: string;
}>;

export type LoadBatch = Readonly<{
  relation: string;
  /** Already-shaped rows: one record per target row, keyed by column name. */
  rows: readonly Readonly<Record<string, TargetValue>>[];
}>;

export type PreparedRelation = Readonly<{
  relation: string;
  columns: readonly string[];
  /** Scalar kinds stay attached so read-back uses type-correct SQL. */
  columnKinds: readonly TargetScalarKind[];
  /** COPY-ready cells, in column order, with nulls as `null`. */
  rows: readonly (readonly (string | null)[])[];
  identityColumn: string | null;
}>;

export type LoadPlan = Readonly<{
  /** Dependency-ordered, and every relation appears at most once. */
  relations: readonly PreparedRelation[];
  totalRows: number;
}>;

/**
 * Order relations so every dependency is loaded first.
 *
 * A cycle or an unknown dependency is a contract defect, not something to work
 * around at run time: both refuse rather than picking an order that might
 * violate a foreign key.
 */
function orderRelations(specs: readonly TargetRelationSpec[]): readonly TargetRelationSpec[] {
  const byName = new Map<string, TargetRelationSpec>();
  for (const spec of specs) {
    assertQualifiedRelation(spec.relation);
    if (byName.has(spec.relation)) throw loaderFailure("loader_contract_invalid", { field: "duplicate_relation" });
    byName.set(spec.relation, spec);
  }
  const ordered: TargetRelationSpec[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    const current = state.get(name);
    if (current === "done") return;
    if (current === "visiting") throw loaderFailure("loader_contract_invalid", { field: "dependency_cycle" });
    const spec = byName.get(name);
    if (spec === undefined) throw loaderFailure("loader_contract_invalid", { field: "unknown_dependency" });
    state.set(name, "visiting");
    for (const dependency of spec.dependsOn ?? []) visit(dependency);
    state.set(name, "done");
    ordered.push(spec);
  };
  for (const spec of specs) visit(spec.relation);
  return ordered;
}

/**
 * Turn shaped records into COPY cells against the contract.
 *
 * Every value passes through `targetCell`, so an unrepresentable value is a
 * refusal here rather than a malformed COPY stream the server has to reject
 * halfway through a transaction. A record carrying a column the spec does not
 * declare is also a refusal: silently ignoring it would let a real fact
 * disappear between the transform and the target.
 */
export function prepareLoadPlan(
  specs: readonly TargetRelationSpec[],
  batches: readonly LoadBatch[],
): LoadPlan {
  const ordered = orderRelations(specs);
  const rowsByRelation = new Map<string, readonly Readonly<Record<string, TargetValue>>[]>();
  for (const batch of batches) {
    if (rowsByRelation.has(batch.relation)) {
      throw loaderFailure("loader_contract_invalid", { field: "duplicate_batch" });
    }
    if (!ordered.some((spec) => spec.relation === batch.relation)) {
      throw loaderFailure("loader_target_coverage", { relation: batch.relation });
    }
    rowsByRelation.set(batch.relation, batch.rows);
  }

  const prepared: PreparedRelation[] = [];
  let totalRows = 0;
  for (const spec of ordered) {
    const rows = rowsByRelation.get(spec.relation) ?? [];
    const columnNames = spec.columns.map((column) => assertIdentifier(column.name, "column"));
    const encoded: (readonly (string | null)[])[] = [];
    for (const record of rows) {
      for (const key of Object.keys(record)) {
        if (!columnNames.includes(key)) {
          throw loaderFailure("loader_target_coverage", { relation: spec.relation, field: key });
        }
      }
      encoded.push(
        Object.freeze(
          spec.columns.map((column) =>
            targetCell(column, Object.hasOwn(record, column.name) ? record[column.name] : null),
          ),
        ),
      );
    }
    totalRows += encoded.length;
    prepared.push(
      Object.freeze({
        relation: spec.relation,
        columns: Object.freeze(columnNames),
        columnKinds: Object.freeze(spec.columns.map((column) => column.kind)),
        rows: Object.freeze(encoded),
        identityColumn: spec.identityColumn ?? null,
      }),
    );
  }
  return Object.freeze({ relations: Object.freeze(prepared), totalRows });
}

/**
 * Every target relation the loader is allowed to write, with the exact column
 * list and PostgreSQL type of each.
 *
 * This is the list for the domains whose transforms are finished. A target
 * relation that is not here yet is reported by the coverage gate as
 * unimplemented rather than being quietly treated as complete.
 */
export const TARGET_RELATION_SPECS: readonly TargetRelationSpec[] = Object.freeze([
  Object.freeze({
    relation: "app.library_games",
    columns: Object.freeze([
      Object.freeze({ name: "account_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "game_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "playtime_minutes", kind: "integer", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "app.game_state",
    columns: Object.freeze([
      Object.freeze({ name: "account_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "game_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "completed_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "slept_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "previous_active_status", kind: "text", nullable: true }),
      Object.freeze({ name: "manual_progress", kind: "integer", nullable: true }),
      Object.freeze({ name: "notes", kind: "text", nullable: true }),
      Object.freeze({ name: "review_requested_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "completion_dismissed_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "completion_dismissed_playtime", kind: "integer", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "app.game_activity",
    columns: Object.freeze([
      Object.freeze({ name: "account_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "game_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "last_observed_minutes", kind: "integer", nullable: true }),
      Object.freeze({ name: "last_played_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "legacy_last_played_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "observed_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "evidence_source", kind: "text", nullable: false }),
      Object.freeze({ name: "recency_evidence_kind", kind: "text", nullable: false }),
      Object.freeze({ name: "interval_started_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "interval_ended_at", kind: "timestamptz", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "app.retired_library_games",
    columns: Object.freeze([
      Object.freeze({ name: "account_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "game_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "last_personal_minutes", kind: "integer", nullable: true }),
      Object.freeze({ name: "last_observed_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "access_lost_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "loss_reason", kind: "text", nullable: false }),
      Object.freeze({ name: "legacy_ownership", kind: "text", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "migration.library_row_map",
    columns: Object.freeze([
      Object.freeze({ name: "legacy_id", kind: "uuid", nullable: false }),
      Object.freeze({ name: "account_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "game_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "steam_appid", kind: "integer", nullable: false }),
      Object.freeze({ name: "source_snapshot_hash", kind: "bytea-hex", nullable: false }),
    ]),
  }),
  Object.freeze({
    relation: "support.retention_policy_decisions",
    columns: Object.freeze([
      Object.freeze({ name: "policy_key", kind: "text", nullable: false }),
      Object.freeze({ name: "review_milestone", kind: "text", nullable: false }),
      Object.freeze({ name: "decision_status", kind: "text", nullable: false }),
      Object.freeze({ name: "rationale", kind: "text", nullable: false }),
      Object.freeze({ name: "decided_at", kind: "timestamptz", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "support.contact_messages",
    dependsOn: Object.freeze(["support.retention_policy_decisions"]),
    columns: Object.freeze([
      Object.freeze({ name: "source_record_id", kind: "uuid", nullable: false }),
      Object.freeze({ name: "source_account_public_id", kind: "uuid", nullable: true }),
      Object.freeze({ name: "account_id", kind: "integer", nullable: true }),
      Object.freeze({ name: "enquiry_type", kind: "integer", nullable: false }),
      Object.freeze({ name: "email", kind: "text", nullable: false }),
      Object.freeze({ name: "subject", kind: "text", nullable: false }),
      Object.freeze({ name: "message", kind: "text", nullable: false }),
      Object.freeze({ name: "dedupe_hash", kind: "text", nullable: true }),
      Object.freeze({ name: "status_code", kind: "integer", nullable: false }),
      Object.freeze({ name: "created_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "updated_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "retention_policy_key", kind: "text", nullable: false }),
      Object.freeze({ name: "source_snapshot_hash", kind: "bytea-hex", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "support.feedback_submissions",
    dependsOn: Object.freeze(["support.retention_policy_decisions"]),
    columns: Object.freeze([
      Object.freeze({ name: "source_record_id", kind: "uuid", nullable: false }),
      Object.freeze({ name: "source_account_public_id", kind: "uuid", nullable: true }),
      Object.freeze({ name: "account_id", kind: "integer", nullable: true }),
      Object.freeze({ name: "feedback_type", kind: "integer", nullable: false }),
      Object.freeze({ name: "message", kind: "text", nullable: false }),
      Object.freeze({ name: "contact_allowed", kind: "boolean", nullable: false }),
      Object.freeze({ name: "contact_email", kind: "text", nullable: true }),
      Object.freeze({ name: "route", kind: "text", nullable: true }),
      Object.freeze({ name: "app_area", kind: "text", nullable: true }),
      Object.freeze({ name: "client_context", kind: "jsonb", nullable: false }),
      Object.freeze({ name: "dedupe_hash", kind: "text", nullable: true }),
      Object.freeze({ name: "status_code", kind: "integer", nullable: false }),
      Object.freeze({ name: "created_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "updated_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "retention_policy_key", kind: "text", nullable: false }),
      Object.freeze({ name: "source_snapshot_hash", kind: "bytea-hex", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "ops.legacy_worker_runs",
    columns: Object.freeze([
      Object.freeze({ name: "legacy_id", kind: "uuid", nullable: false }),
      Object.freeze({ name: "worker_name", kind: "text", nullable: false }),
      Object.freeze({ name: "status", kind: "text", nullable: false }),
      Object.freeze({ name: "run_class", kind: "text", nullable: false }),
      Object.freeze({ name: "started_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "finished_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "duration_ms", kind: "integer", nullable: true }),
      Object.freeze({ name: "counts", kind: "jsonb", nullable: false }),
      Object.freeze({ name: "summary", kind: "jsonb", nullable: false }),
      Object.freeze({ name: "error_message", kind: "text", nullable: true }),
      Object.freeze({ name: "retention_until", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "source_snapshot_hash", kind: "bytea-hex", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "migration.legacy_import_freeze_report",
    columns: Object.freeze([
      Object.freeze({ name: "account_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "source_user_id", kind: "uuid", nullable: false }),
      Object.freeze({ name: "status", kind: "text", nullable: false }),
      Object.freeze({ name: "total_games", kind: "integer", nullable: false }),
      Object.freeze({ name: "imported_games", kind: "integer", nullable: false }),
      Object.freeze({ name: "play_history_missing", kind: "boolean", nullable: false }),
      Object.freeze({ name: "last_error", kind: "text", nullable: true }),
      Object.freeze({ name: "started_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "updated_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "completed_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "source_snapshot_hash", kind: "bytea-hex", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "catalog.provider_state",
    columns: Object.freeze([
      Object.freeze({ name: "game_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "provider", kind: "text", nullable: false }),
      Object.freeze({ name: "evidence_kind", kind: "text", nullable: false }),
      Object.freeze({ name: "status", kind: "text", nullable: false }),
      Object.freeze({ name: "failure_count", kind: "integer", nullable: false }),
      Object.freeze({ name: "next_attempt_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "processing_started_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "fetched_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "last_error_code", kind: "text", nullable: true }),
      Object.freeze({ name: "last_error", kind: "text", nullable: true }),
      Object.freeze({ name: "source_snapshot_hash", kind: "bytea-hex", nullable: true }),
      Object.freeze({ name: "updated_at", kind: "timestamptz", nullable: false }),
    ]),
  }),
  Object.freeze({
    relation: "catalog.appid_terminal_rejections",
    columns: Object.freeze([
      Object.freeze({ name: "steam_app_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "evidence_kind", kind: "text", nullable: false }),
      Object.freeze({ name: "provider", kind: "text", nullable: false }),
      Object.freeze({ name: "terminal_status", kind: "text", nullable: false }),
      Object.freeze({ name: "reason", kind: "text", nullable: false }),
      Object.freeze({ name: "attempts", kind: "integer", nullable: false }),
      Object.freeze({ name: "last_error_code", kind: "text", nullable: true }),
      Object.freeze({ name: "first_requested_at", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "last_attempt_at", kind: "timestamptz", nullable: false }),
      Object.freeze({ name: "source_relation", kind: "text", nullable: false }),
      Object.freeze({ name: "retry_allowed_after", kind: "timestamptz", nullable: true }),
      Object.freeze({ name: "source_snapshot_hash", kind: "bytea-hex", nullable: true }),
    ]),
  }),
]);
