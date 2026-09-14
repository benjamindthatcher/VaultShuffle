import assert from "node:assert/strict";
import test from "node:test";
import { LoaderError } from "./errors.ts";
import { ALL_SOURCE_RELATIONS, aggregateDomainGateCounts, assembleAllDomains } from "./all-domains.ts";
import type { StagedRun } from "./staging.ts";

const SNAPSHOT = "a".repeat(64);
const RUN = Object.freeze({ runId: "all-domains-test", snapshotHash: SNAPSHOT });
const EVIDENCE = Object.freeze({
  observedAt: "2026-09-12 00:00:00+00",
  warmStart: { snapshot_key: "synthetic", snapshot_version: "1", frozen_at: "2026-09-12 00:00:00+00" },
  operatorConfig: { config_version: "synthetic", effective_at: "2026-09-12 00:00:00+00" },
  targetRelations: [],
});

function staged(omit: string | null = null, reverse = false): StagedRun {
  const sourceRelations = ALL_SOURCE_RELATIONS.filter((relation) => relation !== omit);
  if (reverse) sourceRelations.reverse();
  const relations = sourceRelations.map((relation) => Object.freeze({
    relation: `public.${relation}`,
    columns: Object.freeze([]), rowCount: 0, byteCount: 0, sourceSha256: SNAPSHOT, stagedSha256: SNAPSHOT,
    readRows: () => Object.freeze([]), get rows() { return Object.freeze([]); },
  }));
  return Object.freeze({
    directory: "/private/synthetic", relations: Object.freeze(relations), totalRows: 0, fingerprint: SNAPSHOT,
    byRelation: (relation: string) => {
      const found = relations.find((entry) => entry.relation === relation);
      if (!found) throw new Error("missing");
      return found;
    }, destroy: () => {},
  }) as StagedRun;
}

test("all 44 source relations are accounted exactly once, even when every source table is empty", () => {
  const result = assembleAllDomains(staged(), RUN, EVIDENCE);
  assert.equal(result.sourceAccounting.length, 44);
  assert.deepEqual(result.sourceAccounting.map((entry) => entry.relation), ALL_SOURCE_RELATIONS.map((relation) => `public.${relation}`));
  assert.equal(result.sourceAccounting.every((entry) => entry.sourceRows === 0), true);
  assert.equal((result.gameMap as { run_identity: { run_id: string } }).run_identity.run_id, RUN.runId);
  assert.equal((result.accountMap as { run: { runId: string } }).run.runId, RUN.runId);
  assert.equal(result.exceptionCounts.settings_withheld, 0);
  assert.deepEqual(result.blockerSummary, []);
  assert.deepEqual(result.unresolvedConflictSummary, []);
});

test("a missing relation fails before any transform can treat a partial source as complete", () => {
  assert.throws(
    () => assembleAllDomains(staged("vault_events"), RUN, EVIDENCE),
    (error: unknown) => error instanceof LoaderError && error.loaderCode === "loader_source_coverage",
  );
});

test("target additions are explicit and withheld streams are never target batches", () => {
  const result = assembleAllDomains(staged(), RUN, EVIDENCE);
  assert.ok(result.targetContractAdditions.some((entry) => entry.relation === "reco.warm_start_snapshots"));
  assert.equal(result.batches.some((entry) => /withheld/.test(entry.relation)), false);
  assert.equal(result.batches.some((entry) => entry.relation === "migration.legacy_account_preferences_evidence"), false);
  assert.equal(result.blockers, result.targetContractAdditions.length);
});

test("source relation order cannot change the shared maps or assembled batches", () => {
  const forward = assembleAllDomains(staged(), RUN, EVIDENCE);
  const reverse = assembleAllDomains(staged(null, true), RUN, EVIDENCE);
  assert.equal(JSON.stringify(forward.batches), JSON.stringify(reverse.batches));
  assert.deepEqual(forward.targetContractAdditions, reverse.targetContractAdditions);
  assert.equal((forward.gameMap as { run_identity: { run_id: string } }).run_identity.run_id, RUN.runId);
  assert.equal((reverse.gameMap as { run_identity: { run_id: string } }).run_identity.run_id, RUN.runId);
  assert.equal((forward.accountMap as { run: { runId: string } }).run.runId, RUN.runId);
  assert.equal((reverse.accountMap as { run: { runId: string } }).run.runId, RUN.runId);
});

test("withheld settings and exact-source counters remain pre-commit exceptions", () => {
  const counts = aggregateDomainGateCounts({
    recencyExceptions: 0,
    completionOrderingExceptions: 0,
    drawUnresolvedReferences: 0,
    supportWithheld: 1,
    recoWithheldCounters: 1,
    recoWithheldSettings: 1,
  });
  assert.deepEqual(counts, {
    recency_exceptions: 0,
    completion_ordering_exceptions: 0,
    draw_unresolved_references: 0,
    support_withheld: 1,
    reco_withheld_counters: 1,
    settings_withheld: 1,
  });
});

test("duplicate and non-inventory staged relations cannot evade exact accounting", () => {
  const duplicate = staged() as unknown as { relations: readonly object[] };
  assert.throws(
    () => assembleAllDomains(Object.freeze({ ...duplicate, relations: Object.freeze([...duplicate.relations, duplicate.relations[0]]) }) as StagedRun, RUN, EVIDENCE),
    (error: unknown) => error instanceof LoaderError && error.loaderCode === "loader_source_coverage",
  );
});

test("wide rebuild-only relations are accounted without reconstructing unused records", () => {
  const source = staged();
  const relations = source.relations.map((relation) =>
    relation.relation === "public.user_games_with_catalog" || relation.relation === "public.catalog_duration_review_queue"
      ? Object.freeze({ ...relation, rowCount: 37, readRows: () => { throw new Error("coverage-only rows must remain lazy"); }, get rows() { throw new Error("coverage-only rows must remain lazy"); } })
      : relation,
  );
  const result = assembleAllDomains(Object.freeze({ ...source, relations: Object.freeze(relations) }) as StagedRun, RUN, EVIDENCE);
  assert.equal(result.sourceAccounting.find((entry) => entry.relation === "public.user_games_with_catalog")?.sourceRows, 37);
  assert.equal(result.sourceAccounting.find((entry) => entry.relation === "public.catalog_duration_review_queue")?.sourceRows, 37);
});
