import { comparePgDecimals, comparePgTimestamps, type PgDecimal, type PgTimestamp } from "./scalars.ts";
import {
  asObject,
  canonicalUuid,
  checkRowLimit,
  checkRowRunIdentity,
  codePointLength,
  ConflictCollector,
  ensureArray,
  indexAccountMap,
  libraryFailure,
  nullableSourceCell,
  optionalDecimal,
  optionalInteger,
  optionalTimestamp,
  sourceCell,
  steamAppId,
  validateRunIdentity,
  type ConflictRecord,
  type LibraryCell,
  type LibraryRunIdentity,
} from "./library-shared.ts";
import type { AuthoritativeLibraryFact } from "./library.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * The stale `public.user_game_state` child.
 *
 * This module deliberately produces no runtime record. `app.game_state` and
 * `app.game_activity` are not among its outputs and no code path here can
 * reach them: the whole relation is bounded reconciliation staging, and only
 * rows whose raw code, timestamp, numeric value or provenance is the sole
 * surviving evidence are marked for promotion to the sparse durable
 * `app.game_state_legacy_measurements` relation.
 *
 * The comparison against the authoritative `user_games` facts runs in one
 * direction only: it decides whether a staging row is redundant. A stale value
 * never overwrites, fills or corroborates an authoritative one.
 */

const RELATION = "user_game_state";

const ZERO = BigInt(0);
/** `raw_prev_active_status` and `raw_recency_code` are PostgreSQL smallint. */
const SMALLINT_MIN = BigInt("-32768");
const SMALLINT_MAX = BigInt("32767");
const DEFAULT_MAX_ROWS = 5_000_000;
const PREVIOUS_ACTIVE_CODES = new Set([1, 2]);
const RECENCY_CODES = new Set([1, 2, 3]);
/** `app.game_state_legacy_measurements.raw_family_owner_steam_id` is <= 200. */
const DURABLE_FAMILY_OWNER_MAX_LENGTH = 200;

export type LegacyGameStateSourceRow = Readonly<{
  user_id: LibraryCell;
  appid: LibraryCell;
  completed_at: LibraryCell;
  slept_at: LibraryCell;
  prev_active_status: LibraryCell;
  dismissed_at: LibraryCell;
  dismissed_playtime: LibraryCell;
  review_requested_at: LibraryCell;
  last_played_at: LibraryCell;
  last_observed_played_at: LibraryCell;
  recency_source: LibraryCell;
  recency_evidence_at: LibraryCell;
  family_owner_steam_id: LibraryCell;
  family_verified_at: LibraryCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export type EvidenceDisposition = "reconcile_only" | "durable_sparse_required";

export type LegacyStateEvidenceReason =
  | "stale_conflict"
  | "unresolved_codebook"
  | "non_integral_dismissed_playtime"
  | "source_provenance"
  | "multiple";

type RawStateFields = Readonly<{
  raw_completed_at: PgTimestamp | null;
  raw_slept_at: PgTimestamp | null;
  raw_prev_active_status: number | null;
  raw_dismissed_at: PgTimestamp | null;
  /** Native source precision, never narrowed to satisfy a target type. */
  raw_dismissed_playtime: string | null;
  raw_review_requested_at: PgTimestamp | null;
  raw_last_played_at: PgTimestamp | null;
  raw_last_observed_at: PgTimestamp | null;
  raw_recency_code: number | null;
  raw_recency_evidence_at: PgTimestamp | null;
  raw_family_owner_steam_id: string | null;
  raw_family_verified_at: PgTimestamp | null;
}>;

/** `migration.legacy_user_game_state_audit`. The complete bounded copy. */
export type LegacyGameStateAuditRecord = RawStateFields &
  Readonly<{
    account_id: number;
    source_user_id: string;
    steam_appid: string;
    source_snapshot_hash: string;
    retention_class: "staging-30d-post-cutover";
    evidence_disposition: EvidenceDisposition;
  }>;

/** `app.game_state_legacy_measurements`. Explicitly promoted sparse rows. */
export type GameStateLegacyMeasurementRecord = RawStateFields &
  Readonly<{
    account_id: number;
    steam_app_id: string;
    source_user_id: string;
    evidence_reason: LegacyStateEvidenceReason;
    source_snapshot_hash: string;
  }>;

export type LegacyGameStateResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  legacy_user_game_state_audit: readonly LegacyGameStateAuditRecord[];
  game_state_legacy_measurements: readonly GameStateLegacyMeasurementRecord[];
  conflicts: readonly ConflictRecord[];
}>;

export type LegacyGameStateInput = Readonly<{
  runIdentity: LibraryRunIdentity;
  accountMap: readonly AccountMapTargetRecord[];
  userGameState: readonly LegacyGameStateSourceRow[];
  /** The banked `user_games` facts this staging copy is reconciled against. */
  authoritativeFacts: readonly AuthoritativeLibraryFact[];
}>;

export type LegacyGameStateOptions = Readonly<{ maxRows?: number }>;

function sameTimestamp(left: PgTimestamp | null, right: PgTimestamp | null): boolean {
  return comparePgTimestamps(left, right) === 0;
}

function sameDecimalText(left: string | null, right: PgDecimal | null): boolean {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  // Both sides came from the same exact-decimal parser, so this is an exact
  // value comparison and never a float round-trip.
  const parsed = optionalDecimal(left, RELATION, "dismissed_playtime");
  if (parsed === null) return false;
  return comparePgDecimals(parsed, right) === 0;
}

function isIntegral(value: PgDecimal): boolean {
  if (value.coefficient === ZERO) return true;
  if (value.scale <= 0) return true;
  const divisor = BigInt(10) ** BigInt(value.scale);
  return value.coefficient % divisor === ZERO;
}

function smallint(value: string | null, field: string): number | null {
  const parsed = optionalInteger(value, RELATION, field, { min: SMALLINT_MIN, max: SMALLINT_MAX });
  return parsed === null ? null : Number(parsed);
}

/**
 * Authoritative facts are an in-memory hand-off between transforms, but the
 * boundary is still untrusted: a caller can pass a JSON-like object, a
 * foreign run, or a target account that this map never claimed. Validate the
 * complete fact before comparing any stale row so a malformed hand-off cannot
 * turn into a TypeError or a cross-run reconciliation.
 */
function factTimestamp(value: unknown, field: string): PgTimestamp | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    libraryFailure("library_input_invalid", "user_games", field);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.epochMicros !== "bigint" ||
    typeof candidate.epochMicrosText !== "string" ||
    typeof candidate.canonicalUtc !== "string" ||
    typeof candidate.sourceText !== "string" ||
    typeof candidate.toJSON !== "function"
  ) {
    libraryFailure("library_input_invalid", "user_games", field);
  }
  if (candidate.epochMicrosText !== candidate.epochMicros.toString(10)) {
    libraryFailure("library_input_invalid", "user_games", field);
  }
  // Re-parse the source spelling to prove that the cached scalar fields agree;
  // this never routes through Date or a floating point value.
  const parsed = optionalTimestamp(candidate.sourceText, "user_games", field);
  if (
    parsed === null ||
    parsed.epochMicros !== candidate.epochMicros ||
    parsed.epochMicrosText !== candidate.epochMicrosText ||
    parsed.canonicalUtc !== candidate.canonicalUtc
  ) {
    libraryFailure("library_input_invalid", "user_games", field);
  }
  return value as PgTimestamp;
}

function factDecimal(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") libraryFailure("library_input_invalid", "user_games", field);
  // The banked fact stores canonical exact text. Parsing also rejects a
  // malformed or non-finite hand-written value before comparison.
  const parsed = optionalDecimal(value, "user_games", field);
  if (parsed === null || parsed.toCanonicalString() !== value) {
    libraryFailure("library_input_invalid", "user_games", field);
  }
  return value;
}

function factString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") libraryFailure("library_input_invalid", "user_games", field);
  return value;
}

/**
 * Copy the stale child into bounded staging and mark the rows whose evidence
 * is not reproducible from the authoritative library row.
 *
 * Pure: no filesystem, database, network or target write, and no wall clock.
 */
export function transformLegacyGameState(
  input: LegacyGameStateInput,
  options: LegacyGameStateOptions = {},
): LegacyGameStateResult {
  const root = asObject(input, "legacy_state_input");
  const run = validateRunIdentity(root.runIdentity);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const accounts = indexAccountMap(root.accountMap, run);
  const rows = ensureArray(root.userGameState, RELATION) as readonly LegacyGameStateSourceRow[];
  checkRowLimit(rows, RELATION, maxRows);

  const facts = ensureArray(root.authoritativeFacts, "user_games") as readonly AuthoritativeLibraryFact[];
  checkRowLimit(facts, "user_games", maxRows);
  const factIndex = new Map<string, AuthoritativeLibraryFact>();
  for (const raw of facts) {
    const fact = asObject(raw, "user_games") as unknown as AuthoritativeLibraryFact;
    if (
      typeof fact.account_id !== "number" ||
      !Number.isSafeInteger(fact.account_id) ||
      fact.account_id < 1 ||
      !accounts.hasTarget(fact.account_id)
    ) {
      libraryFailure("library_input_invalid", "user_games", "account_id");
    }
    const appId = steamAppId(fact.steam_appid, "user_games", "catalog_steam_appid");
    if (typeof fact.source_snapshot_hash !== "string") {
      libraryFailure("library_input_invalid", "user_games", "source_snapshot_hash");
    }
    if (fact.source_snapshot_hash !== run.snapshotHash) {
      libraryFailure("library_mixed_run_identity", "user_games", "source_snapshot_hash");
    }
    factTimestamp(fact.completed_at, "completed_at");
    factTimestamp(fact.slept_at, "slept_at");
    factTimestamp(fact.dismissed_at, "dismissed_at");
    factTimestamp(fact.review_requested_at, "review_requested_at");
    factTimestamp(fact.last_played_at, "last_played_at");
    factTimestamp(fact.last_observed_at, "last_observed_at");
    factTimestamp(fact.recency_evidence_at, "recency_evidence_at");
    factTimestamp(fact.family_verified_at, "family_verified_at");
    factDecimal(fact.dismissed_playtime, "dismissed_playtime");
    factString(fact.family_owner_steam_id, "family_owner_steam_id");
    const key = `${fact.account_id}:${appId.source}`;
    if (factIndex.has(key)) libraryFailure("library_duplicate_identity", "user_games", "catalog_steam_appid");
    factIndex.set(key, fact);
  }

  const conflicts = new ConflictCollector();
  const audit: LegacyGameStateAuditRecord[] = [];
  const promoted: GameStateLegacyMeasurementRecord[] = [];
  const seen = new Set<string>();

  for (const raw of rows) {
    const row = asObject(raw, RELATION);
    checkRowRunIdentity(row, run, RELATION);
    const sourceUserId = canonicalUuid(sourceCell(row, "user_id", RELATION), RELATION, "user_id");
    const accountId = accounts.lookup(sourceUserId.original);
    const appId = steamAppId(sourceCell(row, "appid", RELATION), RELATION, "appid");
    const key = `${accountId}:${appId.source}`;
    if (seen.has(key)) libraryFailure("library_duplicate_identity", RELATION, "appid");
    seen.add(key);

    const dismissedPlaytime = optionalDecimal(
      nullableSourceCell(row, "dismissed_playtime", RELATION),
      RELATION,
      "dismissed_playtime",
    );

    const fields: RawStateFields = Object.freeze({
      raw_completed_at: optionalTimestamp(nullableSourceCell(row, "completed_at", RELATION), RELATION, "completed_at"),
      raw_slept_at: optionalTimestamp(nullableSourceCell(row, "slept_at", RELATION), RELATION, "slept_at"),
      raw_prev_active_status: smallint(nullableSourceCell(row, "prev_active_status", RELATION), "prev_active_status"),
      raw_dismissed_at: optionalTimestamp(nullableSourceCell(row, "dismissed_at", RELATION), RELATION, "dismissed_at"),
      raw_dismissed_playtime: dismissedPlaytime === null ? null : dismissedPlaytime.toCanonicalString(),
      raw_review_requested_at: optionalTimestamp(
        nullableSourceCell(row, "review_requested_at", RELATION),
        RELATION,
        "review_requested_at",
      ),
      raw_last_played_at: optionalTimestamp(
        nullableSourceCell(row, "last_played_at", RELATION),
        RELATION,
        "last_played_at",
      ),
      raw_last_observed_at: optionalTimestamp(
        nullableSourceCell(row, "last_observed_played_at", RELATION),
        RELATION,
        "last_observed_played_at",
      ),
      raw_recency_code: smallint(nullableSourceCell(row, "recency_source", RELATION), "recency_source"),
      raw_recency_evidence_at: optionalTimestamp(
        nullableSourceCell(row, "recency_evidence_at", RELATION),
        RELATION,
        "recency_evidence_at",
      ),
      raw_family_owner_steam_id: nullableSourceCell(row, "family_owner_steam_id", RELATION),
      raw_family_verified_at: optionalTimestamp(
        nullableSourceCell(row, "family_verified_at", RELATION),
        RELATION,
        "family_verified_at",
      ),
    });

    if (fields.raw_prev_active_status !== null && !PREVIOUS_ACTIVE_CODES.has(fields.raw_prev_active_status)) {
      libraryFailure("library_invalid_enum", RELATION, "prev_active_status");
    }
    if (fields.raw_recency_code !== null && !RECENCY_CODES.has(fields.raw_recency_code)) {
      libraryFailure("library_invalid_enum", RELATION, "recency_source");
    }

    // `migration.legacy_user_game_state_audit.raw_family_owner_steam_id` is
    // unbounded text, while the durable sparse relation caps it at 200
    // characters and truncation is never allowed.  Whether that matters
    // therefore depends on whether this row is promoted, so the bound is
    // enforced at the promotion decision rather than on every staged row.
    const ownerOverDurableBound =
      fields.raw_family_owner_steam_id !== null &&
      codePointLength(fields.raw_family_owner_steam_id) > DURABLE_FAMILY_OWNER_MAX_LENGTH;

    const reasons: LegacyStateEvidenceReason[] = [];

    // Unresolved code books have no other home at all: nothing in the compact
    // model records a smallint whose meaning is still a source question.
    if (fields.raw_prev_active_status !== null || fields.raw_recency_code !== null) {
      reasons.push("unresolved_codebook");
      conflicts.record({
        conflict_class: "state_unresolved_codebook",
        source_relation: RELATION,
        source_column: fields.raw_recency_code !== null ? "recency_source" : "prev_active_status",
        decision:
          "UNRESOLVED for root (D-UGS-1 / S-UGS-CODEBOOK): the smallint code books are not decoded and are never inferred from ordering. The raw code is preserved verbatim and promoted to app.game_state_legacy_measurements; it never reaches app.game_state or app.game_activity.",
        details: { status: "unresolved", decision_ref: "D-UGS-1" },
      });
    }

    if (dismissedPlaytime !== null && !isIntegral(dismissedPlaytime)) {
      reasons.push("non_integral_dismissed_playtime");
      conflicts.record({
        conflict_class: "state_non_integral_dismissed_playtime",
        source_relation: RELATION,
        source_column: "dismissed_playtime",
        decision:
          "A fractional dismissal baseline cannot narrow to the integer destination and is not rounded. It is preserved at source precision in the staging copy and promoted to the durable sparse relation.",
        details: { status: "resolved" },
      });
    }

    const fact = factIndex.get(key);
    if (fact === undefined) {
      reasons.push("stale_conflict");
      conflicts.record({
        conflict_class: "state_orphan_row",
        source_relation: RELATION,
        source_column: "appid",
        decision:
          "A stale state row with no authoritative user_games row cannot be reconciled away, so its evidence is promoted. It still never creates library, state or activity rows.",
        details: { status: "unresolved" },
      });
    } else {
      const disagrees =
        !sameTimestamp(fields.raw_completed_at, fact.completed_at) ||
        !sameTimestamp(fields.raw_slept_at, fact.slept_at) ||
        !sameTimestamp(fields.raw_dismissed_at, fact.dismissed_at) ||
        !sameTimestamp(fields.raw_review_requested_at, fact.review_requested_at) ||
        !sameTimestamp(fields.raw_last_played_at, fact.last_played_at) ||
        !sameTimestamp(fields.raw_last_observed_at, fact.last_observed_at) ||
        !sameTimestamp(fields.raw_recency_evidence_at, fact.recency_evidence_at) ||
        !sameDecimalText(fact.dismissed_playtime, dismissedPlaytime);
      if (disagrees) {
        reasons.push("stale_conflict");
        conflicts.record({
          conflict_class: "state_stale_conflict",
          source_relation: RELATION,
          source_column: "user_id",
          decision:
            "A stale value disagrees with the authoritative user_games row. Both are preserved; the stale value is promoted as sole evidence of the disagreement and is never coalesced into current state or activity.",
          details: { status: "resolved" },
        });
      }
      const provenanceDisagrees =
        fields.raw_family_owner_steam_id !== fact.family_owner_steam_id ||
        !sameTimestamp(fields.raw_family_verified_at, fact.family_verified_at);
      if (provenanceDisagrees) {
        reasons.push("source_provenance");
        conflicts.record({
          conflict_class: "state_family_provenance_conflict",
          source_relation: RELATION,
          source_column: "family_owner_steam_id",
          decision:
            "Stale family owner/verification evidence disagrees with the authoritative library row. It is preserved as raw evidence and never used to create family access or to set provenance='verified'.",
          details: { status: "resolved" },
        });
      }
    }

    const hasAnyRawValue =
      fields.raw_completed_at !== null ||
      fields.raw_slept_at !== null ||
      fields.raw_prev_active_status !== null ||
      fields.raw_dismissed_at !== null ||
      fields.raw_dismissed_playtime !== null ||
      fields.raw_review_requested_at !== null ||
      fields.raw_last_played_at !== null ||
      fields.raw_last_observed_at !== null ||
      fields.raw_recency_code !== null ||
      fields.raw_recency_evidence_at !== null ||
      fields.raw_family_owner_steam_id !== null ||
      fields.raw_family_verified_at !== null;

    let disposition: EvidenceDisposition = "reconcile_only";
    if (reasons.length > 0) {
      if (!hasAnyRawValue) {
        // The durable relation requires at least one raw value; an all-NULL
        // tuple is a reconciliation fact only and stays in staging.
        conflicts.record({
          conflict_class: "state_empty_conflict_row",
          source_relation: RELATION,
          source_column: "user_id",
          decision:
            "An all-NULL stale tuple that still disagrees with the authoritative row cannot satisfy the durable relation's non-empty check. It remains in bounded staging with its disposition recorded.",
          details: { status: "unresolved" },
        });
      } else {
        if (ownerOverDurableBound) {
          // Promotion is the only path that has to narrow this text, and
          // truncating a lender identity would change it.
          libraryFailure("library_unrepresentable_value", RELATION, "family_owner_steam_id");
        }
        disposition = "durable_sparse_required";
        const reason: LegacyStateEvidenceReason = reasons.length > 1 ? "multiple" : reasons[0];
        promoted.push(
          Object.freeze({
            ...fields,
            account_id: accountId,
            steam_app_id: appId.source,
            source_user_id: sourceUserId.original,
            evidence_reason: reason,
            source_snapshot_hash: run.snapshotHash,
          }),
        );
      }
    } else if (ownerOverDurableBound) {
      conflicts.record({
        conflict_class: "state_family_owner_over_durable_bound",
        source_relation: RELATION,
        source_column: "family_owner_steam_id",
        decision:
          "The stale family owner text exceeds the durable sparse relation's 200-character bound. This row needs no promotion, so the full text is preserved verbatim in the unbounded staging copy and nothing is truncated; a later promotion decision for it is blocked rather than shortened.",
        details: { status: "unresolved", destination: "app.game_state_legacy_measurements" },
      });
    }

    audit.push(
      Object.freeze({
        ...fields,
        account_id: accountId,
        source_user_id: sourceUserId.original,
        steam_appid: appId.source,
        source_snapshot_hash: run.snapshotHash,
        retention_class: "staging-30d-post-cutover" as const,
        evidence_disposition: disposition,
      }),
    );
  }

  const byAccountThenAppId = (
    left: { account_id: number; steam_appid?: string; steam_app_id?: string },
    right: { account_id: number; steam_appid?: string; steam_app_id?: string },
  ): number => {
    if (left.account_id !== right.account_id) return left.account_id - right.account_id;
    const leftApp = left.steam_appid ?? left.steam_app_id ?? "";
    const rightApp = right.steam_appid ?? right.steam_app_id ?? "";
    if (leftApp.length !== rightApp.length) return leftApp.length - rightApp.length;
    return leftApp < rightApp ? -1 : leftApp > rightApp ? 1 : 0;
  };

  audit.sort(byAccountThenAppId);
  promoted.sort(byAccountThenAppId);

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    legacy_user_game_state_audit: Object.freeze(audit),
    game_state_legacy_measurements: Object.freeze(promoted),
    conflicts: conflicts.toRecords(),
  });
}

/** Stable JSON for order-independent comparisons in tests and reports. */
export function canonicalLegacyStateResult(result: LegacyGameStateResult): string {
  return JSON.stringify({
    run_identity: result.run_identity,
    legacy_user_game_state_audit: result.legacy_user_game_state_audit,
    game_state_legacy_measurements: result.game_state_legacy_measurements,
    conflicts: result.conflicts,
  });
}
