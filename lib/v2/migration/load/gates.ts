import { assertSha256 } from "./canonical.ts";
import { loaderFailure } from "./errors.ts";

/**
 * The pre-commit gates.
 *
 * Every gate is evaluated from evidence the caller supplies; none of them has
 * a success default, and there is no flag anywhere that can mark a run
 * publishable without its evidence. A gate with no evidence is a FAILED gate,
 * not a skipped one — that is the difference between "we checked and it was
 * fine" and "nobody checked".
 */

export type GateName =
  | "reader_stream_complete"
  | "transform_exceptions_empty"
  | "transform_conflicts_resolved"
  | "transform_blockers_empty"
  | "source_coverage_complete"
  | "target_coverage_complete"
  | "schema_fingerprint_match"
  | "snapshot_decisions_supplied"
  | "reconciliation_match";

export type GateOutcome = Readonly<{
  gate: GateName;
  passed: boolean;
  /** Counts and fixed names only; never a source value. */
  detail: Readonly<Record<string, string | number | boolean>>;
}>;

export type GateEvidence = Readonly<{
  /** Every relation the reader was asked for streamed completely. */
  readerRelationsRequested: number;
  readerRelationsStaged: number;
  /** Typed exception streams: recency, completion ordering, withheld rows. */
  exceptionCounts: Readonly<Record<string, number>>;
  /** Transform conflicts, counted by `details.status`. */
  unresolvedConflicts: number;
  /** Blockers from the remaining-domain transforms. */
  blockers: number;
  /** Source relations the manifest expects vs. those this run dispositioned. */
  sourceRelationsExpected: number;
  sourceRelationsCovered: number;
  /** Target relations the plan writes vs. those the contract declares. */
  targetRelationsPlanned: number;
  targetRelationsContracted: number;
  /** The fingerprint recorded when the plan was built, and the live one. */
  expectedSchemaFingerprint: string;
  actualSchemaFingerprint: string;
  /**
   * Snapshot-sensitive decisions that need supplied evidence (cutover
   * observation, freeze instants). `false` for any one of them fails the gate.
   */
  snapshotDecisions: Readonly<Record<string, boolean>>;
  /** Per-relation reconciliation comparison, already performed. */
  reconciliationMismatches: number;
}>;

export type GateReport = Readonly<{
  outcomes: readonly GateOutcome[];
  passed: boolean;
  failedGates: readonly GateName[];
}>;

export function evaluateGates(evidence: GateEvidence): GateReport {
  if (typeof evidence !== "object" || evidence === null) {
    throw loaderFailure("loader_contract_invalid", { field: "gate_evidence" });
  }
  const exceptionTotal = Object.values(evidence.exceptionCounts).reduce((total, count) => total + count, 0);
  const missingDecisions = Object.entries(evidence.snapshotDecisions).filter(([, supplied]) => !supplied);

  const raw: readonly { gate: GateName; passed: boolean; detail: Record<string, string | number | boolean> }[] = [
    {
      gate: "reader_stream_complete",
      passed:
        evidence.readerRelationsRequested > 0 &&
        evidence.readerRelationsStaged === evidence.readerRelationsRequested,
      detail: {
        requested: evidence.readerRelationsRequested,
        staged: evidence.readerRelationsStaged,
      },
    },
    {
      gate: "transform_exceptions_empty",
      passed: exceptionTotal === 0,
      detail: { total: exceptionTotal, streams: Object.keys(evidence.exceptionCounts).length },
    },
    {
      gate: "transform_conflicts_resolved",
      passed: evidence.unresolvedConflicts === 0,
      detail: { unresolved: evidence.unresolvedConflicts },
    },
    {
      gate: "transform_blockers_empty",
      passed: evidence.blockers === 0,
      detail: { blockers: evidence.blockers },
    },
    {
      gate: "source_coverage_complete",
      passed:
        evidence.sourceRelationsExpected > 0 &&
        evidence.sourceRelationsCovered === evidence.sourceRelationsExpected,
      detail: { expected: evidence.sourceRelationsExpected, covered: evidence.sourceRelationsCovered },
    },
    {
      gate: "target_coverage_complete",
      passed:
        evidence.targetRelationsContracted > 0 &&
        evidence.targetRelationsPlanned === evidence.targetRelationsContracted,
      detail: { planned: evidence.targetRelationsPlanned, contracted: evidence.targetRelationsContracted },
    },
    {
      gate: "schema_fingerprint_match",
      passed:
        evidence.expectedSchemaFingerprint.length > 0 &&
        evidence.expectedSchemaFingerprint === evidence.actualSchemaFingerprint,
      detail: { matched: evidence.expectedSchemaFingerprint === evidence.actualSchemaFingerprint },
    },
    {
      gate: "snapshot_decisions_supplied",
      passed: Object.keys(evidence.snapshotDecisions).length > 0 && missingDecisions.length === 0,
      detail: { required: Object.keys(evidence.snapshotDecisions).length, missing: missingDecisions.length },
    },
    {
      gate: "reconciliation_match",
      passed: evidence.reconciliationMismatches === 0,
      detail: { mismatches: evidence.reconciliationMismatches },
    },
  ];
  const outcomes: readonly GateOutcome[] = raw.map((outcome) =>
    Object.freeze({ ...outcome, detail: Object.freeze(outcome.detail) }),
  );

  const failed = outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.gate);
  return Object.freeze({
    outcomes: Object.freeze(outcomes),
    passed: failed.length === 0,
    failedGates: Object.freeze(failed),
  });
}

/**
 * Publication is the only place a run becomes real, and it has exactly one
 * rule: every gate passed. There is no override argument, and the fingerprints
 * are re-validated here rather than trusted from the report.
 */
export function assertPublishable(
  report: GateReport,
  fingerprints: Readonly<{ schema: string; manifest: string; transform: string; staging: string }>,
): void {
  for (const [field, value] of Object.entries(fingerprints)) assertSha256(value, field);
  if (!report.passed) {
    throw loaderFailure("loader_publication_refused", {
      failed: report.failedGates.length,
      first: report.failedGates[0] ?? null,
    });
  }
}
