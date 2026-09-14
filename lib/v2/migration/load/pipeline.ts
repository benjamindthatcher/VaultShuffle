import { assertSha256, assertUuid, canonicalSha256, sha256Text } from "./canonical.ts";
import { prepareLoadPlan, TARGET_RELATION_SPECS, type LoadBatch, type LoadPlan, type TargetRelationSpec } from "./contract.ts";
import { loaderFailure } from "./errors.ts";
import { assertPublishable, evaluateGates, type GateReport } from "./gates.ts";
import {
  buildReconciliationReport,
  compareReconciliations,
  expectedReconciliation,
  measureStorage,
  observedReconciliation,
  type ReconciliationDifference,
  type RunReconciliation,
} from "./reconcile.ts";
import { stageVerifiedRun, type StagedRun, type StagingLimits } from "./staging.ts";
import { applyLoadPlan, assertLocalTarget, readSchemaFingerprint, type AppliedStep, type LocalTargetDescriptor, type SourceRelationAccounting } from "./target.ts";
import type { VerifiedRun } from "../read/index.ts";

/**
 * The local migration pipeline: verified read -> private staging -> pure
 * transform -> pre-commit gates -> one transactional load -> reconciliation ->
 * publication.
 *
 * The phase order is the contract, not a convenience. Nothing touches the
 * target until every requested relation has been staged and verified as a
 * whole, because the reader can hand rows to a callback before it discovers a
 * truncated stream. Nothing is published until every gate has passed on
 * supplied evidence, and a gate without evidence fails.
 *
 * Two things this module deliberately does NOT do: read a clock, and decide
 * what a source value means. Instants for bookkeeping are supplied by the
 * caller so a run is reproducible, and every domain decision belongs to the
 * pure transforms, which this module only sequences.
 */

export type PipelinePhase = "stage" | "transform" | "gate" | "load" | "reconcile" | "publish";

export type TransformOutcome = Readonly<{
  /** Target-shaped rows, one batch per relation the contract declares. */
  batches: readonly LoadBatch[];
  /** Typed exception streams by name; any nonempty one blocks publication. */
  exceptionCounts: Readonly<Record<string, number>>;
  unresolvedConflicts: number;
  blockers: number;
  /** One exact source-side accounting record for every staged relation. */
  sourceAccounting: readonly SourceRelationAccounting[];
}>;

export type PipelineInput = Readonly<{
  run: Readonly<{ runId: string; snapshotKey: string; snapshotHash: string }>;
  verifiedRun: VerifiedRun;
  /** The explicit allowlist of source relations this run reads. */
  sourceRelations: readonly string[];
  /** How many source relations the manifest expects this run to disposition. */
  sourceRelationsExpected: number;
  stagingDirectory: string;
  target: LocalTargetDescriptor;
  transform: (staged: StagedRun) => TransformOutcome;
  manifestFingerprint: string;
  /** Known schema revision fingerprint supplied by the reviewed run packet. */
  expectedSchemaFingerprint: string;
  /** Snapshot-sensitive decisions and whether their evidence was supplied. */
  snapshotDecisions: Readonly<Record<string, boolean>>;
  /** Bookkeeping instants, supplied rather than read from a clock. */
  instants: Readonly<{ startedAt: string; finishedAt: string }>;
  specs?: readonly TargetRelationSpec[];
  /** Local scalar/FK binding for explicitly adapted batches. */
  specsForBatches?: (batches: readonly LoadBatch[]) => readonly TargetRelationSpec[];
  /** Stable relation inventory used by the independently pinned fingerprint. */
  schemaRelations?: readonly string[];
  stagingLimits?: StagingLimits;
}>;

export type PipelineResult = Readonly<{
  phases: readonly PipelinePhase[];
  plan: LoadPlan;
  gates: GateReport;
  expected: RunReconciliation;
  observed: RunReconciliation;
  differences: readonly ReconciliationDifference[];
  report: Readonly<{ report: Readonly<Record<string, unknown>>; sha256: string }>;
  fingerprints: Readonly<{ schema: string; manifest: string; transform: string; staging: string }>;
  published: boolean;
}>;

/**
 * Run every phase, or refuse.
 *
 * The staging directory is destroyed on every exit path, including success:
 * it holds private source rows and has no reason to outlive the run.
 */
export async function runLoaderPipeline(input: PipelineInput): Promise<PipelineResult> {
  if (typeof input !== "object" || input === null) throw loaderFailure("loader_contract_invalid", { field: "input" });
  const runId = assertUuid(input.run.runId, "run_id");
  const snapshotHash = assertSha256(input.run.snapshotHash, "snapshot_hash");
  const manifestFingerprint = assertSha256(input.manifestFingerprint, "manifest_fingerprint");
  const expectedSchemaFingerprint = assertSha256(input.expectedSchemaFingerprint, "schema_fingerprint");
  const target = assertLocalTarget(input.target);
  const phases: PipelinePhase[] = [];

  const staged = await stageVerifiedRun(
    input.verifiedRun,
    input.sourceRelations,
    input.stagingDirectory,
    input.stagingLimits ?? {},
  );
  phases.push("stage");

  try {
    const outcome = input.transform(staged);
    const transformFingerprint = canonicalSha256(outcome.batches);
    phases.push("transform");

    if (input.specs !== undefined && input.specsForBatches !== undefined) {
      throw loaderFailure("loader_contract_invalid", { field: "spec_source" });
    }
    const specs = input.specsForBatches?.(outcome.batches) ?? input.specs ?? TARGET_RELATION_SPECS;
    const plan = prepareLoadPlan(specs, outcome.batches);
    const actualSchemaFingerprint = sha256Text(readSchemaFingerprint(target, input.schemaRelations ?? specs.map((spec) => spec.relation)));

    const accountingByRelation = new Map(outcome.sourceAccounting.map((entry) => [entry.relation, entry]));
    if (accountingByRelation.size !== outcome.sourceAccounting.length) {
      throw loaderFailure("loader_source_coverage", { field: "duplicate_accounting" });
    }
    for (const relation of staged.relations) {
      const accounting = accountingByRelation.get(relation.relation);
      if (accounting === undefined || accounting.sourceRows !== relation.rowCount) {
        throw loaderFailure("loader_source_coverage", { relation: relation.relation });
      }
      accountingByRelation.delete(relation.relation);
    }
    if (accountingByRelation.size !== 0) throw loaderFailure("loader_source_coverage", { field: "extra_accounting" });

    // Every gate that can be decided without target mutation runs before the
    // transaction. The transaction itself performs typed EXCEPT ALL
    // reconciliation before it commits and marks the run succeeded.
    const gates = evaluateGates({
      readerRelationsRequested: input.sourceRelations.length,
      readerRelationsStaged: staged.relations.length,
      exceptionCounts: outcome.exceptionCounts,
      unresolvedConflicts: outcome.unresolvedConflicts,
      blockers: outcome.blockers,
      sourceRelationsExpected: input.sourceRelationsExpected,
      sourceRelationsCovered: outcome.sourceAccounting.length,
      targetRelationsPlanned: plan.relations.length,
      targetRelationsContracted: specs.length,
      expectedSchemaFingerprint,
      actualSchemaFingerprint,
      snapshotDecisions: input.snapshotDecisions,
      reconciliationMismatches: 0,
    });
    phases.push("gate");
    const fingerprints = Object.freeze({
      schema: actualSchemaFingerprint,
      manifest: manifestFingerprint,
      transform: transformFingerprint,
      staging: staged.fingerprint,
    });
    assertPublishable(gates, fingerprints);

    const steps: AppliedStep[] = plan.relations
      .filter((relation) => relation.rows.length > 0)
      .map((relation) => ({
        runId,
        phase: `load:${relation.relation}`,
        relation: relation.relation,
        rows: relation.rows.length,
        checksum: canonicalSha256(relation.rows),
        startedAt: input.instants.startedAt,
        finishedAt: input.instants.finishedAt,
      }));

    applyLoadPlan(
      target,
      plan,
      {
        runId,
        snapshotKey: input.run.snapshotKey,
        snapshotHash,
        startedAt: input.instants.startedAt,
        finishedAt: input.instants.finishedAt,
        schemaFingerprint: actualSchemaFingerprint,
        manifestFingerprint,
        transformFingerprint,
        stagingFingerprint: staged.fingerprint,
      },
      steps,
      outcome.sourceAccounting,
    );
    phases.push("load");

    const expected = expectedReconciliation(plan, { runId, snapshotHash });
    const observed = observedReconciliation(target, plan, { runId, snapshotHash });
    const differences = compareReconciliations(expected, observed);
    phases.push("reconcile");

    if (differences.length !== 0) throw loaderFailure("loader_reconciliation_failed", {
      field: "post_commit_observation",
      relation: differences[0]?.relation ?? "unknown",
      kind: differences[0]?.kind ?? "unknown",
      count: differences.length,
      affected: differences.map((difference) => `${difference.relation}:${difference.kind}${difference.column ? `:${difference.column}` : ""}`).join(","),
    });
    const report = buildReconciliationReport(
      {
        runId,
        snapshotHash,
        schemaFingerprint: fingerprints.schema,
        manifestFingerprint: fingerprints.manifest,
        transformFingerprint: fingerprints.transform,
        stagingFingerprint: fingerprints.staging,
        durationsMs: Object.freeze({}),
        storage: measureStorage(target, plan),
        storageMeasuredOn: "synthetic-fixture",
      },
      expected,
      observed,
      differences,
    );

    phases.push("publish");

    return Object.freeze({
      phases: Object.freeze(phases),
      plan,
      gates,
      expected,
      observed,
      differences,
      report,
      fingerprints,
      published: true,
    });
  } finally {
    staged.destroy();
  }
}
