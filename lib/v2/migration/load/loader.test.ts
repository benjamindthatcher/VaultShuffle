import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, canonicalSha256, OrderedChecksum, quoteRelation, assertUuid } from "./canonical.ts";
import { prepareLoadPlan, TARGET_RELATION_SPECS, type TargetRelationSpec } from "./contract.ts";
import { encodeCopyRow, targetCell } from "./copy.ts";
import { LoaderError } from "./errors.ts";
import { assertPublishable, evaluateGates, type GateEvidence } from "./gates.ts";
import { compareReconciliations, expectedReconciliation } from "./reconcile.ts";
import { assertLocalTarget } from "./target.ts";

const SHA = "a".repeat(64);
const RUN = Object.freeze({ runId: "11111111-2222-4333-8444-555555555555", snapshotHash: SHA });

function loaderCode(execute: () => unknown): string {
  try {
    execute();
  } catch (error) {
    assert.ok(error instanceof LoaderError, `expected LoaderError, received ${String(error)}`);
    return error.loaderCode;
  }
  assert.fail("expected a LoaderError");
}

/* --- the local-only target boundary -------------------------------------- */

const LOCAL = Object.freeze({
  socketDirectory: "/tmp/vs-loader-socket",
  port: 55496,
  user: "vsm3",
  database: "vs_loader",
  psqlPath: "/usr/local/bin/psql",
});

test("a local Unix-socket descriptor is accepted", () => {
  assert.equal(assertLocalTarget(LOCAL).database, "vs_loader");
});

test("anything that could reach a remote database is refused", () => {
  // A host name, a URL, a relative path and a port outside the local range are
  // the four shapes a "local" descriptor turns remote through.
  assert.equal(loaderCode(() => assertLocalTarget({ ...LOCAL, socketDirectory: "db.example.com" })), "loader_remote_refused");
  assert.equal(
    loaderCode(() => assertLocalTarget({ ...LOCAL, socketDirectory: "postgres://user@host/db" })),
    "loader_remote_refused",
  );
  assert.equal(loaderCode(() => assertLocalTarget({ ...LOCAL, socketDirectory: "relative/path" })), "loader_remote_refused");
  assert.equal(loaderCode(() => assertLocalTarget({ ...LOCAL, port: 80 })), "loader_remote_refused");
});

/* --- COPY encoding ------------------------------------------------------- */

test("every declared target type encodes exactly, and an unrepresentable value is refused", () => {
  assert.equal(targetCell({ name: "n", kind: "integer", nullable: false }, 42), "42");
  assert.equal(targetCell({ name: "n", kind: "integer", nullable: false }, BigInt("2147483647")), "2147483647");
  assert.equal(targetCell({ name: "d", kind: "numeric", nullable: false }, "7.500000000001"), "7.500000000001");
  assert.equal(targetCell({ name: "b", kind: "boolean", nullable: false }, true), "t");
  assert.equal(
    targetCell({ name: "t", kind: "timestamptz", nullable: false }, "2026-02-01 10:00:00.000001+00"),
    "2026-02-01T10:00:00.000001Z",
  );
  assert.equal(targetCell({ name: "u", kind: "uuid", nullable: false }, "11111111-2222-4333-8444-555555555555"),
    "11111111-2222-4333-8444-555555555555");
  assert.equal(targetCell({ name: "j", kind: "jsonb", nullable: false }, '{"a":1}'), '{"a":1}');
  assert.equal(
    targetCell({ name: "j", kind: "jsonb", nullable: false }, '{"counter":9223372036854775807}'),
    '{"counter":9223372036854775807}',
    "JSON numeric tokens must never round through a JavaScript number",
  );
  assert.equal(targetCell({ name: "h", kind: "bytea-hex", nullable: true }, SHA), `\\x${SHA}`);
  assert.equal(targetCell({ name: "x", kind: "text", nullable: true }, null), null);

  assert.equal(loaderCode(() => targetCell({ name: "x", kind: "text", nullable: false }, null)), "loader_copy_invalid");
  assert.equal(loaderCode(() => targetCell({ name: "n", kind: "integer", nullable: false }, "not-a-number")), "loader_copy_invalid");
  assert.equal(loaderCode(() => targetCell({ name: "j", kind: "jsonb", nullable: false }, "{not json")), "loader_copy_invalid");
  // A NUL cannot be represented in a text COPY stream at all.
  assert.equal(loaderCode(() => targetCell({ name: "x", kind: "text", nullable: false }, "a\0b")), "loader_copy_invalid");
});

test("COPY escaping survives the characters that would otherwise break the stream", () => {
  const encoded = encodeCopyRow(["a\tb", "line\nbreak", "back\\slash", null]);
  assert.equal(encoded, "a\\tb\tline\\nbreak\tback\\\\slash\t\\N\n");
});

/* --- the load plan ------------------------------------------------------- */

const SPECS: readonly TargetRelationSpec[] = Object.freeze([
  Object.freeze({
    relation: "app.child",
    dependsOn: Object.freeze(["app.parent"]),
    columns: Object.freeze([
      Object.freeze({ name: "account_id", kind: "integer", nullable: false }),
      Object.freeze({ name: "note", kind: "text", nullable: true }),
    ]),
  }),
  Object.freeze({
    relation: "app.parent",
    columns: Object.freeze([Object.freeze({ name: "account_id", kind: "integer", nullable: false })]),
  }),
]);

test("relations are ordered so every dependency loads first", () => {
  const plan = prepareLoadPlan(SPECS, [
    { relation: "app.child", rows: [{ account_id: 1, note: "x" }] },
    { relation: "app.parent", rows: [{ account_id: 1 }] },
  ]);
  assert.deepEqual(plan.relations.map((relation) => relation.relation), ["app.parent", "app.child"]);
  assert.equal(plan.totalRows, 2);
});

test("a relation or column the contract does not declare cannot be written", () => {
  assert.equal(
    loaderCode(() => prepareLoadPlan(SPECS, [{ relation: "app.unknown", rows: [] }])),
    "loader_target_coverage",
  );
  assert.equal(
    loaderCode(() => prepareLoadPlan(SPECS, [{ relation: "app.parent", rows: [{ account_id: 1, smuggled: "x" }] }])),
    "loader_target_coverage",
  );
});

test("a dependency cycle or an unknown dependency is a contract defect, not a run-time guess", () => {
  const cyclic: readonly TargetRelationSpec[] = [
    { relation: "app.a", dependsOn: ["app.b"], columns: [{ name: "id", kind: "integer", nullable: false }] },
    { relation: "app.b", dependsOn: ["app.a"], columns: [{ name: "id", kind: "integer", nullable: false }] },
  ];
  assert.equal(loaderCode(() => prepareLoadPlan(cyclic, [])), "loader_contract_invalid");
  const dangling: readonly TargetRelationSpec[] = [
    { relation: "app.a", dependsOn: ["app.missing"], columns: [{ name: "id", kind: "integer", nullable: false }] },
  ];
  assert.equal(loaderCode(() => prepareLoadPlan(dangling, [])), "loader_contract_invalid");
});

test("the shipped contract is internally consistent and orders its real dependencies", () => {
  const plan = prepareLoadPlan(TARGET_RELATION_SPECS, []);
  assert.equal(plan.relations.length, TARGET_RELATION_SPECS.length);
  const order = plan.relations.map((relation) => relation.relation);
  assert.ok(
    order.indexOf("support.retention_policy_decisions") < order.indexOf("support.contact_messages"),
    "the policy row must load before the content that references it",
  );
});

test("identifiers are quoted, and a name that is not an identifier is refused", () => {
  assert.equal(quoteRelation("app.library_games"), '"app"."library_games"');
  assert.equal(loaderCode(() => quoteRelation('app.games"; drop table x --')), "loader_contract_invalid");
  assert.equal(loaderCode(() => assertUuid("not-a-uuid")), "loader_contract_invalid");
});

/* --- gates --------------------------------------------------------------- */

function evidence(overrides: Partial<GateEvidence> = {}): GateEvidence {
  return {
    readerRelationsRequested: 3,
    readerRelationsStaged: 3,
    exceptionCounts: { recency_exceptions: 0, completion_ordering_exceptions: 0 },
    unresolvedConflicts: 0,
    blockers: 0,
    sourceRelationsExpected: 3,
    sourceRelationsCovered: 3,
    targetRelationsPlanned: 4,
    targetRelationsContracted: 4,
    expectedSchemaFingerprint: SHA,
    actualSchemaFingerprint: SHA,
    snapshotDecisions: { cutover_observation: true },
    reconciliationMismatches: 0,
    ...overrides,
  };
}

test("a complete run passes every gate", () => {
  const report = evaluateGates(evidence());
  assert.equal(report.passed, true);
  assert.equal(report.failedGates.length, 0);
  assert.equal(report.outcomes.length, 9);
});

test("each blocking condition fails its own gate and refuses publication", () => {
  const cases: readonly [Partial<GateEvidence>, string][] = [
    [{ readerRelationsStaged: 2 }, "reader_stream_complete"],
    [{ exceptionCounts: { recency_exceptions: 1 } }, "transform_exceptions_empty"],
    [{ unresolvedConflicts: 2 }, "transform_conflicts_resolved"],
    [{ blockers: 1 }, "transform_blockers_empty"],
    [{ sourceRelationsCovered: 2 }, "source_coverage_complete"],
    [{ targetRelationsPlanned: 3 }, "target_coverage_complete"],
    [{ actualSchemaFingerprint: "b".repeat(64) }, "schema_fingerprint_match"],
    [{ snapshotDecisions: { cutover_observation: false } }, "snapshot_decisions_supplied"],
    [{ reconciliationMismatches: 1 }, "reconciliation_match"],
  ];
  for (const [override, gate] of cases) {
    const report = evaluateGates(evidence(override));
    assert.equal(report.passed, false, `${gate} should have failed`);
    assert.deepEqual(report.failedGates, [gate]);
    assert.equal(
      loaderCode(() => assertPublishable(report, { schema: SHA, manifest: SHA, transform: SHA, staging: SHA })),
      "loader_publication_refused",
    );
  }
});

test("a gate with no evidence at all fails rather than defaulting to success", () => {
  const empty = evaluateGates(
    evidence({ snapshotDecisions: {}, sourceRelationsExpected: 0, readerRelationsRequested: 0, expectedSchemaFingerprint: "" }),
  );
  assert.equal(empty.passed, false);
  assert.deepEqual([...empty.failedGates].sort(), [
    "reader_stream_complete",
    "schema_fingerprint_match",
    "snapshot_decisions_supplied",
    "source_coverage_complete",
  ]);
});

/* --- reconciliation ------------------------------------------------------ */

test("a swapped game identity changes the per-account checksum, not just a count", () => {
  const specs: readonly TargetRelationSpec[] = [
    {
      relation: "app.library_games",
      columns: [
        { name: "account_id", kind: "integer", nullable: false },
        { name: "game_id", kind: "integer", nullable: false },
        { name: "playtime_minutes", kind: "integer", nullable: true },
      ],
    },
  ];
  const straight = prepareLoadPlan(specs, [
    {
      relation: "app.library_games",
      rows: [
        { account_id: 1, game_id: 7, playtime_minutes: 90 },
        { account_id: 2, game_id: 8, playtime_minutes: 45 },
      ],
    },
  ]);
  const swapped = prepareLoadPlan(specs, [
    {
      relation: "app.library_games",
      rows: [
        { account_id: 1, game_id: 8, playtime_minutes: 90 },
        { account_id: 2, game_id: 7, playtime_minutes: 45 },
      ],
    },
  ]);
  const left = expectedReconciliation(straight, RUN);
  const right = expectedReconciliation(swapped, RUN);
  // Identical counts...
  assert.equal(left.totals.rows, right.totals.rows);
  // ...different digests, which is the whole point.
  assert.notEqual(left.sha256, right.sha256);
  const differences = compareReconciliations(left, right);
  assert.ok(differences.some((difference) => difference.kind === "account_checksum"));
  assert.ok(differences.every((difference) => difference.kind !== "row_count"));
});

test("a changed authored fact changes the checksum for exactly one account", () => {
  const specs: readonly TargetRelationSpec[] = [
    {
      relation: "app.game_state",
      columns: [
        { name: "account_id", kind: "integer", nullable: false },
        { name: "notes", kind: "text", nullable: true },
      ],
    },
  ];
  const original = prepareLoadPlan(specs, [
    { relation: "app.game_state", rows: [{ account_id: 1, notes: "mine" }, { account_id: 2, notes: "theirs" }] },
  ]);
  const edited = prepareLoadPlan(specs, [
    { relation: "app.game_state", rows: [{ account_id: 1, notes: "changed" }, { account_id: 2, notes: "theirs" }] },
  ]);
  const differences = compareReconciliations(expectedReconciliation(original, RUN), expectedReconciliation(edited, RUN));
  const accountDifferences = differences.filter((difference) => difference.kind === "account_checksum");
  assert.equal(accountDifferences.length, 1);
  assert.equal(accountDifferences[0].accountKey, "1");
});

test("reconciliation is independent of row order but not of row content", () => {
  const specs: readonly TargetRelationSpec[] = [
    {
      relation: "app.library_games",
      columns: [
        { name: "account_id", kind: "integer", nullable: false },
        { name: "game_id", kind: "integer", nullable: false },
      ],
    },
  ];
  const forward = prepareLoadPlan(specs, [
    { relation: "app.library_games", rows: [{ account_id: 1, game_id: 7 }, { account_id: 2, game_id: 8 }] },
  ]);
  const reversed = prepareLoadPlan(specs, [
    { relation: "app.library_games", rows: [{ account_id: 2, game_id: 8 }, { account_id: 1, game_id: 7 }] },
  ]);
  assert.equal(expectedReconciliation(forward, RUN).sha256, expectedReconciliation(reversed, RUN).sha256);
});

/* --- canonical helpers --------------------------------------------------- */

test("canonical JSON is key-order independent and refuses unsafe numbers and cycles", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalSha256({ a: [1, "x", null] }).length, 64);
  assert.equal(loaderCode(() => canonicalJson({ a: 1.5 })), "loader_contract_invalid");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(loaderCode(() => canonicalJson(cycle)), "loader_contract_invalid");
});

test("the ordered checksum depends on order and on length framing", () => {
  const first = new OrderedChecksum();
  first.update(["ab", "c"]);
  const second = new OrderedChecksum();
  second.update(["a", "bc"]);
  assert.notEqual(first.finish().sha256, second.finish().sha256);
  assert.equal(first.finish().rows, 1);
});
