import { Buffer } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { ExportError } from "../shared/redaction.ts";
import { quoteIdentifier, quoteLiteral, type CopySink, type WireConnection } from "./wire.ts";

/**
 * The snapshot half of the exporter.
 *
 * One transaction, opened `REPEATABLE READ READ ONLY`, is the only thing that
 * makes the output a snapshot. Everything else here exists to prove that claim
 * afterwards rather than assert it: the watermark is recorded from inside the
 * transaction, the isolation level and read-only flag are read back from the
 * server rather than assumed from the BEGIN we sent, and the watermark is taken
 * a second time after the last relation and required to be identical.
 */

/** Formatting settings pinned for the session, and verified after being set. */
export const REQUIRED_SESSION_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  // Instants render as UTC. Not the server default, not the operator's locale.
  ["TimeZone", "UTC"],
  // `2026-09-03` is unambiguous; `03/09/2026` is a bug waiting for a US parser.
  ["DateStyle", "ISO, YMD"],
  ["IntervalStyle", "iso_8601"],
  // float4/float8 round-trip exactly. numeric is unaffected: it is already exact.
  ["extra_float_digits", "3"],
  ["bytea_output", "hex"],
  ["client_encoding", "UTF8"],
  // A synchronised sequential scan starts at whatever block another backend
  // happens to be reading, so two reads of one relation in one snapshot can
  // differ in row order and therefore in digest. Off, the scan starts at block 0.
  ["synchronize_seqscans", "off"],
];

/**
 * Settings pinned for the export *transaction only*, and verified after being set.
 *
 * `row_security = off` is not a formatting choice and is deliberately not in the
 * list above. It is the difference between an incomplete export and a failed
 * one.
 *
 * With the default `row_security = on`, a `SELECT` or `COPY` run by a role that
 * is not the relation's owner and does not hold `BYPASSRLS` returns *only the
 * rows the relation's policies admit*. There is no warning, no notice, no
 * distinguishing marker on the wire: a policy-filtered subset and a genuinely
 * small relation are byte-for-byte the same COPY stream. Every other check in
 * this file would still pass - the row count on the wire would match the
 * server's `COPY n` tag, the digest would be internally consistent, the
 * snapshot would be stable - and the run would publish a manifest asserting a
 * complete point-in-time copy of something it had only seen part of.
 *
 * Setting it to `off` does *not* bypass row-level security; a role with no
 * bypass privilege cannot grant itself one. It changes what PostgreSQL does
 * when a policy *would* be applied: instead of quietly filtering, the planner
 * raises `42501 query would be affected by row-level security policy for table
 * "..."` and the whole transaction aborts. This is exactly why `pg_dump` sets
 * it, and why it is the only setting here that must not be allowed to persist
 * past the transaction - a session left in this state would make ordinary
 * application queries fail in a way that has nothing to do with the export.
 *
 * Checking `pg_class.relrowsecurity` instead is not equivalent and is not
 * enough. That flag says a relation *has* RLS, not that this role's reads are
 * being filtered, and a flag comparison is a claim the export makes about
 * itself. `row_security = off` makes the server refuse to answer at all.
 *
 * @see https://www.postgresql.org/docs/17/ddl-rowsecurity.html
 * @see https://www.postgresql.org/docs/17/app-pgdump.html
 */
export const REQUIRED_TRANSACTION_LOCAL_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ["row_security", "off"],
];

/**
 * Rendering settings used only while comparing the live catalog with the
 * frozen source inventory.
 *
 * `pg_get_constraintdef` delegates interval constants to PostgreSQL's interval
 * output function. The same parsed CHECK therefore renders `00:15:00` under
 * the inventory's `postgres` style and `PT15M` under the export stream's
 * `iso_8601` style. Pinning the catalog query to the inventory representation
 * keeps an exact text comparison without weakening the drift guard.
 */
export const REQUIRED_SCHEMA_CONTRACT_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ["IntervalStyle", "postgres"],
];

export type PlannedColumn = {
  ordinal: number;
  name: string;
  type: string;
  /** Required on a complete inventory contract; omitted by fixture-only plans. */
  nullable?: boolean;
};

export type ExpectedConstraint = {
  name: string;
  type: string;
  definition: string;
};

export type PlannedRelation = {
  schema: string;
  name: string;
  /** `r` base table, `v` view, `m` materialized view, `p` partitioned table. */
  kind: string;
  columns: readonly PlannedColumn[];
};

/** Full catalog shape captured by a real source inventory. */
export type ExpectedRelation = {
  schema: string;
  name: string;
  kind: string;
  rls: boolean;
  columns: readonly (PlannedColumn & { nullable: boolean })[];
  constraints: readonly ExpectedConstraint[];
};

export type ExportSchemaContract = {
  /** The contract covers every inventoried relation, even when `include` narrows output. */
  schema: string;
  relations: readonly ExpectedRelation[];
};

export type ExportPlan = {
  /** Fixed order. The manifest and the load side both depend on it. */
  relations: readonly PlannedRelation[];
  /** Present for real inventory plans; absent for deliberately partial fixtures. */
  schemaContract?: ExportSchemaContract;
};

export type SnapshotWatermark = {
  /** `pg_snapshot_xmin(pg_current_snapshot())` - the snapshot's lower bound. */
  snapshotXmin: string;
  /** The full `xmin:xmax:xip_list` text, which pins the visible set exactly. */
  currentSnapshot: string;
  /** WAL position, or null where the role may not read it. */
  walLsn: string | null;
  /** `statement_timestamp()` of the watermark statement, explicit UTC. */
  statementStartUtc: string;
  /** `transaction_timestamp()`, explicit UTC. */
  transactionStartUtc: string;
  backendPid: string;
};

/** A view body captured inside the same snapshot as the exported rows. */
export type SnapshotViewDefinition = {
  schema: string;
  name: string;
  definition: string;
  sha256: string;
};

/**
 * What the run can actually prove about seeing every row.
 *
 * Recorded in the manifest so a reader can tell *why* the export was complete
 * rather than taking "complete" on trust. There are two independent reasons a
 * read is not policy-filtered, and they are not interchangeable:
 *
 * - `setting`/`settingAtClose` are `off`, so any relation whose policies would
 *   have applied to this role raised an error instead of returning a subset.
 *   This is the guarantee the exporter creates for itself.
 * - the role is a superuser or holds `BYPASSRLS`, in which case policies never
 *   applied and `row_security = off` had nothing to catch. The export is still
 *   complete, but it is complete because of a privilege somebody granted, not
 *   because this run verified anything. Recording it stops a later reader from
 *   pointing at a green run as evidence that the guard fired.
 */
export type RowSecurityEvidence = {
  /** `current_setting('row_security')`, read back inside the transaction before any relation. */
  setting: string;
  /** Read again after the last relation. Required to still be `off`. */
  settingAtClose: string;
  /** `pg_roles.rolsuper` for `current_user`, or null where the catalog row was unreadable. */
  roleIsSuperuser: boolean | null;
  /** `pg_roles.rolbypassrls` for `current_user`, or null where the catalog row was unreadable. */
  roleBypassesRowSecurity: boolean | null;
};

export type RelationDigest = {
  schema: string;
  name: string;
  /** Rows the server reported in the `COPY n` command tag. */
  rowsReportedByServer: number;
  /** Rows counted independently from the wire bytes. Must equal the above. */
  rowsCountedOnWire: number;
  bytes: number;
  sha256: string;
  columns: readonly string[];
  durationMs: number;
};

/**
 * Accumulates the digest, byte count and row count of a `COPY ... TO STDOUT`
 * stream without ever holding the relation.
 *
 * The row count is derived from the bytes rather than trusted from the server.
 * In `FORMAT text` a data newline is escaped as the two characters `\` `n`, so a
 * raw 0x0A byte is always a row terminator and nothing else. Counting them and
 * comparing to the server's `COPY n` tag catches a truncated stream, which is
 * the one corruption a digest alone cannot distinguish from a short relation.
 */
export class CopyWireRecorder {
  #hash: Hash = createHash("sha256");
  #bytes = 0;
  #rows = 0;

  update(chunk: Buffer): void {
    this.#hash.update(chunk);
    this.#bytes += chunk.length;
    for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, index + 1)) {
      this.#rows += 1;
    }
  }

  get bytes(): number {
    return this.#bytes;
  }

  get rows(): number {
    return this.#rows;
  }

  digest(): string {
    return this.#hash.copy().digest("hex");
  }
}

/** Where one relation's bytes go. Supplied by the run layer. */
export type RelationOutput = {
  sink: CopySink;
  /** Flush and fsync. Called before the digest is recorded. */
  finish(): Promise<void>;
  /** Close an unfinished stream while retaining its partial file for evidence. */
  abort(): Promise<void>;
};

export type SnapshotOptions = {
  plan: ExportPlan;
  openRelationOutput: (relation: PlannedRelation) => Promise<RelationOutput>;
  /** Server-side cap per statement. 0 disables it, which is not recommended. */
  statementTimeoutMs: number;
  /** Existing, fixed read-only role granted to the authenticated session. */
  activateRole?: string | null;
  /** Login identity that must remain `session_user` after role activation. */
  expectedSessionUser?: string;
  /**
   * Awaited before the next relation is streamed, so a caller can act at a
   * known point inside the open snapshot. The concurrency test writes to the
   * source here; without the await, the write would race the next COPY and the
   * test would prove nothing.
   */
  onRelationComplete?: (digest: RelationDigest) => void | Promise<void>;
  /** Test/abort seam: a synchronous throw aborts an in-flight COPY. */
  onCopyChunk?: (relation: PlannedRelation, chunk: Buffer) => void;
};

export type SnapshotResult = {
  watermark: SnapshotWatermark;
  /** Re-read after the final relation. Required to equal the opening watermark. */
  closingSnapshot: string;
  relations: readonly RelationDigest[];
  sessionSettings: Readonly<Record<string, string>>;
  rowSecurity: RowSecurityEvidence;
  walLsnAvailable: boolean;
  /** Supplementary view metadata; empty for fixture plans without a full contract. */
  viewDefinitions: readonly SnapshotViewDefinition[];
  /** Effective data-access identity after an optional transaction-local SET ROLE. */
  effectiveUser: string | null;
  sessionUser: string | null;
};

function parseCopyRowCount(commandTag: string): number {
  const match = /^COPY (\d+)$/.exec(commandTag);
  if (!match) {
    throw new ExportError(
      "copy_tag_unparseable",
      `Expected a COPY command tag, got ${JSON.stringify(commandTag)}.`,
    );
  }
  return Number.parseInt(match[1], 10);
}

/**
 * Probe optional capabilities *outside* any transaction.
 *
 * A statement that errors inside a transaction aborts it, so anything that might
 * legitimately fail - a function this role may not execute - has to be tried
 * while each statement is still its own transaction. Doing this inside the
 * snapshot would turn a missing grant into a lost snapshot.
 */
export async function probeWalLsnAvailable(connection: WireConnection): Promise<boolean> {
  try {
    await connection.query("SELECT pg_current_wal_lsn()::text");
    return true;
  } catch {
    return false;
  }
}

async function applySessionSettings(
  connection: WireConnection,
  statementTimeoutMs: number,
): Promise<Record<string, string>> {
  for (const [name, value] of REQUIRED_SESSION_SETTINGS) {
    await connection.query(`SET ${quoteIdentifier(name)} = ${quoteLiteral(value)}`);
  }
  await connection.query(`SET statement_timeout = ${quoteLiteral(String(Math.trunc(statementTimeoutMs)))}`);

  // Read the settings back. `SET` succeeding is not proof the session holds the
  // value: a superuser-only setting, a mis-cased enum or a server that maps the
  // name elsewhere all fail quietly enough to produce localised timestamps.
  const names = REQUIRED_SESSION_SETTINGS.map(([name]) => name);
  const result = await connection.query(
    `SELECT ${names.map((name) => `current_setting(${quoteLiteral(name)})`).join(", ")}`,
  );
  const observed: Record<string, string> = {};
  names.forEach((name, index) => {
    observed[name] = result.rows[0]?.[index] ?? "";
  });
  for (const [name, expected] of REQUIRED_SESSION_SETTINGS) {
    if (observed[name] !== expected) {
      throw new ExportError(
        "session_setting_rejected",
        `The server reports ${name} as ${JSON.stringify(observed[name])} after it was set to ${JSON.stringify(expected)}. Refusing to export with unknown output formatting.`,
        { setting: name, expected, actual: observed[name] },
      );
    }
  }
  return observed;
}

async function applySchemaContractSettings(connection: WireConnection): Promise<void> {
  for (const [name, value] of REQUIRED_SCHEMA_CONTRACT_SETTINGS) {
    await connection.query(`SET LOCAL ${quoteIdentifier(name)} = ${quoteLiteral(value)}`);
    const result = await connection.query(`SELECT current_setting(${quoteLiteral(name)})`);
    const observed = result.rows[0]?.[0] ?? "";
    if (observed !== value) {
      throw new ExportError(
        "schema_setting_rejected",
        `The server reports ${name} as ${JSON.stringify(observed)} after it was set to ${JSON.stringify(value)}. Refusing to compare constraint text under an unknown representation.`,
        { setting: name, expected: value, actual: observed },
      );
    }
  }
}

/** `current_setting('row_security')`, read from the server rather than assumed. */
async function readRowSecuritySetting(connection: WireConnection): Promise<string> {
  const result = await connection.query("SELECT current_setting('row_security')");
  return result.rows[0]?.[0] ?? "";
}

function parseOptionalCatalogBoolean(value: string | null | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

type ActivatedRoleEvidence = {
  currentUser: string;
  sessionUser: string;
};

/**
 * Activate Supabase's role already granted to a generated read-only login.
 *
 * The Management API deliberately grants this membership with INHERIT disabled,
 * so authenticating as the temporary login is not enough. PostgreSQL itself
 * proves membership before `SET LOCAL ROLE`; the following read-back proves the
 * effective and session identities, BYPASSRLS, non-superuser status and the
 * enclosing read-only transaction.
 */
async function activateReadOnlyRole(
  connection: WireConnection,
  role: string,
  expectedSessionUser: string,
): Promise<ActivatedRoleEvidence> {
  const before = await connection.query(
    `SELECT current_user, session_user, pg_has_role(session_user, ${quoteLiteral(role)}, 'MEMBER')::text`,
  );
  const beforeRow = before.rows[0] ?? [];
  if (
    beforeRow[0] !== expectedSessionUser ||
    beforeRow[1] !== expectedSessionUser ||
    beforeRow[2] !== "true"
  ) {
    throw new ExportError(
      "source_role_membership_missing",
      "The authenticated source login does not hold the expected read-only role membership; refusing to export.",
    );
  }

  await connection.query(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
  const after = await connection.query(
    "SELECT current_user, session_user, r.rolsuper::text, r.rolbypassrls::text, " +
      "current_setting('transaction_read_only') " +
      "FROM pg_catalog.pg_roles r WHERE r.rolname=current_user",
  );
  const row = after.rows[0] ?? [];
  if (
    row[0] !== role ||
    row[1] !== expectedSessionUser ||
    row[2] !== "false" ||
    row[3] !== "true" ||
    row[4] !== "on"
  ) {
    throw new ExportError(
      "source_role_activation_invalid",
      "The activated source role did not prove the required read-only, non-superuser, BYPASSRLS identity; refusing to export.",
    );
  }
  return { currentUser: row[0], sessionUser: row[1] };
}

async function assertActivatedRoleScope(
  connection: WireConnection,
  contract: ExportSchemaContract,
): Promise<void> {
  const result = await connection.query(
    "SELECT c.relname, has_table_privilege(current_user, c.oid, 'SELECT')::text, " +
      "has_table_privilege(current_user, c.oid, 'INSERT')::text, " +
      "has_table_privilege(current_user, c.oid, 'UPDATE')::text, " +
      "has_table_privilege(current_user, c.oid, 'DELETE')::text, " +
      "has_table_privilege(current_user, c.oid, 'TRUNCATE')::text, " +
      "has_table_privilege(current_user, c.oid, 'REFERENCES')::text, " +
      "has_table_privilege(current_user, c.oid, 'TRIGGER')::text " +
      "FROM pg_catalog.pg_class c " +
      "JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace " +
      `WHERE n.nspname=${quoteLiteral(contract.schema)} AND c.relkind IN ('r','v','m','p') ` +
      "ORDER BY c.relname",
  );
  if (result.rows.length !== contract.relations.length) {
    throw new ExportError(
      "source_role_scope_invalid",
      "The activated source role privilege scope does not cover the complete inventoried relation set.",
    );
  }
  for (const row of result.rows) {
    const canSelect = row[1] === "true";
    const canWrite = row.slice(2).some((value) => value === "true");
    if (!canSelect || canWrite) {
      throw new ExportError(
        "source_role_scope_invalid",
        "The activated source role lacks SELECT or holds a table write privilege in the inventoried schema; refusing to export.",
        { relation: `${contract.schema}.${row[0] ?? "unknown"}` },
      );
    }
  }

  const createPrivileges = await connection.query(
    `SELECT has_schema_privilege(current_user, ${quoteLiteral(contract.schema)}, 'CREATE')::text, ` +
      "has_database_privilege(current_user, current_database(), 'CREATE')::text",
  );
  if (createPrivileges.rows[0]?.some((value) => value === "true")) {
    throw new ExportError(
      "source_role_scope_invalid",
      "The activated source role can create source schema or database objects; refusing to use it as the read-only export identity.",
    );
  }
}

/**
 * Make a policy-filtered read impossible before the first relation is opened.
 *
 * Ordering is the whole point: this runs immediately after any transaction-local
 * activation of the already granted read-only role, ahead of the watermark,
 * schema contract and every COPY. A guard applied after a read has already
 * happened proves nothing about that read.
 *
 * `SET LOCAL` rather than `SET`, so the connection cannot be handed back to
 * anything else still carrying a setting that turns a normal filtered query
 * into an error. The value is read back for the same reason the formatting
 * settings are: `SET` returning without an error is not evidence the session
 * holds the value. `SET LOCAL` outside a transaction block, in particular, is a
 * warning and a no-op - and the read-back is what turns that into a refusal
 * instead of a silently unguarded export.
 */
async function assertCompleteRowVisibility(
  connection: WireConnection,
): Promise<Omit<RowSecurityEvidence, "settingAtClose">> {
  for (const [name, value] of REQUIRED_TRANSACTION_LOCAL_SETTINGS) {
    await connection.query(`SET LOCAL ${quoteIdentifier(name)} = ${quoteLiteral(value)}`);
  }

  // One statement: the setting, and the two role attributes that decide whether
  // the setting had anything to catch. `pg_roles` masks the password column and
  // is readable by every role, so this needs no grant of its own.
  const result = await connection.query(
    "SELECT current_setting('row_security'), r.rolsuper::text, r.rolbypassrls::text " +
      "FROM pg_catalog.pg_roles r WHERE r.rolname = current_user",
  );
  const setting = result.rows[0]?.[0] ?? (await readRowSecuritySetting(connection));

  if (setting !== "off") {
    throw new ExportError(
      "row_security_not_disabled",
      `The server reports row_security as ${JSON.stringify(setting)} after it was set to "off". With row security enabled, a policy could silently return a subset of a relation and the export would look complete. Refusing to read the source.`,
      { setting },
    );
  }

  return {
    setting,
    roleIsSuperuser: parseOptionalCatalogBoolean(result.rows[0]?.[1]),
    roleBypassesRowSecurity: parseOptionalCatalogBoolean(result.rows[0]?.[2]),
  };
}

async function assertTransactionDiscipline(connection: WireConnection): Promise<void> {
  const result = await connection.query(
    "SELECT current_setting('transaction_isolation'), current_setting('transaction_read_only')",
  );
  const isolation = result.rows[0]?.[0] ?? "";
  const readOnly = result.rows[0]?.[1] ?? "";
  if (isolation !== "repeatable read") {
    throw new ExportError(
      "isolation_not_repeatable_read",
      `The transaction reports isolation ${JSON.stringify(isolation)}. Only a repeatable-read transaction produces a snapshot.`,
      { isolation },
    );
  }
  if (readOnly !== "on") {
    throw new ExportError(
      "transaction_not_read_only",
      "The transaction is not read-only. Refusing to touch the source with a writable transaction.",
      { transaction_read_only: readOnly },
    );
  }
}

/**
 * Fail on schema drift before reading a single row.
 *
 * The disposition manifest was written against a schema captured at a point in
 * time. If a column has been added, dropped, renamed or retyped since, the
 * export is no longer the thing the manifest describes, and continuing would
 * quietly produce a file whose columns do not mean what the loader thinks.
 */
async function assertRelationShape(
  connection: WireConnection,
  relation: PlannedRelation,
): Promise<void> {
  const result = await connection.query(
    "SELECT a.attnum::text, a.attname, format_type(a.atttypid, a.atttypmod), c.relkind " +
      "FROM pg_catalog.pg_attribute a " +
      "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      `WHERE n.nspname = ${quoteLiteral(relation.schema)} AND c.relname = ${quoteLiteral(relation.name)} ` +
      "AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
  );

  if (result.rows.length === 0) {
    throw new ExportError(
      "relation_missing",
      `Relation ${relation.schema}.${relation.name} does not exist in this snapshot.`,
      { relation: `${relation.schema}.${relation.name}` },
    );
  }

  const actualKind = result.rows[0]?.[3] ?? "";
  if (actualKind !== relation.kind) {
    throw new ExportError(
      "relation_kind_drift",
      `Relation ${relation.schema}.${relation.name} is relkind ${JSON.stringify(actualKind)}, the plan expects ${JSON.stringify(relation.kind)}.`,
      { relation: `${relation.schema}.${relation.name}`, expected: relation.kind, actual: actualKind },
    );
  }

  const actual = result.rows.map((row) => ({
    ordinal: Number.parseInt(row[0] ?? "0", 10),
    name: row[1] ?? "",
    type: row[2] ?? "",
  }));

  if (actual.length !== relation.columns.length) {
    throw new ExportError(
      "schema_drift",
      `Relation ${relation.schema}.${relation.name} has ${actual.length} columns; the plan describes ${relation.columns.length}.`,
      {
        relation: `${relation.schema}.${relation.name}`,
        expected: relation.columns.length,
        actual: actual.length,
      },
    );
  }

  for (let index = 0; index < actual.length; index += 1) {
    const planned = relation.columns[index];
    const found = actual[index];
    if (planned.name !== found.name || planned.ordinal !== found.ordinal || planned.type !== found.type) {
      throw new ExportError(
        "schema_drift",
        `Relation ${relation.schema}.${relation.name} column ${found.ordinal} is ${found.name} ${found.type}; the plan describes ${planned.ordinal} ${planned.name} ${planned.type}.`,
        {
          relation: `${relation.schema}.${relation.name}`,
          expected: `${planned.ordinal} ${planned.name} ${planned.type}`,
          actual: `${found.ordinal} ${found.name} ${found.type}`,
        },
      );
    }
  }
}

type ActualSchemaRelation = { kind: string; rls: boolean };
type ActualSchemaColumn = { ordinal: number; name: string; type: string; nullable: boolean };
type ActualSchemaConstraint = { name: string; type: string; definition: string };

function parseCatalogBoolean(value: string | null, field: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ExportError("schema_catalog_invalid", `The source catalog returned an invalid ${field} value.`);
}

/**
 * Validate the complete source schema captured by a real inventory.
 *
 * `include` controls which files are written; it must never reduce the schema
 * drift boundary. The complete contract is therefore checked inside the same
 * repeatable-read transaction before the first selected relation is copied.
 * Fixture-only plans intentionally omit this contract and retain their narrow
 * relation-shape checks.
 */
export async function assertSchemaContract(
  connection: WireConnection,
  contract: ExportSchemaContract,
): Promise<void> {
  if (!contract.schema || contract.relations.length === 0) {
    throw new ExportError("schema_contract_invalid", "The source schema contract is empty.");
  }

  const expectedByName = new Map<string, ExpectedRelation>();
  for (const relation of contract.relations) {
    if (relation.schema !== contract.schema || expectedByName.has(relation.name)) {
      throw new ExportError("schema_contract_invalid", "The source schema contract contains duplicate or mismatched relations.");
    }
    expectedByName.set(relation.name, relation);
  }

  const relationResult = await connection.query(
    "SELECT c.relname, c.relkind, c.relrowsecurity::text " +
      "FROM pg_catalog.pg_class c " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      `WHERE n.nspname = ${quoteLiteral(contract.schema)} AND c.relkind IN ('r', 'v', 'm', 'p') ` +
      "ORDER BY c.relname",
  );
  const actualByName = new Map<string, ActualSchemaRelation>();
  for (const row of relationResult.rows) {
    const name = row[0] ?? "";
    if (!name || actualByName.has(name)) {
      throw new ExportError("schema_catalog_invalid", "The source catalog returned duplicate relation metadata.");
    }
    actualByName.set(name, {
      kind: row[1] ?? "",
      rls: parseCatalogBoolean(row[2], "relrowsecurity"),
    });
  }

  for (const [name, expected] of expectedByName) {
    const actual = actualByName.get(name);
    if (!actual) {
      throw new ExportError(
        "schema_relation_missing",
        `The source schema is missing inventoried relation ${contract.schema}.${name}; refusing to export.`,
        { relation: `${contract.schema}.${name}` },
      );
    }
    if (actual.kind !== expected.kind || actual.rls !== expected.rls) {
      throw new ExportError(
        "schema_relation_drift",
        `Inventoried relation ${contract.schema}.${name} differs in kind or row security; refusing to export.`,
        {
          relation: `${contract.schema}.${name}`,
          expected_kind: expected.kind,
          actual_kind: actual.kind,
          expected_rls: expected.rls,
          actual_rls: actual.rls,
        },
      );
    }
  }
  for (const name of actualByName.keys()) {
    if (!expectedByName.has(name)) {
      throw new ExportError(
        "schema_relation_added",
        `The source schema has uninventoried relation ${contract.schema}.${name}; refusing to export.`,
        { relation: `${contract.schema}.${name}` },
      );
    }
  }

  const columnResult = await connection.query(
    "SELECT c.relname, a.attnum::text, a.attname, format_type(a.atttypid, a.atttypmod), " +
      "(NOT a.attnotnull)::text " +
      "FROM pg_catalog.pg_attribute a " +
      "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      `WHERE n.nspname = ${quoteLiteral(contract.schema)} AND c.relkind IN ('r', 'v', 'm', 'p') ` +
      "AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum",
  );
  const actualColumns = new Map<string, ActualSchemaColumn[]>();
  for (const row of columnResult.rows) {
    const relation = row[0] ?? "";
    const ordinal = Number.parseInt(row[1] ?? "0", 10);
    const name = row[2] ?? "";
    const type = row[3] ?? "";
    if (!actualByName.has(relation) || !Number.isSafeInteger(ordinal) || ordinal < 1 || !name || !type) {
      throw new ExportError("schema_catalog_invalid", "The source catalog returned invalid column metadata.");
    }
    const columns = actualColumns.get(relation) ?? [];
    columns.push({ ordinal, name, type, nullable: parseCatalogBoolean(row[4], "column nullability") });
    actualColumns.set(relation, columns);
  }

  for (const [name, expected] of expectedByName) {
    const actual = actualColumns.get(name) ?? [];
    if (actual.length !== expected.columns.length) {
      throw new ExportError(
        "schema_column_drift",
        `Inventoried relation ${contract.schema}.${name} has a different column count; refusing to export.`,
        { relation: `${contract.schema}.${name}`, expected: expected.columns.length, actual: actual.length },
      );
    }
    for (let index = 0; index < actual.length; index += 1) {
      const expectedColumn = expected.columns[index];
      const actualColumn = actual[index];
      if (
        expectedColumn.ordinal !== actualColumn.ordinal ||
        expectedColumn.name !== actualColumn.name ||
        expectedColumn.type !== actualColumn.type ||
        expectedColumn.nullable !== actualColumn.nullable
      ) {
        throw new ExportError(
          "schema_column_drift",
          `Inventoried relation ${contract.schema}.${name} has a changed column contract; refusing to export.`,
          {
            relation: `${contract.schema}.${name}`,
            column: expectedColumn.name,
            expected: `${expectedColumn.ordinal} ${expectedColumn.name} ${expectedColumn.type} nullable=${expectedColumn.nullable}`,
            actual: `${actualColumn.ordinal} ${actualColumn.name} ${actualColumn.type} nullable=${actualColumn.nullable}`,
          },
        );
      }
    }
  }

  const constraintResult = await connection.query(
    // Match the inventory's canonical (non-pretty) constraint rendering.
    // Pretty output removes parentheses and falsely reports unchanged CHECKs.
    "SELECT c.relname, con.conname, con.contype, pg_get_constraintdef(con.oid, false) " +
      "FROM pg_catalog.pg_constraint con " +
      "JOIN pg_catalog.pg_class c ON c.oid = con.conrelid " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      `WHERE n.nspname = ${quoteLiteral(contract.schema)} AND c.relkind IN ('r', 'v', 'm', 'p') ` +
      "ORDER BY c.relname, con.conname",
  );
  const actualConstraints = new Map<string, ActualSchemaConstraint[]>();
  for (const row of constraintResult.rows) {
    const relation = row[0] ?? "";
    const name = row[1] ?? "";
    const type = row[2] ?? "";
    const definition = row[3] ?? "";
    if (!actualByName.has(relation) || !name || !type || !definition) {
      throw new ExportError("schema_catalog_invalid", "The source catalog returned invalid constraint metadata.");
    }
    const constraints = actualConstraints.get(relation) ?? [];
    constraints.push({ name, type, definition });
    actualConstraints.set(relation, constraints);
  }

  for (const [name, expected] of expectedByName) {
    const actual = actualConstraints.get(name) ?? [];
    if (actual.length !== expected.constraints.length) {
      throw new ExportError(
        "schema_constraint_drift",
        `Inventoried relation ${contract.schema}.${name} has a different constraint set; refusing to export.`,
        { relation: `${contract.schema}.${name}`, expected: expected.constraints.length, actual: actual.length },
      );
    }
    for (let index = 0; index < actual.length; index += 1) {
      const expectedConstraint = expected.constraints[index];
      const actualConstraint = actual[index];
      if (
        expectedConstraint.name !== actualConstraint.name ||
        expectedConstraint.type !== actualConstraint.type ||
        expectedConstraint.definition !== actualConstraint.definition
      ) {
        throw new ExportError(
          "schema_constraint_drift",
          `Inventoried relation ${contract.schema}.${name} has a changed constraint; refusing to export.`,
          { relation: `${contract.schema}.${name}`, constraint: expectedConstraint.name },
        );
      }
    }
  }
}

async function readWatermark(
  connection: WireConnection,
  walLsnAvailable: boolean,
): Promise<SnapshotWatermark> {
  const lsnExpression = walLsnAvailable ? "pg_current_wal_lsn()::text" : "NULL::text";
  const result = await connection.query(
    "SELECT pg_snapshot_xmin(pg_current_snapshot())::text, pg_current_snapshot()::text, " +
      `${lsnExpression}, ` +
      "to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), " +
      "to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), " +
      "pg_backend_pid()::text",
  );
  const row = result.rows[0] ?? [];
  return {
    snapshotXmin: row[0] ?? "",
    currentSnapshot: row[1] ?? "",
    walLsn: row[2],
    statementStartUtc: row[3] ?? "",
    transactionStartUtc: row[4] ?? "",
    backendPid: row[5] ?? "",
  };
}

/**
 * Capture view bodies inside the export transaction.
 *
 * View definitions are supplementary migration evidence rather than row files,
 * but reading them on another connection could bind them to a different schema
 * revision. The complete inventory determines the expected names, and an exact
 * set comparison makes a missing or unexpected body a failed export.
 */
async function readViewDefinitions(
  connection: WireConnection,
  contract: ExportSchemaContract | undefined,
): Promise<SnapshotViewDefinition[]> {
  if (!contract) return [];
  const expectedNames = contract.relations
    .filter((relation) => relation.kind === "v" || relation.kind === "m")
    .map((relation) => relation.name)
    .sort();
  if (expectedNames.length === 0) return [];

  const result = await connection.query(
    "SELECT c.relname, pg_get_viewdef(c.oid, false) " +
      "FROM pg_catalog.pg_class c " +
      "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      `WHERE n.nspname = ${quoteLiteral(contract.schema)} AND c.relkind IN ('v', 'm') ` +
      "ORDER BY c.relname",
  );
  const actualNames = result.rows.map((row) => row[0] ?? "");
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new ExportError(
      "schema_view_definition_drift",
      "The source catalog returned a different set of view definitions than the inventoried schema; refusing to export.",
      { expected: expectedNames.length, actual: actualNames.length },
    );
  }

  return result.rows.map((row) => {
    const name = row[0] ?? "";
    const definition = row[1] ?? "";
    if (!name || !definition) {
      throw new ExportError(
        "schema_view_definition_invalid",
        "The source catalog returned an empty view definition; refusing to export.",
      );
    }
    return {
      schema: contract.schema,
      name,
      definition,
      sha256: createHash("sha256").update(definition, "utf8").digest("hex"),
    };
  });
}

/**
 * Run the whole snapshot inside one transaction.
 *
 * The caller owns the connection and the output files; this owns the
 * transaction. On any failure the transaction is rolled back and the error is
 * rethrown, so a partially written run never reaches the manifest step.
 */
export async function streamSnapshot(
  connection: WireConnection,
  options: SnapshotOptions,
): Promise<SnapshotResult> {
  const walLsnAvailable = await probeWalLsnAvailable(connection);

  await connection.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  try {
    const activatedRole = options.activateRole
      ? await activateReadOnlyRole(connection, options.activateRole, options.expectedSessionUser ?? "")
      : null;

    // Before the watermark, schema contract or any relation: from here on a
    // relation this role cannot see in full raises rather than returning only
    // the part its policies admit.
    const rowVisibility = await assertCompleteRowVisibility(connection);

    await assertTransactionDiscipline(connection);

    // Compare the complete contract before selecting output formatting. The
    // inventory stores PostgreSQL's `postgres` interval representation, while
    // relation files deliberately use `iso_8601`.
    if (options.plan.schemaContract) {
      await applySchemaContractSettings(connection);
      await assertSchemaContract(connection, options.plan.schemaContract);
      if (activatedRole) {
        await assertActivatedRoleScope(connection, options.plan.schemaContract);
      }
    }

    const sessionSettings = await applySessionSettings(connection, options.statementTimeoutMs);

    // The preceding catalog checks and this watermark all use the transaction's
    // one repeatable-read snapshot. Every COPY below reads that same snapshot.
    const watermark = await readWatermark(connection, walLsnAvailable);
    const viewDefinitions = await readViewDefinitions(connection, options.plan.schemaContract);

    const relations: RelationDigest[] = [];
    for (const relation of options.plan.relations) {
      await assertRelationShape(connection, relation);

      const columns = relation.columns.map((column) => quoteIdentifier(column.name));
      const sql =
        `COPY (SELECT ${columns.join(", ")} FROM ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}) ` +
        "TO STDOUT (FORMAT text, ENCODING 'UTF8')";

      const output = await options.openRelationOutput(relation);
      const recorder = new CopyWireRecorder();
      const startedAt = process.hrtime.bigint();

      let result;
      try {
        result = await connection.copyOut(sql, {
          write(chunk: Buffer): boolean {
            recorder.update(chunk);
            const accepted = output.sink.write(chunk);
            options.onCopyChunk?.(relation, chunk);
            return accepted;
          },
          whenDrained(): Promise<void> {
            return output.sink.whenDrained();
          },
        });
        await output.finish();
      } catch (error) {
        await output.abort().catch(() => {});
        throw error;
      }

      const rowsReportedByServer = parseCopyRowCount(result.commandTag);
      const digest: RelationDigest = {
        schema: relation.schema,
        name: relation.name,
        rowsReportedByServer,
        rowsCountedOnWire: recorder.rows,
        bytes: recorder.bytes,
        sha256: recorder.digest(),
        columns: relation.columns.map((column) => column.name),
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      };

      if (digest.rowsCountedOnWire !== digest.rowsReportedByServer) {
        throw new ExportError(
          "copy_row_count_mismatch",
          `Relation ${relation.schema}.${relation.name}: the server reported ${rowsReportedByServer} rows but ${recorder.rows} arrived on the wire. The stream is truncated or corrupt.`,
          {
            relation: `${relation.schema}.${relation.name}`,
            reported: rowsReportedByServer,
            received: recorder.rows,
          },
        );
      }

      relations.push(digest);
      await options.onRelationComplete?.(digest);
    }

    // Repeatable read holds one snapshot for the whole transaction, so this must
    // return exactly what the opening watermark did. If it does not, the
    // transaction was not what it claimed and the files span two points in time.
    const closing = await readWatermark(connection, walLsnAvailable);
    if (closing.currentSnapshot !== watermark.currentSnapshot) {
      throw new ExportError(
        "snapshot_changed_mid_export",
        "The transaction snapshot changed while the export was running. These files do not represent one point in time and must not be used.",
        { opening: watermark.currentSnapshot, closing: closing.currentSnapshot },
      );
    }

    // The guard is only worth its manifest entry if it was still in force for
    // the last relation as well as the first. A `SET` issued from anywhere else
    // on this connection, or a pooler that reset the session between
    // statements, would leave every relation after it filterable again.
    const rowSecurityAtClose = await readRowSecuritySetting(connection);
    if (rowSecurityAtClose !== "off") {
      throw new ExportError(
        "row_security_changed_mid_export",
        `row_security is ${JSON.stringify(rowSecurityAtClose)} at the end of the export but was "off" at the start. Relations read after it changed could have been silently filtered by a policy. These files must not be used.`,
        { opening: rowVisibility.setting, closing: rowSecurityAtClose },
      );
    }

    await connection.query("COMMIT");
    return {
      watermark,
      closingSnapshot: closing.currentSnapshot,
      relations,
      sessionSettings,
      rowSecurity: { ...rowVisibility, settingAtClose: rowSecurityAtClose },
      walLsnAvailable,
      viewDefinitions,
      effectiveUser: activatedRole?.currentUser ?? null,
      sessionUser: activatedRole?.sessionUser ?? null,
    };
  } catch (error) {
    try {
      await connection.query("ROLLBACK");
    } catch {
      // The connection is already unusable; the server rolls back on disconnect.
    }
    throw error;
  }
}
