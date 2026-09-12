import { comparePgTimestamps, type PgDecimal, type PgTimestamp } from "./scalars.ts";
import {
  asObject,
  bigintToTargetInteger,
  canonicalUuid,
  checkRowLimit,
  checkRowRunIdentity,
  codePointLength,
  ConflictCollector,
  decimalToScaledInteger,
  enumValue,
  ensureArray,
  fitsNumeric,
  indexAccountMap,
  indexGameMap,
  jsonbUpperBoundBytes,
  libraryFailure,
  nullableSourceCell,
  optionalDecimal,
  optionalInteger,
  optionalTimestamp,
  pgBtrim,
  requiredDecimal,
  requiredInteger,
  requiredTimestamp,
  sourceCell,
  steamAppId,
  TARGET_INTEGER_MAX,
  validateRunIdentity,
  type AccountMapIndex,
  type ConflictRecord,
  type GameMap,
  type GameMapIndex,
  type LibraryCell,
  type LibraryRunIdentity,
} from "./library-shared.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * `public.user_games` fan-out.
 *
 * One legacy library row carries facts for five destinations at once: the
 * compact owned library, authored per-game state, recency evidence, family
 * access, and retired/wishlist measurements, plus the sparse durable legacy
 * measurement row and the bounded raw staging copy reconciliation needs.
 *
 * Three rules constrain every branch below and each has already cost this
 * project a defect:
 *
 * 1. exact observed minutes and legacy decimal hours are separate facts. The
 *    compact library carries only the exact minutes; NULL stays unknown and a
 *    legacy `hours_played` of 0 never becomes an observed zero.
 * 2. family lender playtime is never personal playtime. A family row produces
 *    no `app.library_games` row at all.
 * 3. a derived completion percentage is not an authored manual override, so
 *    `app.game_state.manual_progress` is never populated from it.
 */

const RELATION = "user_games";

const OWNERSHIP_VALUES = ["Owned", "Wishlist"] as const;
const ACCESS_SOURCE_VALUES = ["owned", "family"] as const;
const STATUS_VALUES = ["Not Started", "Sampled", "In Progress", "Slept", "Completed"] as const;
const ACTIVE_STATUS_VALUES = ["Not Started", "Sampled", "In Progress"] as const;
const RECENCY_KIND_VALUES = ["steam_exact", "observed_playtime_change", "steam_recent_window"] as const;

export type LibraryOwnership = (typeof OWNERSHIP_VALUES)[number];
export type LibraryAccessSource = (typeof ACCESS_SOURCE_VALUES)[number];
export type LibraryStatus = (typeof STATUS_VALUES)[number];
export type LibraryActiveStatus = (typeof ACTIVE_STATUS_VALUES)[number];
export type LibraryRecencyKind = (typeof RECENCY_KIND_VALUES)[number];

/**
 * `app.game_state.notes` is checked as `length(btrim(notes)) between 1 and
 * 10000` (M1), so the bound applies to the trimmed length while the stored text
 * stays verbatim.  Measuring the untrimmed length here would reject a note the
 * target accepts.
 */
const MAX_NOTES_BTRIM_LENGTH = 10_000;
/** `migration.legacy_library_evidence.date_added_raw` is bounded at 128. */
const MAX_RAW_TEXT_LENGTH = 128;
/** Raw family owner text has no compact destination when malformed. */
const MAX_RAW_FAMILY_OWNER_LENGTH = 20_000;
/** `migration.legacy_library_evidence.evidence` is `pg_column_size <= 32768`. */
const MAX_EVIDENCE_JSONB_BYTES = 32_768;
/** Both legacy hours destinations are `numeric(30, 12)` and non-negative. */
const HOURS_NUMERIC_PRECISION = 30;
const HOURS_NUMERIC_SCALE = 12;

const ZERO = BigInt(0);
const THREE = BigInt(3);
const SIX = BigInt(6);

/**
 * The legacy import writer's hours conversion, verbatim from
 * `lib/steam-owned-games.ts:32`: `Math.round(((minutes ?? 0) / 60) * 10) / 10`.
 *
 * It is reproduced here in exact integer arithmetic rather than through a
 * double, and the two were checked to agree on every tie (`minutes % 6 === 3`)
 * across the whole int32 domain. The `?? 0` is part of the writer, so a zero
 * hours value beside unknown minutes is exactly what that writer produces; it
 * is not an assertion that the unknown minutes were zero, and no zero is
 * written to any destination because of it.
 */
export const LEGACY_HOURS_FORMULA =
  "round_1dp_import: Math.round(((observed_playtime_minutes ?? 0)/60)*10)/10 (lib/steam-owned-games.ts:32)";

function importHoursTenths(minutes: bigint | null): bigint {
  const value = minutes ?? ZERO;
  if (value < ZERO) libraryFailure("library_invalid_integer", RELATION, "observed_playtime_minutes");
  return (value + THREE) / SIX;
}

export type UserGamesSourceRow = Readonly<{
  id: LibraryCell;
  user_id: LibraryCell;
  ownership: LibraryCell;
  status: LibraryCell;
  hours_played: LibraryCell;
  completion_percentage: LibraryCell;
  date_added: LibraryCell;
  notes: LibraryCell;
  created_at: LibraryCell;
  updated_at: LibraryCell;
  last_played_at: LibraryCell;
  completed_at: LibraryCell;
  slept_at: LibraryCell;
  completion_suggestion_dismissed_at: LibraryCell;
  completion_suggestion_dismissed_playtime: LibraryCell;
  previous_active_status: LibraryCell;
  catalog_steam_appid: LibraryCell;
  last_observed_played_at: LibraryCell;
  recency_source: LibraryCell;
  recency_evidence_at: LibraryCell;
  observed_playtime_minutes: LibraryCell;
  review_requested_at: LibraryCell;
  access_source: LibraryCell;
  family_owner_steam_id: LibraryCell;
  family_verified_at: LibraryCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/** `migration.library_row_map`. The mandatory per-user library identity map. */
export type LibraryRowMapRecord = Readonly<{
  legacy_id: string;
  account_id: number;
  game_id: number;
  /** Exact source AppID text; never re-rendered through a number. */
  steam_appid: string;
  source_snapshot_hash: string;
}>;

/** `app.library_games`. Owned personal rows only. */
export type LibraryGameRecord = Readonly<{
  account_id: number;
  game_id: number;
  /** Exact observed minutes. NULL is unknown; it is never a zero. */
  playtime_minutes: number | null;
}>;

/** `app.game_state`. Authored state only; never a derived percentage. */
export type GameStateRecord = Readonly<{
  account_id: number;
  game_id: number;
  completed_at: PgTimestamp | null;
  slept_at: PgTimestamp | null;
  previous_active_status: LibraryActiveStatus | null;
  restored_at: null;
  restored_from_slept_at: null;
  restored_from_previous_active_status: null;
  /** Always NULL: legacy `completion_percentage` is derived, not authored. */
  manual_progress: null;
  notes: string | null;
  review_requested_at: PgTimestamp | null;
  completion_dismissed_at: PgTimestamp | null;
  completion_dismissed_playtime: number | null;
}>;

export type ObservedInstantStatus = "source" | "unprovable_source_instant";

/**
 * `app.game_activity`, with the M3 `recency_evidence_kind` column.
 *
 * Root's 11 September follow-up corrected this shape: `observed_at` (the
 * receipt time) is sourced from `recency_evidence_at`, not from
 * `last_observed_played_at`. Every reviewed live writer --
 * `upsert_user_steam_games` (20260825190000, redefined 20260831175217),
 * `apply_steam_recent_window` (20260825191500), and
 * `refresh_pinned_steam_playtime` (20260831175217) -- sets
 * `recency_evidence_at` under the same condition it sets
 * `last_observed_played_at`, and `apply_steam_recent_window` additionally
 * sets `recency_evidence_at` while deliberately leaving
 * `last_observed_played_at` unset for window evidence. This is a pattern
 * observed across the reviewed writers, not a schema-enforced guarantee (no
 * source CHECK ties the two columns together); a row whose fields do not fit
 * any reviewed writer's pattern is routed to `LibraryRecencyException`
 * instead of this record, per `normalizeRecency` below.
 */
export type GameActivityRecord = Readonly<{
  account_id: number;
  game_id: number;
  last_observed_minutes: number | null;
  /**
   * The last-played instant, sourced from `last_observed_played_at`, which is
   * what `describeRecency` (lib/recency.ts) reads as the product's own notion
   * of "last played" -- never the raw legacy column directly. Null for pure
   * window evidence, honestly reflecting that only a 14-day window, not a day,
   * is known.
   */
  last_played_at: PgTimestamp | null;
  /**
   * The raw legacy `last_played_at` column, kept whenever it is a distinct
   * fact from the value above: a different instant (in either direction), or
   * present while `last_observed_played_at` is null. NULL only when the two
   * source columns agree or the raw column holds nothing.
   *
   * Root's 11 September acceptance review: the prior revision kept this
   * divergence only in `migration.legacy_library_evidence.evidence`, which is
   * `staging-30d-post-cutover` and therefore expires. It needs a durable home,
   * so `database/v2/proposals/m3_legacy_preservation_followup.sql` adds this
   * nullable column to `app.game_activity`. No ordering between the two source
   * columns is assumed: the reviewed writers only ever advance
   * `last_observed_played_at` at or after the raw column, but that is a
   * writer pattern, not a source-schema guarantee, so an inverted pair is
   * preserved exactly like any other divergence rather than treated as
   * impossible.
   */
  legacy_last_played_at: PgTimestamp | null;
  /** Observation receipt time. Always present on an emitted row. */
  observed_at: PgTimestamp;
  evidence_source: "steam_api" | "unknown";
  recency_evidence_kind: LibraryRecencyKind | "unknown";
  /** Legacy records no play-session interval; inventing one from a receipt
   * timestamp would fabricate evidence the source never recorded. */
  interval_started_at: null;
  interval_ended_at: null;
}>;

export type LibraryRecencyExceptionReason =
  /** Recency evidence exists (a kind, or a last-played instant) but no
   * writer this review read ever leaves `recency_evidence_at` null in that
   * situation. Not proven impossible -- no source CHECK forbids it -- so it
   * blocks rather than silently reusing another field as the receipt time. */
  | "receipt_time_absent_with_recency_signal"
  /** `recency_evidence_at` is set but `recency_source` is not. Every
   * reviewed writer sets both together. */
  | "receipt_time_without_recency_kind"
  /** A receipt time and kind exist, but neither target field the M1
   * disjunction requires (`last_observed_minutes`, `last_played_at`) has a
   * value, so `app.game_activity` cannot represent the row at all. */
  | "receipt_time_without_minutes_or_last_played"
  /**
   * A family-access row carries recency evidence or observed minutes. Neither
   * has a durable personal destination: `app.library_games` and
   * `app.retired_library_games` are personal-only, and writing
   * `app.game_activity` for it would attribute a measurement of uncertain
   * provenance -- the source never records whether the reading describes this
   * account's own play of the shared game or the lender's -- to the borrowing
   * account. Withheld with its exact values rather than assigned or dropped.
   */
  | "family_access_measurement_unassignable";

/**
 * A source measurement this transform will not place: a recency-field
 * combination the reviewed evidence does not explain, or a family-access
 * measurement with no durable personal destination. Never contributes a
 * loadable `app.game_activity` row; carries full raw evidence (unlike the
 * bounded, redacted `conflicts` stream) so root can record a disposition
 * before final load. Root's decision: this blocks commit rather than
 * silently guessing or dropping the value.
 */
export type LibraryRecencyException = Readonly<{
  legacy_id: string;
  account_id: number;
  game_id: number;
  reason: LibraryRecencyExceptionReason;
  last_played_at: PgTimestamp | null;
  last_observed_played_at: PgTimestamp | null;
  recency_source: LibraryRecencyKind | null;
  recency_evidence_at: PgTimestamp | null;
  observed_playtime_minutes: string | null;
  source_snapshot_hash: string;
}>;

/**
 * `app.retired_library_games`. Root's 11 September follow-up: `Wishlist` is
 * not proof a row was never owned. `lib/steam-import-jobs.ts:190-221`
 * demotes a previously-Owned personal row absent from the latest Steam
 * response to `Wishlist`, and
 * `supabase/migrations/20260901193000_share_a_family_library.sql:237-280`
 * preserves an engaged family row the same way on member removal. The
 * literal `ownership` is preserved verbatim as `legacy_ownership`; neither
 * "never owned" nor "was owned" is inferred from it.
 */
export type RetiredLibraryGameRecord = Readonly<{
  account_id: number;
  game_id: number;
  last_personal_minutes: number | null;
  last_observed_at: PgTimestamp | null;
  /** No source instant records an access loss for a wishlist row. The
   * proposal's NULL-safe CHECK only permits this pairing when
   * `loss_reason = 'unknown'` and `legacy_ownership = 'Wishlist'` exactly;
   * every other row, including a legacy `Owned` label, still needs a real
   * instant. */
  access_lost_at: null;
  access_lost_at_status: "unprovable_source_instant";
  /** `loss_reason` still has no `wishlist` literal by design: origin (what
   * this row was) and reason (why it left) are different facts. */
  loss_reason: "unknown";
  /** Always the literal `Wishlist` here: this record is only produced for a
   * personal `ownership = 'Wishlist'` source row. The wider
   * `LibraryOwnership` type is not used, so the type itself cannot express a
   * row the proposal's CHECK would reject. */
  legacy_ownership: "Wishlist";
}>;

export type LenderIdentityStatus = "source" | "missing" | "malformed";

/**
 * A family access fact taken from the library row. It is resolved against
 * lender rows by the family transform; this module never fabricates a member.
 */
export type FamilyAccessCandidate = Readonly<{
  legacy_row_id: string;
  source_user_id: string;
  account_id: number;
  game_id: number;
  steam_app_id: string;
  lender_steam_id: string | null;
  lender_steam_id_status: LenderIdentityStatus;
  /** Raw source text when it is not a usable Steam identity; else null. */
  lender_steam_id_raw: string | null;
  provenance: "verified" | "inferred";
  observed_at: PgTimestamp | null;
  observed_at_status: ObservedInstantStatus;
  ownership: LibraryOwnership;
  /** Same-run marker carried into the family transform without re-derivation. */
  source_snapshot_hash: string;
}>;

export type LibraryDiscrepancyKind =
  | "hours_not_reproducible"
  | "completion_percentage_only"
  | "date_added_text_only"
  | "unknown_minutes_with_hours"
  | "multiple";

/**
 * Whether the exact legacy hours value reaches the constrained
 * `numeric(30, 12)` non-negative destination.
 *
 * The current source column is `numeric(10, 1)`, but a dated source aggregate
 * is evidence and never a precondition in code: the reader hands over exact
 * text, so the fit is proved per value rather than assumed from the audit.
 */
export type LegacyHoursNumericStatus = "exact" | "negative" | "precision_exceeds_target";

/** `app.library_legacy_measurements`. Sparse durable exceptions only. */
export type LibraryLegacyMeasurementRecord = Readonly<{
  account_id: number;
  game_id: number;
  steam_app_id: string;
  ownership_kind: "personal" | "family" | "unknown";
  observed_minutes_at_freeze: number | null;
  legacy_hours_played: string | null;
  legacy_hours_played_raw: string | null;
  legacy_completion_percentage: string | null;
  legacy_completion_percentage_raw: string | null;
  legacy_date_added_raw: string | null;
  discrepancy_kind: LibraryDiscrepancyKind;
  conversion_formula: string;
  /** A discrepancy is a disagreement, never proof that a user typed a value. */
  authorship: "unknown";
  authorship_evidence: null;
  source_snapshot_hash: string;
}>;

/** `migration.legacy_library_evidence`. Bounded reconciliation staging. */
export type LegacyLibraryEvidenceRecord = Readonly<{
  legacy_id: string;
  account_id: number;
  steam_appid: string;
  /**
   * NULL when the exact source value has no `numeric(30, 12)` non-negative
   * representation.  The exact text always survives in the `_raw` column, so
   * nothing is rounded, clamped or dropped to fill this column.
   */
  legacy_hours_played: string | null;
  legacy_hours_played_raw: string;
  completion_percentage: string;
  completion_percentage_raw: string;
  date_added_raw: string | null;
  created_at: PgTimestamp;
  source_updated_at: PgTimestamp;
  reproducible_from_observed: boolean;
  conversion_formula: string;
  source_snapshot_hash: string;
  evidence: Readonly<Record<string, string | number | boolean>>;
}>;

/**
 * The authoritative per-(account, AppID) facts the stale `user_game_state`
 * child is reconciled against. This is transform evidence, not a destination
 * relation, and the stale child is never allowed to flow the other way.
 */
export type AuthoritativeLibraryFact = Readonly<{
  account_id: number;
  steam_appid: string;
  completed_at: PgTimestamp | null;
  slept_at: PgTimestamp | null;
  dismissed_at: PgTimestamp | null;
  /** Exact integer minutes as text; the source value must already be integral. */
  dismissed_playtime: string | null;
  review_requested_at: PgTimestamp | null;
  last_played_at: PgTimestamp | null;
  last_observed_at: PgTimestamp | null;
  recency_evidence_at: PgTimestamp | null;
  family_owner_steam_id: string | null;
  family_verified_at: PgTimestamp | null;
  /** Same-run marker required when the stale child is reconciled. */
  source_snapshot_hash: string;
}>;

export type LibraryTransformResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  library_row_map: readonly LibraryRowMapRecord[];
  library_games: readonly LibraryGameRecord[];
  game_state: readonly GameStateRecord[];
  game_activity: readonly GameActivityRecord[];
  recency_exceptions: readonly LibraryRecencyException[];
  retired_library_games: readonly RetiredLibraryGameRecord[];
  family_access_candidates: readonly FamilyAccessCandidate[];
  library_legacy_measurements: readonly LibraryLegacyMeasurementRecord[];
  legacy_library_evidence: readonly LegacyLibraryEvidenceRecord[];
  authoritative_facts: readonly AuthoritativeLibraryFact[];
  conflicts: readonly ConflictRecord[];
}>;

export type LibraryTransformInput = Readonly<{
  runIdentity: LibraryRunIdentity;
  accountMap: readonly AccountMapTargetRecord[];
  gameMap: GameMap;
  userGames: readonly UserGamesSourceRow[];
}>;

export type LibraryTransformOptions = Readonly<{
  /** Explicit bound on the library rows this pass holds in memory. */
  maxRows?: number;
}>;

const DEFAULT_MAX_ROWS = 5_000_000;

type NormalizedRow = {
  legacyId: string;
  legacyIdCanonical: string;
  sourceUserId: string;
  accountId: number;
  gameId: number;
  appIdText: string;
  ownership: LibraryOwnership;
  accessSource: LibraryAccessSource;
  status: LibraryStatus;
  observedMinutes: bigint | null;
  hours: PgDecimal;
  hoursRaw: string;
  completionPercentage: bigint;
  completionPercentageRaw: string;
  hoursNumericStatus: LegacyHoursNumericStatus;
  dateAddedRaw: string | null;
  notes: string | null;
  createdAt: PgTimestamp;
  updatedAt: PgTimestamp;
  lastPlayedAt: PgTimestamp | null;
  completedAt: PgTimestamp | null;
  sleptAt: PgTimestamp | null;
  dismissedAt: PgTimestamp | null;
  dismissedPlaytime: bigint | null;
  previousActiveStatus: LibraryActiveStatus | null;
  lastObservedPlayedAt: PgTimestamp | null;
  recencyKind: LibraryRecencyKind | null;
  recencyEvidenceAt: PgTimestamp | null;
  reviewRequestedAt: PgTimestamp | null;
  familyOwnerSteamIdRaw: string | null;
  familyVerifiedAt: PgTimestamp | null;
};

function normalizeRow(
  raw: UserGamesSourceRow,
  run: LibraryRunIdentity,
  accounts: AccountMapIndex,
  games: GameMapIndex,
  conflicts: ConflictCollector,
): NormalizedRow {
  const row = asObject(raw, RELATION);
  checkRowRunIdentity(row, run, RELATION);

  const legacyId = canonicalUuid(sourceCell(row, "id", RELATION), RELATION, "id");
  const sourceUserId = canonicalUuid(sourceCell(row, "user_id", RELATION), RELATION, "user_id");
  const accountId = accounts.lookup(sourceUserId.original);
  const appId = steamAppId(sourceCell(row, "catalog_steam_appid", RELATION), RELATION, "catalog_steam_appid");
  const gameId = games.lookup(appId.source);

  const ownership = enumValue(sourceCell(row, "ownership", RELATION), OWNERSHIP_VALUES, RELATION, "ownership");
  const accessSource = enumValue(
    sourceCell(row, "access_source", RELATION),
    ACCESS_SOURCE_VALUES,
    RELATION,
    "access_source",
  );
  const status = enumValue(sourceCell(row, "status", RELATION), STATUS_VALUES, RELATION, "status");

  const observedMinutes = optionalInteger(
    nullableSourceCell(row, "observed_playtime_minutes", RELATION),
    RELATION,
    "observed_playtime_minutes",
    { min: ZERO, max: TARGET_INTEGER_MAX },
  );

  const hoursRaw = sourceCell(row, "hours_played", RELATION);
  if (codePointLength(hoursRaw) > MAX_RAW_TEXT_LENGTH) {
    libraryFailure("library_unrepresentable_value", RELATION, "hours_played");
  }
  const hours = requiredDecimal(hoursRaw, RELATION, "hours_played");
  // Both legacy hours destinations are `numeric(30, 12)` with a non-negative
  // check.  A value outside that is kept as exact source text and the numeric
  // column stays NULL; it is never clamped, negated or rounded to fit, and the
  // row is not discarded because one measurement will not narrow.
  let hoursNumericStatus: LegacyHoursNumericStatus = "exact";
  if (hours.sign < 0) {
    hoursNumericStatus = "negative";
    conflicts.record({
      conflict_class: "library_hours_negative",
      source_relation: RELATION,
      source_column: "hours_played",
      decision:
        "Both legacy hours destinations are non-negative numeric(30,12). A negative source value is preserved only as exact text in legacy_hours_played_raw; it is never clamped, made positive or written to the constrained numeric column.",
      details: { status: "unresolved" },
    });
  } else if (!fitsNumeric(hours, HOURS_NUMERIC_PRECISION, HOURS_NUMERIC_SCALE)) {
    hoursNumericStatus = "precision_exceeds_target";
    conflicts.record({
      conflict_class: "library_hours_precision_exceeds_target",
      source_relation: RELATION,
      source_column: "hours_played",
      decision:
        "The exact source hours value needs more precision or magnitude than numeric(30,12) holds. Storing it would round silently, so the numeric column stays NULL and the exact text is preserved in legacy_hours_played_raw.",
      details: { status: "unresolved" },
    });
  }

  const completionRaw = sourceCell(row, "completion_percentage", RELATION);
  const completionPercentage = requiredInteger(completionRaw, RELATION, "completion_percentage", {
    min: ZERO,
    max: BigInt(100),
  });

  const dateAddedRaw = nullableSourceCell(row, "date_added", RELATION);
  if (dateAddedRaw !== null && codePointLength(dateAddedRaw) > MAX_RAW_TEXT_LENGTH) {
    // No destination holds more than 128 characters of this opaque text, and
    // it is never parsed as a date, so truncation would be a silent loss.
    libraryFailure("library_unrepresentable_value", RELATION, "date_added");
  }

  const notesSource = sourceCell(row, "notes", RELATION);
  const notesTrimmed = pgBtrim(notesSource);
  let notes: string | null = null;
  if (notesTrimmed.length > 0) {
    // The target check is on `length(btrim(notes))`, so the bound is measured
    // on the trimmed text while the stored value stays the verbatim source.
    if (codePointLength(notesTrimmed) > MAX_NOTES_BTRIM_LENGTH) {
      libraryFailure("library_unrepresentable_value", RELATION, "notes");
    }
    notes = notesSource;
  } else if (notesSource.length > 0) {
    conflicts.record({
      conflict_class: "library_notes_whitespace_only",
      source_relation: RELATION,
      source_column: "notes",
      decision:
        "Whitespace-only legacy notes cannot satisfy app.game_state.notes (btrim length 1..10000) and carry no authored text; stored as NULL and counted.",
      details: { status: "resolved" },
    });
  }

  const dismissedPlaytimeSource = optionalDecimal(
    nullableSourceCell(row, "completion_suggestion_dismissed_playtime", RELATION),
    RELATION,
    "completion_suggestion_dismissed_playtime",
  );
  let dismissedPlaytime: bigint | null = null;
  if (dismissedPlaytimeSource !== null) {
    const integral = decimalToScaledInteger(dismissedPlaytimeSource, 0);
    if (integral === null) {
      // The reviewed rule is to reject rather than round: a fractional
      // dismissal baseline would mean the unit is not minutes.
      libraryFailure("library_unrepresentable_value", RELATION, "completion_suggestion_dismissed_playtime");
    }
    if (integral < ZERO || integral > TARGET_INTEGER_MAX) {
      libraryFailure("library_target_overflow", RELATION, "completion_suggestion_dismissed_playtime");
    }
    dismissedPlaytime = integral;
  }

  const previousActiveStatusSource = nullableSourceCell(row, "previous_active_status", RELATION);
  const previousActiveStatus =
    previousActiveStatusSource === null
      ? null
      : enumValue(previousActiveStatusSource, ACTIVE_STATUS_VALUES, RELATION, "previous_active_status");

  const recencySource = nullableSourceCell(row, "recency_source", RELATION);
  const recencyKind =
    recencySource === null ? null : enumValue(recencySource, RECENCY_KIND_VALUES, RELATION, "recency_source");

  const familyOwnerSteamIdRaw = nullableSourceCell(row, "family_owner_steam_id", RELATION);
  if (familyOwnerSteamIdRaw !== null && codePointLength(familyOwnerSteamIdRaw) > MAX_RAW_FAMILY_OWNER_LENGTH) {
    libraryFailure("library_unrepresentable_value", RELATION, "family_owner_steam_id");
  }

  return {
    legacyId: legacyId.original,
    legacyIdCanonical: legacyId.canonical,
    sourceUserId: sourceUserId.original,
    accountId,
    gameId,
    appIdText: appId.source,
    ownership,
    accessSource,
    status,
    observedMinutes,
    hours,
    hoursRaw,
    hoursNumericStatus,
    completionPercentage,
    completionPercentageRaw: completionRaw,
    dateAddedRaw,
    notes,
    createdAt: requiredTimestamp(sourceCell(row, "created_at", RELATION), RELATION, "created_at"),
    updatedAt: requiredTimestamp(sourceCell(row, "updated_at", RELATION), RELATION, "updated_at"),
    lastPlayedAt: optionalTimestamp(nullableSourceCell(row, "last_played_at", RELATION), RELATION, "last_played_at"),
    completedAt: optionalTimestamp(nullableSourceCell(row, "completed_at", RELATION), RELATION, "completed_at"),
    sleptAt: optionalTimestamp(nullableSourceCell(row, "slept_at", RELATION), RELATION, "slept_at"),
    dismissedAt: optionalTimestamp(
      nullableSourceCell(row, "completion_suggestion_dismissed_at", RELATION),
      RELATION,
      "completion_suggestion_dismissed_at",
    ),
    dismissedPlaytime,
    previousActiveStatus,
    lastObservedPlayedAt: optionalTimestamp(
      nullableSourceCell(row, "last_observed_played_at", RELATION),
      RELATION,
      "last_observed_played_at",
    ),
    recencyKind,
    recencyEvidenceAt: optionalTimestamp(
      nullableSourceCell(row, "recency_evidence_at", RELATION),
      RELATION,
      "recency_evidence_at",
    ),
    reviewRequestedAt: optionalTimestamp(
      nullableSourceCell(row, "review_requested_at", RELATION),
      RELATION,
      "review_requested_at",
    ),
    familyOwnerSteamIdRaw,
    familyVerifiedAt: optionalTimestamp(
      nullableSourceCell(row, "family_verified_at", RELATION),
      RELATION,
      "family_verified_at",
    ),
  };
}

function compareRows(left: NormalizedRow, right: NormalizedRow): number {
  if (left.accountId !== right.accountId) return left.accountId - right.accountId;
  if (left.appIdText.length !== right.appIdText.length) return left.appIdText.length - right.appIdText.length;
  return left.appIdText < right.appIdText ? -1 : left.appIdText > right.appIdText ? 1 : 0;
}

const STEAM_ACCOUNT_ID_TEXT = /^[0-9]{17}$/;

/**
 * Every withheld exception also gets a bounded, redacted aggregate record.
 * The exception arrays carry the raw evidence but are never loaded, so the
 * pre-commit gate has to be able to see the condition in
 * `migration.conflict_report` -- which is counts and prose only, never a
 * source value. One class per reason, so a batch that hits two reasons
 * reports both rather than collapsing into a single count.
 */
const RECENCY_EXCEPTION_CONFLICTS: Readonly<
  Record<LibraryRecencyExceptionReason, Readonly<{ conflict_class: string; source_column: string; decision: string }>>
> = Object.freeze({
  receipt_time_absent_with_recency_signal: Object.freeze({
    conflict_class: "library_recency_receipt_time_absent",
    source_column: "recency_evidence_at",
    decision:
      "UNRESOLVED for root: the row carries recency evidence (a kind, or a last-played instant) with no recency_evidence_at to act as app.game_activity.observed_at. No reviewed writer produces that combination and no source CHECK forbids it, so no receipt time is guessed from another column. The row is withheld with its exact values in the segregated recency_exceptions record and blocks final load/commit until root records a disposition.",
  }),
  receipt_time_without_recency_kind: Object.freeze({
    conflict_class: "library_recency_receipt_time_without_kind",
    source_column: "recency_source",
    decision:
      "UNRESOLVED for root: recency_evidence_at is set while recency_source is null. Every reviewed writer sets both together, so the pairing is unexplained and app.game_activity.recency_evidence_kind is not defaulted to 'unknown' on a guess. The row is withheld with its exact values in the segregated recency_exceptions record and blocks final load/commit.",
  }),
  receipt_time_without_minutes_or_last_played: Object.freeze({
    conflict_class: "library_recency_without_minutes_or_last_played",
    source_column: "recency_evidence_at",
    decision:
      "UNRESOLVED for root: a receipt time and kind exist, but neither field app.game_activity's disjunction requires (last_observed_minutes, last_played_at) has a value, so the row cannot be represented without violating that CHECK. It is withheld with its exact values in the segregated recency_exceptions record and blocks final load/commit.",
  }),
  family_access_measurement_unassignable: Object.freeze({
    conflict_class: "library_family_measurement_unassignable",
    source_column: "observed_playtime_minutes",
    decision:
      "UNRESOLVED for root: a family-access row carries observed minutes and/or recency evidence with no durable personal destination. app.library_games and app.retired_library_games hold personal rows only, and writing app.game_activity would attribute a reading whose subject the source never records to the borrowing account. The measurement is withheld with its exact values in the segregated recency_exceptions record rather than assigned or dropped, and blocks final load/commit.",
  }),
});

function recencyExceptionConflict(reason: LibraryRecencyExceptionReason): {
  conflict_class: string;
  source_relation: string;
  source_column: string;
  decision: string;
  details: Readonly<Record<string, string>>;
} {
  const entry = RECENCY_EXCEPTION_CONFLICTS[reason];
  return {
    conflict_class: entry.conflict_class,
    source_relation: RELATION,
    source_column: entry.source_column,
    decision: entry.decision,
    details: Object.freeze({ status: "unresolved", destination: "recency_exceptions" }),
  };
}

/**
 * Convert one complete `user_games` population into deterministic target
 * records. The function is pure: no filesystem, database, network or target
 * write happens here, and no wall-clock value is read.
 */
export function transformLibraryBatch(
  input: LibraryTransformInput,
  options: LibraryTransformOptions = {},
): LibraryTransformResult {
  const root = asObject(input, "library_input");
  const run = validateRunIdentity(root.runIdentity);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const accounts = indexAccountMap(root.accountMap, run);
  const games = indexGameMap(root.gameMap, run);
  const rows = ensureArray(root.userGames, RELATION) as readonly UserGamesSourceRow[];
  checkRowLimit(rows, RELATION, maxRows);

  const conflicts = new ConflictCollector();
  const normalized: NormalizedRow[] = [];
  const seenLegacyIds = new Set<string>();
  const seenAccountGame = new Set<string>();
  const seenAccountAppId = new Set<string>();

  for (const raw of rows) {
    const row = normalizeRow(raw, run, accounts, games, conflicts);
    if (seenLegacyIds.has(row.legacyIdCanonical)) libraryFailure("library_duplicate_identity", RELATION, "id");
    seenLegacyIds.add(row.legacyIdCanonical);
    const accountGameKey = `${row.accountId}:${row.gameId}`;
    if (seenAccountGame.has(accountGameKey)) libraryFailure("library_duplicate_identity", RELATION, "catalog_steam_appid");
    seenAccountGame.add(accountGameKey);
    const accountAppIdKey = `${row.accountId}:${row.appIdText}`;
    if (seenAccountAppId.has(accountAppIdKey)) {
      libraryFailure("library_duplicate_identity", RELATION, "catalog_steam_appid");
    }
    seenAccountAppId.add(accountAppIdKey);
    normalized.push(row);
  }

  normalized.sort(compareRows);

  const libraryRowMap: LibraryRowMapRecord[] = [];
  const libraryGames: LibraryGameRecord[] = [];
  const gameState: GameStateRecord[] = [];
  const gameActivity: GameActivityRecord[] = [];
  const recencyExceptions: LibraryRecencyException[] = [];
  const retired: RetiredLibraryGameRecord[] = [];
  const familyCandidates: FamilyAccessCandidate[] = [];
  const measurements: LibraryLegacyMeasurementRecord[] = [];
  const evidence: LegacyLibraryEvidenceRecord[] = [];
  const authoritative: AuthoritativeLibraryFact[] = [];

  for (const row of normalized) {
    libraryRowMap.push(
      Object.freeze({
        legacy_id: row.legacyId,
        account_id: row.accountId,
        game_id: row.gameId,
        steam_appid: row.appIdText,
        source_snapshot_hash: run.snapshotHash,
      }),
    );

    const personal = row.accessSource === "owned";
    const observedMinutesTarget =
      row.observedMinutes === null ? null : bigintToTargetInteger(row.observedMinutes, RELATION, "observed_playtime_minutes");

    // --- app.library_games -------------------------------------------------
    // Owned personal rows only. A family row never contributes personal
    // minutes, and a wishlist row is not part of the active library.
    if (personal && row.ownership === "Owned") {
      libraryGames.push(
        Object.freeze({
          account_id: row.accountId,
          game_id: row.gameId,
          playtime_minutes: observedMinutesTarget,
        }),
      );
    }

    // --- app.retired_library_games ----------------------------------------
    if (personal && row.ownership === "Wishlist") {
      retired.push(
        Object.freeze({
          account_id: row.accountId,
          game_id: row.gameId,
          last_personal_minutes: observedMinutesTarget,
          last_observed_at: row.lastObservedPlayedAt,
          access_lost_at: null,
          access_lost_at_status: "unprovable_source_instant" as const,
          loss_reason: "unknown" as const,
          legacy_ownership: row.ownership,
        }),
      );
      conflicts.record({
        conflict_class: "retired_wishlist_access_lost_at_unprovable",
        source_relation: RELATION,
        source_column: "ownership",
        decision:
          "UNRESOLVED pending the proposal migration: against the applied M1 schema, access_lost_at is NOT NULL with a now() default and no source instant records when this row left the active library (Wishlist rows carry no removal/tombstone timestamp of their own). database/v2/proposals/m3_legacy_preservation_followup.sql drops NOT NULL under a paired CHECK that allows a null access_lost_at only when loss_reason='unknown' and legacy_ownership='Wishlist' exactly, which is this row's shape and nothing wider; a legacy 'Owned' label or a runtime loss_reason still requires a real instant. legacy_ownership carries the verbatim source literal, not an inferred prior-ownership claim: a Wishlist row here can be never-owned, demoted from Owned by lib/steam-import-jobs.ts:190-221, or a family tombstone from supabase/migrations/20260901193000_share_a_family_library.sql:237-280.",
        details: { status: "unresolved", destination: "app.retired_library_games" },
      });
    }

    // --- app.family_game_access candidates ---------------------------------
    if (!personal) {
      let lenderStatus: LenderIdentityStatus = "missing";
      let lenderSteamId: string | null = null;
      let lenderRaw: string | null = null;
      if (row.familyOwnerSteamIdRaw !== null) {
        if (STEAM_ACCOUNT_ID_TEXT.test(row.familyOwnerSteamIdRaw) && BigInt(row.familyOwnerSteamIdRaw) > ZERO) {
          lenderStatus = "source";
          lenderSteamId = row.familyOwnerSteamIdRaw;
        } else {
          lenderStatus = "malformed";
          lenderRaw = row.familyOwnerSteamIdRaw;
          conflicts.record({
            conflict_class: "family_lender_identity_malformed",
            source_relation: RELATION,
            source_column: "family_owner_steam_id",
            decision:
              "Legacy family_owner_steam_id has no foreign key and no digit check. A value that is not a 17-digit Steam identity cannot resolve to a lender, so the access is retained as orphan evidence and confers nothing.",
            details: { status: "resolved", destination: "app.family_access_orphans" },
          });
        }
      } else {
        conflicts.record({
          conflict_class: "family_lender_identity_missing",
          source_relation: RELATION,
          source_column: "family_owner_steam_id",
          decision:
            "A family access row with no lender identity cannot satisfy app.family_game_access(account_id, member_id); it is retained as orphan evidence rather than fabricating a member.",
          details: { status: "resolved", destination: "app.family_access_orphans" },
        });
      }
      const verified = row.familyVerifiedAt !== null;
      familyCandidates.push(
        Object.freeze({
          legacy_row_id: row.legacyId,
          source_user_id: row.sourceUserId,
          account_id: row.accountId,
          game_id: row.gameId,
          steam_app_id: row.appIdText,
          lender_steam_id: lenderSteamId,
          lender_steam_id_status: lenderStatus,
          lender_steam_id_raw: lenderRaw,
          provenance: verified ? ("verified" as const) : ("inferred" as const),
          // The writer updates `updated_at` on every family access observation,
          // including removals.  It is the manifest's source fallback when
          // family_verified_at is NULL; no wall-clock value is introduced.
          observed_at: row.familyVerifiedAt ?? row.updatedAt,
          observed_at_status: "source" as const,
          ownership: row.ownership,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      // ownership='Wishlist' with access_source='family' is a supported family
      // tombstone (supabase/migrations/20260901193000_share_a_family_library.sql:
      // 237-280, remove_user_family_member_games). The candidate above still
      // carries row.ownership; the family transform is the sole place that
      // decides access from it, so the case is resolved once there, not
      // duplicated as a second unresolved marker here. See family.ts's
      // "family_access_retired_by_ownership" conflict.
    }

    // --- app.game_state ----------------------------------------------------
    const hasState =
      row.completedAt !== null ||
      row.sleptAt !== null ||
      row.previousActiveStatus !== null ||
      row.notes !== null ||
      row.reviewRequestedAt !== null ||
      row.dismissedAt !== null;
    if (hasState) {
      gameState.push(
        Object.freeze({
          account_id: row.accountId,
          game_id: row.gameId,
          completed_at: row.completedAt,
          slept_at: row.sleptAt,
          previous_active_status: row.previousActiveStatus,
          restored_at: null,
          restored_from_slept_at: null,
          restored_from_previous_active_status: null,
          manual_progress: null,
          notes: row.notes,
          review_requested_at: row.reviewRequestedAt,
          completion_dismissed_at: row.dismissedAt,
          completion_dismissed_playtime:
            row.dismissedPlaytime === null
              ? null
              : bigintToTargetInteger(row.dismissedPlaytime, RELATION, "completion_suggestion_dismissed_playtime"),
        }),
      );
    } else if (row.dismissedPlaytime !== null) {
      // The M1 disjunction does not count a dismissal baseline on its own, so
      // a baseline without a dismissal instant has nowhere in app.game_state.
      conflicts.record({
        conflict_class: "library_dismissal_baseline_without_state",
        source_relation: RELATION,
        source_column: "completion_suggestion_dismissed_playtime",
        decision:
          "UNRESOLVED for root: app.game_state requires at least one state field and a dismissal baseline alone does not satisfy it. The value is retained in migration.legacy_library_evidence.evidence and no state row is invented.",
        details: { status: "unresolved" },
      });
    }

    if (row.status === "Completed" && row.completedAt === null) {
      conflicts.record({
        conflict_class: "library_status_terminal_disagreement",
        source_relation: RELATION,
        source_column: "status",
        decision:
          "Legacy status is retired as derived, on the stated grounds that terminal states are recoverable from completed_at/slept_at. A 'Completed' status with no completed_at contradicts that; the raw status is retained in migration.legacy_library_evidence.evidence and no instant is invented.",
        details: { status: "unresolved" },
      });
    }
    if (row.status === "Slept" && row.sleptAt === null) {
      conflicts.record({
        conflict_class: "library_status_terminal_disagreement",
        source_relation: RELATION,
        source_column: "status",
        decision:
          "Legacy status is retired as derived, on the stated grounds that terminal states are recoverable from completed_at/slept_at. A 'Slept' status with no slept_at contradicts that; the raw status is retained in migration.legacy_library_evidence.evidence and no instant is invented.",
        details: { status: "unresolved" },
      });
    }

    // --- app.game_activity ---------------------------------------------------
    // Root's 11 September follow-up: recency_evidence_at is the receipt time
    // (observed_at); last_observed_played_at is the last-played instant. Every
    // reviewed writer sets recency_evidence_at exactly when it sets/keeps
    // recency_source and (except for pure window evidence) last_observed_played_at,
    // but no source CHECK enforces that pairing, so a row whose fields do not
    // fit a reviewed writer's pattern is an explicit blocking exception, never
    // a silent guess.
    const rawLastPlayedAt = row.lastPlayedAt;
    const rawLastObservedPlayedAt = row.lastObservedPlayedAt;
    // A distinct raw reading, in either direction: a different instant, or a
    // raw value with nothing to compare it against. No ordering between the
    // two source columns is assumed -- the reviewed writers only advance
    // last_observed_played_at at or after the raw column, but no source CHECK
    // enforces that, so an inverted pair is a divergence like any other.
    const legacyLastPlayedAtDiverges =
      rawLastPlayedAt !== null &&
      (rawLastObservedPlayedAt === null || comparePgTimestamps(rawLastPlayedAt, rawLastObservedPlayedAt) !== 0);

    const hasAnyRecencySignal =
      row.recencyKind !== null || row.lastObservedPlayedAt !== null || row.lastPlayedAt !== null;
    let recencyExceptionReason: LibraryRecencyExceptionReason | null = null;
    if (row.recencyEvidenceAt === null && hasAnyRecencySignal) {
      recencyExceptionReason = "receipt_time_absent_with_recency_signal";
    } else if (row.recencyEvidenceAt !== null && row.recencyKind === null) {
      recencyExceptionReason = "receipt_time_without_recency_kind";
    } else if (!personal && (row.recencyEvidenceAt !== null || hasAnyRecencySignal || observedMinutesTarget !== null)) {
      // Root's 11 September acceptance review: a family row's measurement has
      // no durable personal destination at all -- app.library_games and
      // app.retired_library_games are both personal-only, and
      // library_legacy_measurements records a reproducibility discrepancy, not
      // a bare baseline. Emitting app.game_activity instead would attribute a
      // reading whose subject the source never records to the borrowing
      // account. Withheld with exact values instead of assigned or dropped.
      recencyExceptionReason = "family_access_measurement_unassignable";
    }

    let activityEmitted = false;
    if (recencyExceptionReason !== null) {
      recencyExceptions.push(
        Object.freeze({
          legacy_id: row.legacyId,
          account_id: row.accountId,
          game_id: row.gameId,
          reason: recencyExceptionReason,
          last_played_at: row.lastPlayedAt,
          last_observed_played_at: row.lastObservedPlayedAt,
          recency_source: row.recencyKind,
          recency_evidence_at: row.recencyEvidenceAt,
          observed_playtime_minutes: row.observedMinutes === null ? null : row.observedMinutes.toString(10),
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      conflicts.record(recencyExceptionConflict(recencyExceptionReason));
    } else if (row.recencyEvidenceAt !== null) {
      if (observedMinutesTarget === null && row.lastObservedPlayedAt === null) {
        // A receipt time and kind exist, but neither target field the M1
        // disjunction requires has a value; app.game_activity cannot
        // represent this row without violating its own CHECK.
        recencyExceptions.push(
          Object.freeze({
            legacy_id: row.legacyId,
            account_id: row.accountId,
            game_id: row.gameId,
            reason: "receipt_time_without_minutes_or_last_played" as const,
            last_played_at: row.lastPlayedAt,
            last_observed_played_at: row.lastObservedPlayedAt,
            recency_source: row.recencyKind,
            recency_evidence_at: row.recencyEvidenceAt,
            observed_playtime_minutes: null,
            source_snapshot_hash: run.snapshotHash,
          }),
        );
        conflicts.record(recencyExceptionConflict("receipt_time_without_minutes_or_last_played"));
      } else {
        // Only a personal row reaches here: a family row with any measurement
        // was routed to family_access_measurement_unassignable above.
        gameActivity.push(
          Object.freeze({
            account_id: row.accountId,
            game_id: row.gameId,
            last_observed_minutes: observedMinutesTarget,
            last_played_at: row.lastObservedPlayedAt,
            legacy_last_played_at: legacyLastPlayedAtDiverges ? rawLastPlayedAt : null,
            observed_at: row.recencyEvidenceAt,
            evidence_source: "steam_api" as const,
            recency_evidence_kind: row.recencyKind ?? ("unknown" as const),
            interval_started_at: null,
            interval_ended_at: null,
          }),
        );
        activityEmitted = true;
      }
    } else if (observedMinutesTarget !== null) {
      // No recency evidence of any kind (recency_source, last_observed_played_at,
      // last_played_at and recency_evidence_at are all null), so there is no
      // candidate observation instant, and no family row reaches here. The
      // minutes are not orphaned -- but which durable column already holds
      // them depends on the row: an owned row's minutes are in
      // app.library_games.playtime_minutes, a wishlist row's in
      // app.retired_library_games.last_personal_minutes. The destination is
      // named per row rather than claimed for all of them.
      //
      // The class itself is split by destination rather than the decision text
      // alone: ConflictCollector keys on class/relation/column, so a single
      // class covering both would report one batch-wide destination for rows
      // that reached two different tables.
      const owned = row.ownership === "Owned";
      const baselineDestination = owned ? "app.library_games" : "app.retired_library_games";
      const baselineColumn = owned ? "playtime_minutes" : "last_personal_minutes";
      conflicts.record({
        conflict_class: owned
          ? "library_activity_baseline_only_suppressed"
          : "library_activity_baseline_only_suppressed_retired",
        source_relation: RELATION,
        source_column: "observed_playtime_minutes",
        decision: `No recency evidence exists for this row, so app.game_activity has no candidate observed_at and no last_played_at/last_observed_minutes evidence beyond the plain minutes baseline. The baseline is not lost: this personal ${row.ownership} row's exact minutes already survive durably in ${baselineDestination}.${baselineColumn}. No app.game_activity row is written and none is fabricated.`,
        details: { status: "resolved", destination: baselineDestination },
      });
    }

    // --- legacy hours / completion / date reproducibility -------------------
    const expectedTenths = importHoursTenths(row.observedMinutes);
    const actualTenths = decimalToScaledInteger(row.hours, 1);
    const hoursReproducible = actualTenths !== null && actualTenths === expectedTenths;
    const completionIsEvidence = row.completionPercentage > ZERO;
    const dateAddedIsEvidence = row.dateAddedRaw !== null;
    const reproducible = hoursReproducible && !completionIsEvidence && !dateAddedIsEvidence;

    if (!hoursReproducible) {
      conflicts.record({
        conflict_class: "library_playtime_precedence_unresolved",
        source_relation: RELATION,
        source_column: "hours_played",
        decision:
          "UNRESOLVED for root (D-LIB-1 / P05): legacy decimal hours are not reproducible from the exact observed minutes by the recorded import formula. Both facts are preserved separately and neither is maxed, coalesced or discarded. A discrepancy does not prove authorship, so authorship stays 'unknown'.",
        details: { status: "unresolved", decision_ref: "D-LIB-1" },
      });
    }

    const kinds: LibraryDiscrepancyKind[] = [];
    if (!hoursReproducible) {
      kinds.push(row.observedMinutes === null ? "unknown_minutes_with_hours" : "hours_not_reproducible");
    }
    if (completionIsEvidence) kinds.push("completion_percentage_only");
    if (dateAddedIsEvidence) kinds.push("date_added_text_only");

    if (kinds.length > 0) {
      const discrepancy: LibraryDiscrepancyKind = kinds.length > 1 ? "multiple" : kinds[0];
      measurements.push(
        Object.freeze({
          account_id: row.accountId,
          game_id: row.gameId,
          steam_app_id: row.appIdText,
          ownership_kind: personal ? ("personal" as const) : ("family" as const),
          observed_minutes_at_freeze: observedMinutesTarget,
          legacy_hours_played:
            hoursReproducible || row.hoursNumericStatus !== "exact" ? null : row.hours.toCanonicalString(),
          legacy_hours_played_raw: hoursReproducible ? null : row.hoursRaw,
          legacy_completion_percentage: completionIsEvidence ? row.completionPercentage.toString(10) : null,
          legacy_completion_percentage_raw: completionIsEvidence ? row.completionPercentageRaw : null,
          legacy_date_added_raw: row.dateAddedRaw,
          discrepancy_kind: discrepancy,
          conversion_formula: LEGACY_HOURS_FORMULA,
          authorship: "unknown" as const,
          authorship_evidence: null,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
    }

    const evidenceDetails: Record<string, string | number | boolean> = {
      ownership: row.ownership,
      access_source: row.accessSource,
      status: row.status,
      notes_present: row.notes !== null,
      state_row_emitted: hasState,
      activity_row_emitted: activityEmitted,
    };
    if (row.recencyKind !== null) evidenceDetails.recency_source = row.recencyKind;
    if (!activityEmitted && row.recencyEvidenceAt !== null) {
      evidenceDetails.recency_evidence_at = row.recencyEvidenceAt.canonicalUtc;
    }
    if (legacyLastPlayedAtDiverges && rawLastPlayedAt !== null) {
      // Reconciliation convenience only. The durable copy of a divergent raw
      // reading is app.game_activity.legacy_last_played_at on an emitted row,
      // or the full exception record on a withheld one -- this staging table
      // is purged 30 days after cutover and is never the only copy.
      evidenceDetails.last_played_at_raw = rawLastPlayedAt.canonicalUtc;
      if (rawLastObservedPlayedAt !== null) {
        evidenceDetails.last_observed_played_at_raw = rawLastObservedPlayedAt.canonicalUtc;
      }
    }
    if (!hasState && row.previousActiveStatus !== null) {
      evidenceDetails.previous_active_status = row.previousActiveStatus;
    }
    if (!hasState && row.dismissedPlaytime !== null) {
      evidenceDetails.completion_dismissed_playtime = row.dismissedPlaytime.toString(10);
    }
    if (row.hoursNumericStatus !== "exact") evidenceDetails.legacy_hours_numeric = row.hoursNumericStatus;
    if (jsonbUpperBoundBytes(evidenceDetails) > MAX_EVIDENCE_JSONB_BYTES) {
      libraryFailure("library_unrepresentable_value", RELATION, "evidence");
    }

    evidence.push(
      Object.freeze({
        legacy_id: row.legacyId,
        account_id: row.accountId,
        steam_appid: row.appIdText,
        legacy_hours_played: row.hoursNumericStatus === "exact" ? row.hours.toCanonicalString() : null,
        legacy_hours_played_raw: row.hoursRaw,
        completion_percentage: row.completionPercentage.toString(10),
        completion_percentage_raw: row.completionPercentageRaw,
        date_added_raw: row.dateAddedRaw,
        created_at: row.createdAt,
        source_updated_at: row.updatedAt,
        reproducible_from_observed: reproducible,
        conversion_formula: LEGACY_HOURS_FORMULA,
        source_snapshot_hash: run.snapshotHash,
        evidence: Object.freeze(evidenceDetails),
      }),
    );

    authoritative.push(
      Object.freeze({
        account_id: row.accountId,
        steam_appid: row.appIdText,
        completed_at: row.completedAt,
        slept_at: row.sleptAt,
        dismissed_at: row.dismissedAt,
        dismissed_playtime: row.dismissedPlaytime === null ? null : row.dismissedPlaytime.toString(10),
        review_requested_at: row.reviewRequestedAt,
        last_played_at: row.lastPlayedAt,
        last_observed_at: row.lastObservedPlayedAt,
        recency_evidence_at: row.recencyEvidenceAt,
        family_owner_steam_id: row.familyOwnerSteamIdRaw,
        family_verified_at: row.familyVerifiedAt,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    library_row_map: Object.freeze(libraryRowMap),
    library_games: Object.freeze(libraryGames),
    game_state: Object.freeze(gameState),
    game_activity: Object.freeze(gameActivity),
    recency_exceptions: Object.freeze(recencyExceptions),
    retired_library_games: Object.freeze(retired),
    family_access_candidates: Object.freeze(familyCandidates),
    library_legacy_measurements: Object.freeze(measurements),
    legacy_library_evidence: Object.freeze(evidence),
    authoritative_facts: Object.freeze(authoritative),
    conflicts: conflicts.toRecords(),
  });
}

/** Stable JSON for comparisons that must not depend on insertion order. */
export function canonicalLibraryResult(result: LibraryTransformResult): string {
  return JSON.stringify({
    run_identity: result.run_identity,
    library_row_map: result.library_row_map,
    library_games: result.library_games,
    game_state: result.game_state,
    game_activity: result.game_activity,
    recency_exceptions: result.recency_exceptions,
    retired_library_games: result.retired_library_games,
    family_access_candidates: result.family_access_candidates,
    library_legacy_measurements: result.library_legacy_measurements,
    legacy_library_evidence: result.legacy_library_evidence,
    authoritative_facts: result.authoritative_facts,
    conflicts: result.conflicts,
  });
}
