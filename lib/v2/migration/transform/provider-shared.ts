import { ExportError } from "../shared/redaction.ts";
import {
  CatalogueValueError,
  encodeJsonStringArray,
  inspectJsonDocument,
  parsePgTextArray,
  pgBtrim,
  pgLength,
  utf8ByteLength,
} from "./catalogue-values.ts";
import { parseCivilDate, parsePgInteger, parsePgTimestamptz, ScalarError, type CivilDate, type PgTimestamp } from "./scalars.ts";

/**
 * Shared vocabulary for the M3-H provider/legacy-catalogue evidence domain:
 * duration provider estimates/aliases/reviews/import-runs, quarantine and
 * ingest-queue/duration-job archive evidence, seed-run provenance, and the
 * guest catalogue pool.
 *
 * Every relation here is either shared catalogue evidence (no account key) or
 * a bounded operational archive; none of it is personal library data.  This
 * module holds only what every one of those transforms needs: the run
 * identity, the error type, and generic scalar/text/enum readers. It does not
 * build the game or account map — those are consumed through the reviewed
 * `games.ts` and `library-shared.ts` interfaces respectively, exactly as
 * `catalogue.ts` and the M3-G modules already do.
 *
 * This module is pure: no filesystem, database, network or clock access.
 */

/** COPY cells stay `string | null` until a reviewed conversion consumes them. */
export type ProviderCell = string | null;

export type ProviderErrorCode =
  | "provider_run_invalid"
  | "provider_mixed_run_identity"
  | "provider_input_invalid"
  | "provider_row_limit"
  | "provider_duplicate_row"
  | "provider_invalid_uuid"
  | "provider_invalid_timestamp"
  | "provider_invalid_date"
  | "provider_invalid_integer"
  | "provider_invalid_enum"
  | "provider_text_bounds"
  | "provider_json_shape_conflict"
  | "provider_order_conflict"
  | "provider_game_unmapped"
  | "provider_game_map_invalid"
  | "provider_account_unmapped"
  | "provider_account_map_invalid"
  | "provider_physical_gap";

const PROVIDER_MESSAGES: Readonly<Record<ProviderErrorCode, string>> = {
  provider_run_invalid: "The provider transform run identity is invalid.",
  provider_mixed_run_identity: "Provider rows do not belong to one explicit migration run.",
  provider_input_invalid: "The provider transform input shape is invalid.",
  provider_row_limit: "The provider transform row bound was exceeded.",
  provider_duplicate_row: "The source contains duplicate rows for one natural key.",
  provider_invalid_uuid: "A source identity UUID is invalid.",
  provider_invalid_timestamp: "A source timestamp is invalid, unsupported, or absent where the source forbids null.",
  provider_invalid_date: "A source civil date is invalid or absent where the source forbids null.",
  provider_invalid_integer: "A source integer is malformed or outside the destination range.",
  provider_invalid_enum: "A source code is outside the destination vocabulary.",
  provider_text_bounds: "A source text value cannot satisfy the target bounds without loss.",
  provider_json_shape_conflict: "A source JSON or array value is not the shape the destination column requires.",
  provider_order_conflict: "Source instants violate the target ordering check.",
  provider_game_unmapped: "A source AppID has no entry in the supplied same-run game map.",
  provider_game_map_invalid: "The supplied game map is not a consistent same-run map.",
  provider_account_unmapped: "A source account reference is absent from the supplied same-run account map.",
  provider_account_map_invalid: "The supplied account map is not a consistent same-run map.",
  provider_physical_gap: "The current target contract cannot represent this source fact safely.",
};

export type ProviderDiagnostic = Readonly<{
  code: ProviderErrorCode;
  relation: string;
  field: string | null;
  count: number;
}>;

/**
 * A provider error carries a stable code, the source relation/field and a
 * count. It never carries a title, a URL, a payload, an error message or an
 * AppID/UUID value.
 */
export class ProviderTransformError extends ExportError {
  readonly providerCode: ProviderErrorCode;
  readonly diagnostics: readonly ProviderDiagnostic[];

  constructor(code: ProviderErrorCode, diagnostic: ProviderDiagnostic) {
    super(code, PROVIDER_MESSAGES[code], {
      relation: diagnostic.relation,
      field: diagnostic.field,
      count: diagnostic.count,
    });
    this.name = "ProviderTransformError";
    this.providerCode = code;
    this.diagnostics = Object.freeze([Object.freeze({ ...diagnostic })]);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), diagnostics: this.diagnostics };
  }
}

export function providerFailure(
  code: ProviderErrorCode,
  relation: string,
  field: string | null = null,
  count = 1,
): never {
  throw new ProviderTransformError(code, { code, relation, field, count });
}

const RUN_ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_TEXT = /^[0-9a-f]{64}$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ProviderRunIdentity = Readonly<{ runId: string; snapshotHash: string }>;

export function validateProviderRunIdentity(value: unknown): ProviderRunIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    providerFailure("provider_run_invalid", "run_identity");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.runId !== "string" || typeof candidate.snapshotHash !== "string") {
    providerFailure("provider_run_invalid", "run_identity");
  }
  if (!RUN_ID_TEXT.test(candidate.runId) || !SHA256_TEXT.test(candidate.snapshotHash)) {
    providerFailure("provider_run_invalid", "run_identity");
  }
  return Object.freeze({ runId: candidate.runId, snapshotHash: candidate.snapshotHash });
}

export function asObject(value: unknown, relation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    providerFailure("provider_input_invalid", relation);
  }
  return value as Record<string, unknown>;
}

export function ensureArray(value: unknown, relation: string): readonly object[] {
  if (!Array.isArray(value)) providerFailure("provider_input_invalid", relation);
  return value as readonly object[];
}

export function checkRowLimit(rows: readonly unknown[], relation: string, maxRows: number): void {
  if (rows.length > maxRows) providerFailure("provider_row_limit", relation);
}

/** Read a required source column, distinguishing an absent column from an explicit NULL. */
export function cell(row: Record<string, unknown>, key: string, relation: string): string | null {
  if (!(key in row)) providerFailure("provider_input_invalid", relation, key);
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") providerFailure("provider_input_invalid", relation, key);
  return value;
}

export function checkRowRunIdentity(row: Record<string, unknown>, run: ProviderRunIdentity, relation: string): void {
  const rowRunId = row.runId ?? row.run_id;
  const rowSnapshotHash = row.snapshotHash ?? row.snapshot_hash;
  if (
    (rowRunId !== undefined && typeof rowRunId !== "string") ||
    (rowSnapshotHash !== undefined && typeof rowSnapshotHash !== "string")
  ) {
    providerFailure("provider_mixed_run_identity", relation);
  }
  if (
    (rowRunId !== undefined && rowRunId !== run.runId) ||
    (rowSnapshotHash !== undefined && rowSnapshotHash !== run.snapshotHash)
  ) {
    providerFailure("provider_mixed_run_identity", relation);
  }
}

export function canonicalUuidText(value: string | null, field: string, relation: string, required: boolean): string | null {
  if (value === null) {
    if (required) providerFailure("provider_invalid_uuid", relation, field);
    return null;
  }
  const lower = value.toLowerCase();
  if (!UUID_TEXT.test(lower)) providerFailure("provider_invalid_uuid", relation, field);
  return lower;
}

export function timestamp(
  value: string | null,
  field: string,
  relation: string,
  required: boolean,
): PgTimestamp | null {
  if (value === null) {
    if (required) providerFailure("provider_invalid_timestamp", relation, field);
    return null;
  }
  try {
    return parsePgTimestamptz(value, { field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof ScalarError) providerFailure("provider_invalid_timestamp", relation, field);
    throw error;
  }
}

export function civilDate(value: string | null, field: string, relation: string): CivilDate | null {
  try {
    return parseCivilDate(value, `${relation}.${field}`);
  } catch (error) {
    if (error instanceof ScalarError) providerFailure("provider_invalid_date", relation, field);
    throw error;
  }
}

export type IntegerBounds = { min: bigint; max: bigint };

export function integerText(
  value: string | null,
  field: string,
  relation: string,
  bounds: IntegerBounds,
): bigint | null {
  try {
    return parsePgInteger(value, { minInclusive: bounds.min, maxInclusive: bounds.max, field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof ScalarError) providerFailure("provider_invalid_integer", relation, field);
    throw error;
  }
}

export const ZERO = BigInt(0);
export const ONE = BigInt(1);
export const TARGET_INTEGER_MAX = BigInt("2147483647");
export const TARGET_SMALLINT_MAX = BigInt("32767");
export const STEAM_APP_ID_MIN = BigInt(1);
export const STEAM_APP_ID_MAX = BigInt("4294967295");

export function requiredIntegerNumber(
  value: string | null,
  field: string,
  relation: string,
  bounds: IntegerBounds,
): number {
  const parsed = integerText(value, field, relation, bounds);
  if (parsed === null) providerFailure("provider_invalid_integer", relation, field);
  return Number(parsed);
}

export function optionalIntegerNumber(
  value: string | null,
  field: string,
  relation: string,
  bounds: IntegerBounds,
): number | null {
  const parsed = integerText(value, field, relation, bounds);
  return parsed === null ? null : Number(parsed);
}

/** A source Steam AppID cell as exact canonical decimal text, in the M1 unsigned-32-bit range. */
export function steamAppId(value: string | null, field: string, relation: string): string {
  if (value === null) providerFailure("provider_input_invalid", relation, field);
  const parsed = integerText(value, field, relation, { min: STEAM_APP_ID_MIN, max: STEAM_APP_ID_MAX });
  if (parsed === null) providerFailure("provider_input_invalid", relation, field);
  return parsed.toString(10);
}

export type TextBounds = { nullable: boolean; maxLength: number; requireTrimmedContent: boolean };

export function boundedText(value: string | null, field: string, relation: string, bounds: TextBounds): string | null {
  if (value === null) {
    if (bounds.nullable) return null;
    providerFailure("provider_text_bounds", relation, field);
  }
  if (bounds.requireTrimmedContent) {
    const trimmed = pgLength(pgBtrim(value));
    if (trimmed < 1 || trimmed > bounds.maxLength) providerFailure("provider_text_bounds", relation, field);
    return value;
  }
  if (pgLength(value) > bounds.maxLength) providerFailure("provider_text_bounds", relation, field);
  return value;
}

export function enumCell<T extends string>(
  value: string | null,
  field: string,
  relation: string,
  allowed: readonly T[],
  required: boolean,
): T | null {
  if (value === null) {
    if (required) providerFailure("provider_invalid_enum", relation, field);
    return null;
  }
  if (!(allowed as readonly string[]).includes(value)) providerFailure("provider_invalid_enum", relation, field);
  return value as T;
}

/**
 * PostgreSQL `text[]` COPY output, decoded to an ordered element array and
 * the JSON-array text the target `jsonb` column stores.
 *
 * Reuses `catalogue-values.ts`'s array parser: the same one-dimensional
 * quoted/escaped/NULL-element grammar `catalogue.ts` already relies on for
 * `genres`/`categories`.
 */
export function pgTextArrayAsJson(
  value: string | null,
  field: string,
  relation: string,
): { text: string; utf8Bytes: number; elements: readonly (string | null)[] } {
  if (value === null) providerFailure("provider_json_shape_conflict", relation, field);
  let parsed;
  try {
    parsed = parsePgTextArray(value, { field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof CatalogueValueError) providerFailure("provider_json_shape_conflict", relation, field);
    throw error;
  }
  if (!parsed) providerFailure("provider_json_shape_conflict", relation, field);
  const text = encodeJsonStringArray(parsed.elements);
  return { text, utf8Bytes: utf8ByteLength(text), elements: parsed.elements };
}

/**
 * The review-decision record shape shared by every classification/quarantine
 * consumer of `catalog.review_decisions`.
 *
 * `catalogue.ts` defines its own narrower `CatalogueReviewDecisionTargetRecord`
 * for the single `catalogue_type` row it emits; this wider shape covers the
 * `quarantine` and `duration` decision kinds this domain adds, including the
 * optional evidence columns those kinds use that `catalogue_type` never does.
 */
export type ReviewDecisionTargetRecord = Readonly<{
  game_id: number | null;
  steam_app_id: string;
  decision_kind: "quarantine" | "duration";
  source_relation: "catalog_game_quarantine" | "catalog_duration_reviews";
  source_record_key: string;
  source: string;
  precedence_rank: number;
  decision_status:
    | "pending"
    | "excluded"
    | "allowed"
    | "approved"
    | "rejected"
    | "needs_review"
    | "retained"
    | "unresolved";
  name: string | null;
  steam_type: string | null;
  matched_rule: string | null;
  reason: string | null;
  /** JSON array text re-encoded from the source `text[]`, order preserved. */
  genres: string | null;
  categories: string | null;
  /** The source array elements, so the encoding stays checkable. */
  genres_elements: readonly (string | null)[] | null;
  categories_elements: readonly (string | null)[] | null;
  response_text: string | null;
  response_kind: "hltb_url" | "note" | null;
  source_url: string | null;
  reviewer_account_id: number | null;
  reviewed_at: PgTimestamp | null;
  review_notes: string | null;
  duration_manual_override: false;
  source_payload: Readonly<{ text: string; utf8Bytes: number }>;
  created_at: PgTimestamp;
  updated_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

/**
 * The provider literal for a source relation that records no provider at all.
 *
 * `catalog_ingest_queue` and `game_duration_jobs` are provider-agnostic: one
 * row per AppID, with the worker choosing which provider to call at run time
 * (`lib/duration-worker.ts` tries more than one). `catalog.provider_state` and
 * `catalog.appid_terminal_rejections` both require a provider, so the honest
 * value is the schema's own `unknown` rather than a provider attributed from
 * which worker happens to run today.
 */
export const UNATTRIBUTED_PROVIDER = "unknown";

/**
 * Durable provider lifecycle state. This mirrors the physical
 * `catalog.provider_state` relation and is shared by catalogue tags and the
 * legacy provider queues. It contains no runnable job or lease token.
 */
export type ProviderStateTargetRecord = Readonly<{
  game_id: number;
  provider: string;
  evidence_kind: "metadata" | "tags" | "duration" | "deck" | "offer";
  status: "pending" | "processing" | "ready" | "failed" | "no_match" | "review_required" | "unknown";
  failure_count: number;
  next_attempt_at: PgTimestamp | null;
  processing_started_at: PgTimestamp | null;
  fetched_at: PgTimestamp | null;
  last_error_code: string | null;
  last_error: string | null;
  source_snapshot_hash: string;
  updated_at: PgTimestamp;
}>;

/** `catalog.provider_state.last_error` is bounded at 2000 characters. */
export const PROVIDER_STATE_ERROR_MAX = 2000;
/** `catalog.appid_terminal_rejections.reason` is bounded at 5000, NOT NULL. */
export const TERMINAL_REASON_MAX = 5000;

/**
 * The NOT NULL `reason` on a terminal verdict.
 *
 * The source text is used verbatim when there is one. When the source recorded
 * no text at all, the fallback states the source facts that produced the
 * verdict (relation, status, attempt count) rather than inventing a cause;
 * a caller must compose it from values it already read.
 *
 * Neither path truncates: an over-long source reason fails closed, because
 * this is the copy that outlives the 30-day archive and a silently shortened
 * rejection reason is exactly the kind of loss this column exists to prevent.
 */
export function terminalReason(
  sourceText: string | null,
  fallback: string,
  relation: string,
  field: string,
): string {
  const text = sourceText === null || sourceText.trim().length === 0 ? fallback : sourceText;
  if (text.length > TERMINAL_REASON_MAX) providerFailure("provider_text_bounds", relation, field);
  return text;
}

/**
 * A terminal AppID verdict remains durable even when no catalogue identity
 * exists. This mirrors `catalog.appid_terminal_rejections`; it is evidence,
 * never a queue instruction.
 */
export type AppIdTerminalRejectionTargetRecord = Readonly<{
  steam_app_id: string;
  evidence_kind: "ingest" | "duration" | "metadata" | "tags" | "deck";
  provider: string;
  terminal_status: "rejected" | "not_found" | "no_match" | "permanently_failed";
  reason: string;
  attempts: number;
  last_error_code: string | null;
  first_requested_at: PgTimestamp | null;
  last_attempt_at: PgTimestamp;
  source_relation: "catalog_ingest_queue" | "game_duration_jobs" | "catalog_games";
  retry_allowed_after: PgTimestamp | null;
  source_snapshot_hash: string;
}>;

/**
 * A source `jsonb` document, preserved verbatim (never re-serialised through
 * `JSON.parse`) and required to have the given top-level shape.
 *
 * Reuses `catalogue-values.ts`'s scanner — the same one `catalogue.ts` relies
 * on for `weighted_tags` — so a source document's exact text and UTF-8 byte
 * evidence survive for the loader's own `jsonb_typeof`/`pg_column_size` gate.
 */
export function requiredJsonDocument(
  value: string | null,
  field: string,
  relation: string,
  topLevelType: "object" | "array",
): { text: string; utf8Bytes: number } {
  if (value === null) providerFailure("provider_json_shape_conflict", relation, field);
  let document;
  try {
    document = inspectJsonDocument(value, { field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof CatalogueValueError) providerFailure("provider_json_shape_conflict", relation, field);
    throw error;
  }
  if (!document) providerFailure("provider_json_shape_conflict", relation, field);
  if (document.topLevelType !== topLevelType) providerFailure("provider_json_shape_conflict", relation, field);
  return { text: document.sourceText, utf8Bytes: document.utf8Bytes };
}

/** An empty, valid `source_payload` document: `{}`. */
export const EMPTY_JSON_OBJECT: Readonly<{ text: string; utf8Bytes: number }> = Object.freeze({
  text: "{}",
  utf8Bytes: 2,
});

/**
 * Build a small synthesized JSON object document from string fields this
 * transform already validated (e.g. an extra source instant that has no
 * dedicated target column). This is NOT for re-encoding an existing source
 * JSON value — `inspectJsonDocument` (`catalogue-values.ts`) is the one path
 * that preserves a source document verbatim without reparsing it through
 * `JSON.parse`. It is safe here because every value is a string this module
 * already produced, never externally supplied numeric or object data.
 */
export function jsonObjectDocument(fields: Readonly<Record<string, string>>): { text: string; utf8Bytes: number } {
  const text = JSON.stringify(fields);
  return { text, utf8Bytes: utf8ByteLength(text) };
}
