import {
  BlockerCollector,
  SMALLINT_MAX,
  SMALLINT_MIN,
  boundedText,
  booleanValue,
  cell,
  instant,
  integerValue,
  jsonDocument,
  nullableCell,
  remainingAccountMap,
  remainingFailure,
  remainingRow,
  remainingRows,
  remainingRun,
  requireColumns,
  requireOrder,
  sha256Hex,
  uuidText,
  type AccountMapTargetRecord,
  type PgTimestamp,
  type RemainingBlocker,
  type RemainingRunIdentity,
} from "./remaining-shared.ts";

/**
 * Private support content: `contact_messages` and `feedback_submissions`.
 *
 * This is the most sensitive population in the migration — an email address, a
 * free-text message a person wrote, and an optional client context blob — and
 * the rules here are correspondingly narrow.
 *
 * 1. **Authorship is preserved or the row is withheld.** The target enforces
 *    `(account_id is null) = (source_account_public_id is null)`, so a
 *    submission whose author cannot be resolved cannot be written with a
 *    half-identity. An anonymous submission (source `user_id` NULL) loads with
 *    both columns NULL; a submission whose author is absent from the same-run
 *    account map is withheld with a blocker rather than being silently
 *    anonymised, which would destroy the deletion path for that person's own
 *    words.
 * 2. **Content is exact.** Message, subject, email and client context are
 *    carried verbatim; nothing is trimmed, summarised, redacted or re-encoded,
 *    and nothing is echoed into a diagnostic, a conflict or a count.
 * 3. **Retention stays root's open decision.** Both target relations reference
 *    `support.retention_policy_decisions`, and this transform emits that policy
 *    row as `pending` with a blocker. It does not decide how long a person's
 *    support message is kept.
 */

const CONTACT_RELATION = "contact_messages";
const FEEDBACK_RELATION = "feedback_submissions";

export const CONTACT_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "user_id",
  "enquiry_type",
  "email",
  "subject",
  "message",
  "dedupe_hash",
  "status",
  "created_at",
  "updated_at",
]);

export const FEEDBACK_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "user_id",
  "feedback_type",
  "message",
  "contact_allowed",
  "contact_email",
  "route",
  "app_area",
  "client_context",
  "dedupe_hash",
  "status",
  "created_at",
]);

/** The one policy key both target relations default to. */
export const SUPPORT_RETENTION_POLICY_KEY = "support-content-retention";

export type SupportRetentionPolicyRecord = Readonly<{
  policy_key: string;
  review_milestone: "M6" | "M7" | "M6-or-M7";
  decision_status: "pending";
  rationale: string;
  decided_at: null;
}>;

export type ContactMessageRecord = Readonly<{
  source_record_id: string;
  source_account_public_id: string | null;
  account_id: number | null;
  enquiry_type: number;
  email: string;
  subject: string;
  message: string;
  dedupe_hash: string | null;
  status_code: number;
  created_at: PgTimestamp;
  updated_at: PgTimestamp;
  retention_policy_key: string;
  source_snapshot_hash: string;
}>;

export type FeedbackSubmissionRecord = Readonly<{
  source_record_id: string;
  source_account_public_id: string | null;
  account_id: number | null;
  feedback_type: number;
  message: string;
  contact_allowed: boolean;
  contact_email: string | null;
  route: string | null;
  app_area: string | null;
  client_context: Readonly<{ text: string; utf8Bytes: number }>;
  dedupe_hash: string | null;
  status_code: number;
  created_at: PgTimestamp;
  /** The source has no separate update clock; see the note in the transform. */
  updated_at: PgTimestamp;
  retention_policy_key: string;
  source_snapshot_hash: string;
}>;

/**
 * A submission withheld because its author could not be resolved.
 *
 * It carries the identity needed to find the row again in the source, and
 * nothing a person wrote: no message, subject, email or client context. The
 * loader never writes these, and a nonempty array blocks final commit.
 */
export type WithheldSupportRecord = Readonly<{
  source_relation: "contact_messages" | "feedback_submissions";
  source_record_id: string;
  source_account_public_id: string;
  reason: "author_account_unmapped";
  source_snapshot_hash: string;
}>;

export type SupportOpsInput = Readonly<{
  runIdentity: RemainingRunIdentity;
  accountMap: readonly AccountMapTargetRecord[];
  contactMessages: readonly object[];
  feedbackSubmissions: readonly object[];
}>;

export type SupportOpsResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  retention_policy_decisions: readonly SupportRetentionPolicyRecord[];
  contact_messages: readonly ContactMessageRecord[];
  feedback_submissions: readonly FeedbackSubmissionRecord[];
  withheld: readonly WithheldSupportRecord[];
  blockers: readonly RemainingBlocker[];
  counts: Readonly<{
    contact_rows: number;
    feedback_rows: number;
    anonymous_contact_rows: number;
    anonymous_feedback_rows: number;
    withheld_rows: number;
  }>;
}>;

const RETENTION_RATIONALE =
  "How long a person's support message and email address are kept after cutover is not a migration decision. " +
  "The content is migrated exactly so nothing is lost before that decision is made, and both relations reference " +
  "this policy key so a later decision applies to every row at once.";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function transformSupportOpsBatch(input: SupportOpsInput): SupportOpsResult {
  if (typeof input !== "object" || input === null) remainingFailure("remaining_input_invalid", "support_ops_input");
  const run = remainingRun(input.runIdentity);
  const accounts = remainingAccountMap(input.accountMap, run);
  const blockers = new BlockerCollector();

  const contacts: ContactMessageRecord[] = [];
  const feedback: FeedbackSubmissionRecord[] = [];
  const withheld: WithheldSupportRecord[] = [];
  const seenIds = new Set<string>();
  let anonymousContacts = 0;
  let anonymousFeedback = 0;

  /**
   * Resolve the author, or say why the row cannot be written.
   *
   * `null` author (anonymous) is a real, supported case. An author who is not
   * in the map is not: writing `source_account_public_id` with a NULL
   * `account_id` violates the target CHECK, and writing both as NULL would
   * turn a named person's message into an anonymous one and detach it from
   * their deletion request.
   */
  function resolveAuthor(
    sourceUserId: string | null,
    relation: "contact_messages" | "feedback_submissions",
  ): { accountId: number | null; publicId: string | null } | "unmapped" {
    if (sourceUserId === null) return { accountId: null, publicId: null };
    const parsed = uuidText(sourceUserId, relation, "user_id") as { original: string; canonical: string };
    try {
      return { accountId: accounts.lookup(parsed.original), publicId: parsed.original };
    } catch {
      return "unmapped";
    }
  }

  for (const raw of remainingRows(input.contactMessages, CONTACT_RELATION)) {
    const row = remainingRow(raw, CONTACT_RELATION, run);
    requireColumns(row, CONTACT_SOURCE_COLUMNS, CONTACT_RELATION);
    const recordId = uuidText(cell(row, "id", CONTACT_RELATION), CONTACT_RELATION, "id") as {
      original: string;
      canonical: string;
    };
    if (seenIds.has(`c:${recordId.canonical}`)) remainingFailure("remaining_duplicate_row", CONTACT_RELATION, "id");
    seenIds.add(`c:${recordId.canonical}`);

    const author = resolveAuthor(nullableCell(row, "user_id", CONTACT_RELATION), CONTACT_RELATION);
    const createdAt = instant(cell(row, "created_at", CONTACT_RELATION), CONTACT_RELATION, "created_at", true) as PgTimestamp;
    const updatedAt = instant(cell(row, "updated_at", CONTACT_RELATION), CONTACT_RELATION, "updated_at", true) as PgTimestamp;
    requireOrder(createdAt, updatedAt, CONTACT_RELATION, "updated_at");

    if (author === "unmapped") {
      withheld.push(
        Object.freeze({
          source_relation: "contact_messages" as const,
          source_record_id: recordId.original,
          source_account_public_id: cell(row, "user_id", CONTACT_RELATION),
          reason: "author_account_unmapped" as const,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      blockers.record(
        "support_author_unmapped",
        CONTACT_RELATION,
        "user_id",
        "UNRESOLVED for root: this support message names an author who is not in the same-run account map. support.contact_messages enforces (account_id is null) = (source_account_public_id is null), so the row cannot be written with a half-identity; writing both as NULL would turn a named person's message into an anonymous one and detach it from their own deletion request. The row is withheld with its identifiers only -- no message, subject or email is carried into the withheld record -- and blocks final commit until root decides whether the account is genuinely absent from the export or the map is incomplete.",
      );
      continue;
    }
    if (author.accountId === null) anonymousContacts += 1;

    contacts.push(
      Object.freeze({
        source_record_id: recordId.original,
        source_account_public_id: author.publicId,
        account_id: author.accountId,
        enquiry_type: integerValue(cell(row, "enquiry_type", CONTACT_RELATION), CONTACT_RELATION, "enquiry_type", {
          min: BigInt(0),
          max: BigInt(5),
        }) as number,
        email: boundedText(cell(row, "email", CONTACT_RELATION), CONTACT_RELATION, "email", {
          min: 1,
          max: 320,
        }) as string,
        subject: boundedText(cell(row, "subject", CONTACT_RELATION), CONTACT_RELATION, "subject", {
          min: 3,
          max: 150,
          measure: "btrim",
        }) as string,
        message: boundedText(cell(row, "message", CONTACT_RELATION), CONTACT_RELATION, "message", {
          min: 10,
          max: 5000,
          measure: "btrim",
        }) as string,
        // `character(64)` in the source is blank-padded; the target requires
        // exactly 64 lowercase hex characters, so a value that is not one
        // fails closed rather than being trimmed or lowercased into a
        // different digest.
        dedupe_hash: sha256Hex(nullableCell(row, "dedupe_hash", CONTACT_RELATION), CONTACT_RELATION, "dedupe_hash", false),
        status_code: integerValue(cell(row, "status", CONTACT_RELATION), CONTACT_RELATION, "status", {
          min: SMALLINT_MIN,
          max: SMALLINT_MAX,
        }) as number,
        created_at: createdAt,
        updated_at: updatedAt,
        retention_policy_key: SUPPORT_RETENTION_POLICY_KEY,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  for (const raw of remainingRows(input.feedbackSubmissions, FEEDBACK_RELATION)) {
    const row = remainingRow(raw, FEEDBACK_RELATION, run);
    requireColumns(row, FEEDBACK_SOURCE_COLUMNS, FEEDBACK_RELATION);
    const recordId = uuidText(cell(row, "id", FEEDBACK_RELATION), FEEDBACK_RELATION, "id") as {
      original: string;
      canonical: string;
    };
    if (seenIds.has(`f:${recordId.canonical}`)) remainingFailure("remaining_duplicate_row", FEEDBACK_RELATION, "id");
    seenIds.add(`f:${recordId.canonical}`);

    const author = resolveAuthor(nullableCell(row, "user_id", FEEDBACK_RELATION), FEEDBACK_RELATION);
    const createdAt = instant(cell(row, "created_at", FEEDBACK_RELATION), FEEDBACK_RELATION, "created_at", true) as PgTimestamp;

    if (author === "unmapped") {
      withheld.push(
        Object.freeze({
          source_relation: "feedback_submissions" as const,
          source_record_id: recordId.original,
          source_account_public_id: cell(row, "user_id", FEEDBACK_RELATION),
          reason: "author_account_unmapped" as const,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      blockers.record(
        "support_author_unmapped",
        FEEDBACK_RELATION,
        "user_id",
        "UNRESOLVED for root: this feedback submission names an author who is not in the same-run account map. support.feedback_submissions enforces (account_id is null) = (source_account_public_id is null), so the row is withheld with its identifiers only rather than being anonymised, which would detach a named person's words from their deletion request.",
      );
      continue;
    }
    if (author.accountId === null) anonymousFeedback += 1;

    const contactAllowed = booleanValue(cell(row, "contact_allowed", FEEDBACK_RELATION), FEEDBACK_RELATION, "contact_allowed");
    const contactEmail = boundedText(
      nullableCell(row, "contact_email", FEEDBACK_RELATION),
      FEEDBACK_RELATION,
      "contact_email",
      { min: 1, max: 320, nullable: true },
    );
    if (!contactAllowed && contactEmail !== null) {
      // Both the source and the target enforce this. A contact address kept
      // beside a withdrawn permission is exactly the combination the CHECK
      // exists to forbid, so it fails closed rather than dropping either fact.
      remainingFailure("remaining_order_conflict", FEEDBACK_RELATION, "contact_email");
    }

    // The target's client_context is NOT NULL with a '{}' default and an
    // object check. A source NULL means "no client context was recorded",
    // which is what the empty object means; the mapping is stated rather than
    // implied, and a non-object document fails closed.
    const rawContext = nullableCell(row, "client_context", FEEDBACK_RELATION);
    const clientContext =
      rawContext === null
        ? Object.freeze({ text: "{}", utf8Bytes: 2 })
        : (jsonDocument(rawContext, FEEDBACK_RELATION, "client_context", {
            topLevel: "object",
            maxBytes: 4096,
          }) as Readonly<{ text: string; utf8Bytes: number }>);

    feedback.push(
      Object.freeze({
        source_record_id: recordId.original,
        source_account_public_id: author.publicId,
        account_id: author.accountId,
        feedback_type: integerValue(cell(row, "feedback_type", FEEDBACK_RELATION), FEEDBACK_RELATION, "feedback_type", {
          min: BigInt(0),
          max: BigInt(1),
        }) as number,
        message: boundedText(cell(row, "message", FEEDBACK_RELATION), FEEDBACK_RELATION, "message", {
          min: 10,
          max: 2000,
          measure: "btrim",
        }) as string,
        contact_allowed: contactAllowed,
        contact_email: contactEmail,
        route: boundedText(nullableCell(row, "route", FEEDBACK_RELATION), FEEDBACK_RELATION, "route", {
          min: 1,
          max: 300,
          nullable: true,
        }),
        app_area: boundedText(nullableCell(row, "app_area", FEEDBACK_RELATION), FEEDBACK_RELATION, "app_area", {
          min: 1,
          max: 80,
          nullable: true,
        }),
        client_context: clientContext,
        dedupe_hash: sha256Hex(nullableCell(row, "dedupe_hash", FEEDBACK_RELATION), FEEDBACK_RELATION, "dedupe_hash", false),
        status_code: integerValue(cell(row, "status", FEEDBACK_RELATION), FEEDBACK_RELATION, "status", {
          min: SMALLINT_MIN,
          max: SMALLINT_MAX,
        }) as number,
        created_at: createdAt,
        // The source relation has no update clock at all. The target requires
        // one, so the row's own created_at is reused -- a real source instant
        // moved into a differently-named column, never a migration-time clock.
        updated_at: createdAt,
        retention_policy_key: SUPPORT_RETENTION_POLICY_KEY,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  if (contacts.length > 0 || feedback.length > 0) {
    blockers.record(
      "support_retention_policy_pending",
      "support.retention_policy_decisions",
      "decision_status",
      "UNRESOLVED for root (M6/M7): support content is migrated exactly, but how long a person's message and email address are retained after cutover is a policy decision, not a migration decision. The policy row is emitted as 'pending' with no decided_at, which is the target's own representation of an undecided policy, and every migrated row references it so one later decision applies to all of them.",
      contacts.length + feedback.length,
    );
  }

  contacts.sort((left, right) => compareText(left.source_record_id, right.source_record_id));
  feedback.sort((left, right) => compareText(left.source_record_id, right.source_record_id));
  withheld.sort(
    (left, right) =>
      compareText(left.source_relation, right.source_relation) ||
      compareText(left.source_record_id, right.source_record_id),
  );

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    retention_policy_decisions: Object.freeze([
      Object.freeze({
        policy_key: SUPPORT_RETENTION_POLICY_KEY,
        review_milestone: "M6-or-M7" as const,
        decision_status: "pending" as const,
        rationale: RETENTION_RATIONALE,
        decided_at: null,
      }),
    ]),
    contact_messages: Object.freeze(contacts),
    feedback_submissions: Object.freeze(feedback),
    withheld: Object.freeze(withheld),
    blockers: blockers.toRecords(),
    counts: Object.freeze({
      contact_rows: contacts.length,
      feedback_rows: feedback.length,
      anonymous_contact_rows: anonymousContacts,
      anonymous_feedback_rows: anonymousFeedback,
      withheld_rows: withheld.length,
    }),
  });
}
