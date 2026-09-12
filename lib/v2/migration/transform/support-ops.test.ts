import assert from "node:assert/strict";
import test from "node:test";
import { RemainingTransformError } from "./remaining-shared.ts";
import { SUPPORT_RETENTION_POLICY_KEY, transformSupportOpsBatch, type SupportOpsInput } from "./support-ops.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

const SNAPSHOT = "d".repeat(64);
const RUN = Object.freeze({ runId: "support-test-run", snapshotHash: SNAPSHOT });
const ACCOUNT_A = "60000000-0000-4000-8000-00000000000a";
const ABSENT_ACCOUNT = "60000000-0000-4000-8000-0000000000ff";
const HASH = "a".repeat(64);

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

function input(overrides: Partial<SupportOpsInput> = {}): SupportOpsInput {
  return {
    runIdentity: RUN,
    accountMap: ACCOUNT_MAP,
    contactMessages: [],
    feedbackSubmissions: [],
    ...overrides,
  };
}

function contactRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    user_id: ACCOUNT_A,
    enquiry_type: "2",
    email: "person@example.test",
    subject: "  A subject line  ",
    message: "  This is a real support message with enough characters.  ",
    dedupe_hash: HASH,
    status: "0",
    created_at: "2026-05-01 10:00:00+00",
    updated_at: "2026-05-02 10:00:00+00",
    ...overrides,
  };
}

function feedbackRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "80000000-0000-4000-8000-000000000001",
    user_id: null,
    feedback_type: "1",
    message: "The vault picker felt slow on my phone today.",
    contact_allowed: "f",
    contact_email: null,
    route: "/vault",
    app_area: "vault",
    client_context: '{"viewport":"390x844"}',
    dedupe_hash: HASH,
    status: "0",
    created_at: "2026-06-01 09:00:00+00",
    ...overrides,
  };
}

function failureCode(execute: () => unknown): string {
  try {
    execute();
  } catch (error) {
    assert.ok(error instanceof RemainingTransformError, `expected RemainingTransformError, received ${String(error)}`);
    return error.remainingCode;
  }
  assert.fail("expected a RemainingTransformError");
}

test("a support message keeps its author, its exact text and its own instants", () => {
  const result = transformSupportOpsBatch(input({ contactMessages: [contactRow()] }));
  const row = result.contact_messages[0];
  assert.equal(row.account_id, 1);
  assert.equal(row.source_account_public_id, ACCOUNT_A);
  assert.equal(row.enquiry_type, 2);
  assert.equal(row.email, "person@example.test");
  // Bounds are measured on the trimmed text; the STORED value stays verbatim.
  assert.equal(row.subject, "  A subject line  ");
  assert.equal(row.message, "  This is a real support message with enough characters.  ");
  assert.equal(row.dedupe_hash, HASH);
  assert.equal(row.created_at.canonicalUtc, "2026-05-01T10:00:00.000000Z");
  assert.equal(row.updated_at.canonicalUtc, "2026-05-02T10:00:00.000000Z");
  assert.equal(row.retention_policy_key, SUPPORT_RETENTION_POLICY_KEY);
});

test("an anonymous submission loads with both identity columns NULL", () => {
  const result = transformSupportOpsBatch(input({ contactMessages: [contactRow({ user_id: null })] }));
  assert.equal(result.contact_messages[0].account_id, null);
  assert.equal(result.contact_messages[0].source_account_public_id, null);
  assert.equal(result.counts.anonymous_contact_rows, 1);
  assert.equal(result.withheld.length, 0);
});

test("a submission whose author is not in the map is withheld, never anonymised", () => {
  const result = transformSupportOpsBatch(
    input({
      contactMessages: [contactRow({ user_id: ABSENT_ACCOUNT })],
      feedbackSubmissions: [feedbackRow({ user_id: ABSENT_ACCOUNT })],
    }),
  );
  assert.equal(result.contact_messages.length, 0);
  assert.equal(result.feedback_submissions.length, 0);
  assert.equal(result.withheld.length, 2);
  assert.equal(result.withheld[0].reason, "author_account_unmapped");
  assert.equal(result.withheld[0].source_account_public_id, ABSENT_ACCOUNT);
  // The withheld record carries identifiers only -- nothing the person wrote.
  assert.equal(Object.hasOwn(result.withheld[0], "message"), false);
  assert.equal(Object.hasOwn(result.withheld[0], "email"), false);
  const blocker = result.blockers.find((entry) => entry.code === "support_author_unmapped");
  assert.ok(blocker);
  assert.equal(blocker.count, 1);
});

test("the retention policy is emitted pending, with a blocker, and never decided here", () => {
  const result = transformSupportOpsBatch(input({ contactMessages: [contactRow()] }));
  assert.equal(result.retention_policy_decisions.length, 1);
  const policy = result.retention_policy_decisions[0];
  assert.equal(policy.policy_key, SUPPORT_RETENTION_POLICY_KEY);
  assert.equal(policy.decision_status, "pending");
  assert.equal(policy.decided_at, null);
  assert.ok(result.blockers.some((entry) => entry.code === "support_retention_policy_pending"));
});

test("feedback carries its client context exactly and defaults a NULL context to an empty object", () => {
  const withContext = transformSupportOpsBatch(input({ feedbackSubmissions: [feedbackRow()] }));
  assert.equal(withContext.feedback_submissions[0].client_context.text, '{"viewport":"390x844"}');
  const withoutContext = transformSupportOpsBatch(
    input({ feedbackSubmissions: [feedbackRow({ client_context: null })] }),
  );
  assert.equal(withoutContext.feedback_submissions[0].client_context.text, "{}");
});

test("a non-object client context fails closed rather than being wrapped", () => {
  assert.equal(
    failureCode(() =>
      transformSupportOpsBatch(input({ feedbackSubmissions: [feedbackRow({ client_context: "[1,2,3]" })] })),
    ),
    "remaining_json_shape_conflict",
  );
});

test("feedback reuses its own created_at as updated_at, never a migration clock", () => {
  const result = transformSupportOpsBatch(input({ feedbackSubmissions: [feedbackRow()] }));
  const row = result.feedback_submissions[0];
  assert.equal(row.created_at.canonicalUtc, "2026-06-01T09:00:00.000000Z");
  assert.equal(row.updated_at.canonicalUtc, row.created_at.canonicalUtc);
});

test("a contact address kept beside a withdrawn permission fails closed", () => {
  assert.equal(
    failureCode(() =>
      transformSupportOpsBatch(
        input({
          feedbackSubmissions: [feedbackRow({ contact_allowed: "f", contact_email: "person@example.test" })],
        }),
      ),
    ),
    "remaining_order_conflict",
  );
  // The permitted pairing still loads.
  const allowed = transformSupportOpsBatch(
    input({ feedbackSubmissions: [feedbackRow({ contact_allowed: "t", contact_email: "person@example.test" })] }),
  );
  assert.equal(allowed.feedback_submissions[0].contact_email, "person@example.test");
});

test("a dedupe hash that is not 64 lowercase hex characters fails closed rather than being reshaped", () => {
  assert.equal(
    failureCode(() => transformSupportOpsBatch(input({ contactMessages: [contactRow({ dedupe_hash: HASH.toUpperCase() })] }))),
    "remaining_text_bounds",
  );
  // A genuinely absent hash is allowed: the target column is nullable.
  const absent = transformSupportOpsBatch(input({ contactMessages: [contactRow({ dedupe_hash: null })] }));
  assert.equal(absent.contact_messages[0].dedupe_hash, null);
});

test("content outside the target's own bounds fails closed", () => {
  assert.equal(
    failureCode(() => transformSupportOpsBatch(input({ contactMessages: [contactRow({ message: "  short  " })] }))),
    "remaining_text_bounds",
  );
  assert.equal(
    failureCode(() => transformSupportOpsBatch(input({ contactMessages: [contactRow({ subject: " a " })] }))),
    "remaining_text_bounds",
  );
  assert.equal(
    failureCode(() =>
      transformSupportOpsBatch(input({ contactMessages: [contactRow({ email: `${"x".repeat(320)}@example.test` })] })),
    ),
    "remaining_text_bounds",
  );
});

test("an update instant before the creation instant is a reported order conflict", () => {
  assert.equal(
    failureCode(() =>
      transformSupportOpsBatch(input({ contactMessages: [contactRow({ updated_at: "2026-04-01 00:00:00+00" })] })),
    ),
    "remaining_order_conflict",
  );
});

test("a duplicate source record id fails explicitly", () => {
  assert.equal(
    failureCode(() => transformSupportOpsBatch(input({ contactMessages: [contactRow(), contactRow()] }))),
    "remaining_duplicate_row",
  );
});

test("no diagnostic or blocker carries a private value", () => {
  const result = transformSupportOpsBatch(
    input({ contactMessages: [contactRow({ user_id: ABSENT_ACCOUNT })], feedbackSubmissions: [feedbackRow()] }),
  );
  for (const entry of result.blockers) {
    assert.doesNotMatch(entry.decision, /person@example\.test/);
    assert.doesNotMatch(entry.decision, /real support message/);
    assert.doesNotMatch(entry.decision, /[0-9a-f]{8}-[0-9a-f]{4}-4/);
  }
});
