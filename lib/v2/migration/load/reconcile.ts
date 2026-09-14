import { OrderedChecksum, canonicalJson, canonicalSha256, quoteRelation, sha256Text } from "./canonical.ts";
import { closeSync, fsyncSync, lstatSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { loaderFailure } from "./errors.ts";
import { queryRows, type LocalTargetDescriptor } from "./target.ts";
import type { LoadPlan } from "./contract.ts";
import type { TargetScalarKind } from "./copy.ts";
import { parsePgDecimal } from "../transform/scalars.ts";

/**
 * Reconciliation: prove the target holds what the transforms said, per
 * relation and per account, in a form a person can diff.
 *
 * Counts alone cannot detect the failures that matter. Two accounts whose game
 * identities were swapped have identical counts; so does a library whose
 * authored notes were replaced with someone else's. The checksum below is
 * therefore taken over the ORDERED, canonicalised cell values of every loaded
 * row, so a swapped identity or a changed authored fact changes the digest.
 *
 * The report contains no source value: digests, counts, and relation/account
 * keys only. It is designed to be written to a private file and diffed.
 */

export type RelationReconciliation = Readonly<{
  relation: string;
  rows: number;
  sha256: string;
  /** Per-account digests, present only where the relation has an account key. */
  byAccount: Readonly<Record<string, Readonly<{ rows: number; sha256: string }>>>;
  byColumn: Readonly<Record<string, string>>;
}>;

export type RunReconciliation = Readonly<{
  runId: string;
  snapshotHash: string;
  relations: readonly RelationReconciliation[];
  totals: Readonly<{ relations: number; rows: number }>;
  /** One digest over every relation digest; the run's single comparison point. */
  sha256: string;
}>;

export type StorageMeasurement = Readonly<{
  relation: string;
  tableBytes: number;
  indexBytes: number;
}>;

export type RunMetadata = Readonly<{
  runId: string;
  snapshotHash: string;
  schemaFingerprint: string;
  manifestFingerprint: string;
  transformFingerprint: string;
  stagingFingerprint: string;
  /** Milliseconds, supplied by the caller from its own measurement. */
  durationsMs: Readonly<Record<string, number>>;
  /**
   * Measured on the SYNTHETIC target only. Labelled here, in the data, so a
   * later reader cannot mistake a fixture measurement for a real-user one.
   */
  storage: readonly StorageMeasurement[];
  storageMeasuredOn: "synthetic-fixture";
}>;

const UNIT_SEPARATOR = String.fromCharCode(31);

const ACCOUNT_COLUMNS = ["account_id", "mapped_source_account_id", "source_account_public_id"] as const;

/**
 * The expected reconciliation, computed from the plan the loader is about to
 * apply. Nothing is read from the target here: this is the claim.
 */
export function expectedReconciliation(
  plan: LoadPlan,
  run: Readonly<{ runId: string; snapshotHash: string }>,
): RunReconciliation {
  const relations: RelationReconciliation[] = [];
  for (const relation of plan.relations) {
    const accountIndex = relation.columns.findIndex((column) =>
      (ACCOUNT_COLUMNS as readonly string[]).includes(column),
    );
    const whole = new OrderedChecksum();
    const perAccount = new Map<string, OrderedChecksum>();
    const perColumn = relation.columns.map(() => new OrderedChecksum());
    const accountRows = new Map<string, number>();
    // Rows are hashed in the plan's own deterministic order, which the
    // transforms already sorted; the digest therefore depends on the values,
    // not on when a row happened to be produced.
    const sortedRows = [...relation.rows].map((row) => row.map((cell, index) =>
      cell === null ? null : canonicalReconciliationCell(cell, relation.columnKinds[index]),
    )).sort(compareRows);
    for (const row of sortedRows) {
      whole.update(row);
      row.forEach((cell, index) => perColumn[index]?.update([cell]));
      if (accountIndex >= 0) {
        const key = row[accountIndex] ?? "null";
        const checksum = perAccount.get(key) ?? new OrderedChecksum();
        checksum.update(row);
        perAccount.set(key, checksum);
        accountRows.set(key, (accountRows.get(key) ?? 0) + 1);
      }
    }
    const byAccount: Record<string, Readonly<{ rows: number; sha256: string }>> = {};
    for (const [key, checksum] of [...perAccount.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
      byAccount[key] = Object.freeze({ rows: accountRows.get(key) ?? 0, sha256: checksum.finish().sha256 });
    }
    const finished = whole.finish();
    relations.push(
      Object.freeze({
        relation: relation.relation,
        rows: finished.rows,
        sha256: finished.sha256,
        byAccount: Object.freeze(byAccount),
        byColumn: Object.freeze(Object.fromEntries(relation.columns.map((column, index) => [column, perColumn[index]!.finish().sha256]))),
      }),
    );
  }
  return finishRun(run, relations);
}

/**
 * The observed reconciliation, read back from the target after the load.
 *
 * The same canonicalisation is applied to what PostgreSQL returns, so a value
 * the server normalised differently from the loader's encoding shows up as a
 * mismatch instead of being hidden by a looser comparison.
 */
export function observedReconciliation(
  descriptor: LocalTargetDescriptor,
  plan: LoadPlan,
  run: Readonly<{ runId: string; snapshotHash: string }>,
): RunReconciliation {
  const relations: RelationReconciliation[] = [];
  for (const relation of plan.relations) {
    const accountIndex = relation.columns.findIndex((column) =>
      (ACCOUNT_COLUMNS as readonly string[]).includes(column),
    );
    // `format` with %s renders each column through its own output function;
    // the separator is a unit separator so a value containing a tab or a
    // newline cannot fake a column boundary.
    const projection = relation.columns
      .map((column, index) => `coalesce(${quotedColumnText(column, relation.columnKinds[index])}, '\\N')`)
      .join(` || chr(31) || `);
    const rows = queryRows(
      descriptor,
      `select ${projection} as row_text from ${quoteRelation(relation.relation)} order by row_text;`,
    );
    const whole = new OrderedChecksum();
    const perAccount = new Map<string, OrderedChecksum>();
    const perColumn = relation.columns.map(() => new OrderedChecksum());
    const accountRows = new Map<string, number>();
    const parsed = rows
      .map((line) => line.split(UNIT_SEPARATOR).map((cell, index) =>
        cell === "\\N" ? null : canonicalObservedCell(cell, relation.columnKinds[index]),
      ))
      .sort(compareRows);
    for (const row of parsed) {
      if (row.length !== relation.columns.length) {
        throw loaderFailure("loader_reconciliation_failed", { relation: relation.relation });
      }
      whole.update(row);
      row.forEach((cell, index) => perColumn[index]?.update([cell]));
      if (accountIndex >= 0) {
        const key = row[accountIndex] ?? "null";
        const checksum = perAccount.get(key) ?? new OrderedChecksum();
        checksum.update(row);
        perAccount.set(key, checksum);
        accountRows.set(key, (accountRows.get(key) ?? 0) + 1);
      }
    }
    const byAccount: Record<string, Readonly<{ rows: number; sha256: string }>> = {};
    for (const [key, checksum] of [...perAccount.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
      byAccount[key] = Object.freeze({ rows: accountRows.get(key) ?? 0, sha256: checksum.finish().sha256 });
    }
    const finished = whole.finish();
    relations.push(
      Object.freeze({
        relation: relation.relation,
        rows: finished.rows,
        sha256: finished.sha256,
        byAccount: Object.freeze(byAccount),
        byColumn: Object.freeze(Object.fromEntries(relation.columns.map((column, index) => [column, perColumn[index]!.finish().sha256]))),
      }),
    );
  }
  return finishRun(run, relations);
}

function canonicalObservedCell(cell: string, kind: TargetScalarKind | undefined): string {
  return canonicalReconciliationCell(cell, kind);
}

function canonicalReconciliationCell(cell: string, kind: TargetScalarKind | undefined): string {
  if (kind === "numeric") {
    const parsed = parsePgDecimal(cell);
    if (parsed === null) throw loaderFailure("loader_reconciliation_failed", { field: "numeric_readback" });
    const canonical = parsed.toCanonicalString();
    const unscaled = canonical.includes(".") ? canonical.replace(/0+$/, "").replace(/\.$/, "") : canonical;
    return /^-?0$/.test(unscaled) ? "0" : unscaled;
  }
  if (kind !== "jsonb") return cell;
  try {
    // This is a comparison representation only. COPY retains the original
    // numeric token text; typed EXCEPT ALL inside the transaction is the
    // authoritative exact-value proof.
    return canonicalJson(JSON.parse(cell));
  } catch {
    throw loaderFailure("loader_reconciliation_failed", { field: "jsonb_readback" });
  }
}

function quotedColumnText(column: string, kind: TargetScalarKind | undefined): string {
  // Rendered as text with the same canonical shapes the loader encoded:
  // timestamps in UTC with microseconds, jsonb sorted by key on read, bytea in
  // hex. Anything else would compare an encoding difference as a data change.
  switch (kind) {
    case "timestamptz":
      return `to_char("${column}" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    case "jsonb":
      return `("${column}")::jsonb::text`;
    case "bytea-hex":
      return `'\\x' || encode("${column}", 'hex')`;
    case "boolean":
      return `case when "${column}" is null then null when "${column}" then 't' else 'f' end`;
    case "text":
    case "integer":
    case "numeric":
    case "date":
    case "uuid":
      return `"${column}"::text`;
    default:
      throw loaderFailure("loader_contract_invalid", { field: "reconciliation_kind" });
  }
}

function compareRows(left: readonly (string | null)[], right: readonly (string | null)[]): number {
  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function finishRun(
  run: Readonly<{ runId: string; snapshotHash: string }>,
  relations: readonly RelationReconciliation[],
): RunReconciliation {
  const ordered = [...relations].sort((left, right) => (left.relation < right.relation ? -1 : 1));
  return Object.freeze({
    runId: run.runId,
    snapshotHash: run.snapshotHash,
    relations: Object.freeze(ordered),
    totals: Object.freeze({
      relations: ordered.length,
      rows: ordered.reduce((total, relation) => total + relation.rows, 0),
    }),
    sha256: sha256Text(ordered.map((relation) => `${relation.relation}:${relation.sha256}`).join("\n")),
  });
}

export type ReconciliationDifference = Readonly<{
  relation: string;
  kind: "missing" | "unexpected" | "row_count" | "checksum" | "account_checksum" | "column_checksum";
  expected: string | number;
  observed: string | number;
  accountKey?: string;
  column?: string;
}>;

/** Compare claim with observation, and say exactly where they differ. */
export function compareReconciliations(
  expected: RunReconciliation,
  observed: RunReconciliation,
): readonly ReconciliationDifference[] {
  const differences: ReconciliationDifference[] = [];
  const observedByRelation = new Map(observed.relations.map((relation) => [relation.relation, relation]));
  for (const relation of expected.relations) {
    const actual = observedByRelation.get(relation.relation);
    if (actual === undefined) {
      differences.push(Object.freeze({ relation: relation.relation, kind: "missing", expected: relation.rows, observed: 0 }));
      continue;
    }
    observedByRelation.delete(relation.relation);
    if (relation.rows !== actual.rows) {
      differences.push(
        Object.freeze({ relation: relation.relation, kind: "row_count", expected: relation.rows, observed: actual.rows }),
      );
    }
    if (relation.sha256 !== actual.sha256) {
      differences.push(
        Object.freeze({
          relation: relation.relation,
          kind: "checksum",
          expected: relation.sha256,
          observed: actual.sha256,
        }),
      );
    }
    for (const [column, digest] of Object.entries(relation.byColumn)) {
      const observedDigest = actual.byColumn[column];
      if (observedDigest !== digest) differences.push(Object.freeze({
        relation: relation.relation, kind: "column_checksum", column,
        expected: digest, observed: observedDigest ?? "absent",
      }));
    }
    for (const [accountKey, digest] of Object.entries(relation.byAccount)) {
      const actualDigest = actual.byAccount[accountKey];
      if (actualDigest === undefined || actualDigest.sha256 !== digest.sha256) {
        differences.push(
          Object.freeze({
            relation: relation.relation,
            kind: "account_checksum",
            accountKey,
            expected: digest.sha256,
            observed: actualDigest?.sha256 ?? "absent",
          }),
        );
      }
    }
  }
  for (const remaining of observedByRelation.values()) {
    differences.push(
      Object.freeze({ relation: remaining.relation, kind: "unexpected", expected: 0, observed: remaining.rows }),
    );
  }
  return Object.freeze(differences);
}

/** Table and index bytes for the loaded relations, on the synthetic target. */
export function measureStorage(
  descriptor: LocalTargetDescriptor,
  plan: LoadPlan,
): readonly StorageMeasurement[] {
  const measurements: StorageMeasurement[] = [];
  for (const relation of plan.relations) {
    const row = queryRows(
      descriptor,
      `select pg_table_size('${relation.relation}')::text || ' ' || pg_indexes_size('${relation.relation}')::text;`,
    );
    const [tableBytes, indexBytes] = (row[0] ?? "0 0").split(" ").map((value) => Number.parseInt(value, 10));
    measurements.push(
      Object.freeze({
        relation: relation.relation,
        tableBytes: Number.isFinite(tableBytes) ? tableBytes : 0,
        indexBytes: Number.isFinite(indexBytes) ? indexBytes : 0,
      }),
    );
  }
  return Object.freeze(measurements);
}

/** The private, machine-readable report a rehearsal writes out. */
export function buildReconciliationReport(
  metadata: RunMetadata,
  expected: RunReconciliation,
  observed: RunReconciliation,
  differences: readonly ReconciliationDifference[],
): Readonly<{ report: Readonly<Record<string, unknown>>; sha256: string }> {
  const report = Object.freeze({
    kind: "vaultshuffle-v2-migration-reconciliation",
    version: 1,
    evidence_class: "synthetic-fixture",
    metadata,
    expected,
    observed,
    differences,
    matched: differences.length === 0,
  });
  return Object.freeze({ report, sha256: canonicalSha256(report) });
}

/** Write the value-free reconciliation report once, under an owner-only parent. */
export function writePrivateReconciliationReport(
  path: string,
  value: Readonly<{ report: Readonly<Record<string, unknown>>; sha256: string }>,
): void {
  if (!isAbsolute(path)) throw loaderFailure("loader_contract_invalid", { field: "report_path" });
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
    throw loaderFailure("loader_stage_failed", { field: "report_parent_mode" });
  }
  if (canonicalSha256(value.report) !== value.sha256) {
    throw loaderFailure("loader_reconciliation_failed", { field: "report_digest" });
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx", 0o600);
    writeSync(fd, `${canonicalJson(value.report)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } catch (error) {
    throw error instanceof Error && "loaderCode" in error ? error : loaderFailure("loader_stage_failed", { field: "report_write" });
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
