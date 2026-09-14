import type { CopyRow } from "../read/copy-text.ts";
import { ExportError } from "../shared/redaction.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";
import {
  parseCivilDate,
  parsePgDecimal,
  parsePgInteger,
  parsePgTimestamptz,
  ScalarError,
  type CivilDate,
  type PgDecimal,
  type PgTimestamp,
} from "./scalars.ts";

/**
 * Shared vocabulary for the M3-F library domain: `user_games`, the stale
 * `user_game_state` child, family members/access, daily playtime history,
 * completion history and purge reviews.
 *
 * This module holds only the pieces every library transform needs.  It does
 * not build a catalogue identity map: the game map is produced by the
 * catalogue implementer and consumed here through the reviewed interface in
 * `docs/v2-claude-domain-transforms.md`.
 */

/** COPY cells stay `string | null` until a reviewed conversion happens here. */
export type LibraryCell = CopyRow[number];

export type LibraryErrorCode =
  | "library_input_invalid"
  | "library_run_invalid"
  | "library_mixed_run_identity"
  | "library_row_limit"
  | "library_account_map_invalid"
  | "library_account_unmapped"
  | "library_game_map_invalid"
  | "library_game_unmapped"
  | "library_invalid_uuid"
  | "library_invalid_timestamp"
  | "library_invalid_civil_date"
  | "library_invalid_integer"
  | "library_invalid_decimal"
  | "library_invalid_array"
  | "library_invalid_enum"
  | "library_app_id_out_of_range"
  | "library_target_overflow"
  | "library_duplicate_identity"
  | "library_unrepresentable_value"
  | "library_physical_gap";

const LIBRARY_MESSAGES: Readonly<Record<LibraryErrorCode, string>> = {
  library_input_invalid: "The library transform input shape is invalid.",
  library_run_invalid: "The library transform run identity is invalid.",
  library_mixed_run_identity: "Library rows do not belong to one explicit migration run.",
  library_row_limit: "The library transform row bound was exceeded.",
  library_account_map_invalid: "The supplied account map is not a consistent same-run map.",
  library_account_unmapped: "A source row names an account that is absent from the account map.",
  library_game_map_invalid: "The supplied game map is not a consistent same-run map.",
  library_game_unmapped: "A source row names a catalogue identity that is absent from the game map.",
  library_invalid_uuid: "A source identity UUID is invalid.",
  library_invalid_timestamp: "A source timestamp is invalid or unsupported.",
  library_invalid_civil_date: "A source civil date is invalid or unsupported.",
  library_invalid_integer: "A source integer is invalid or outside the destination bounds.",
  library_invalid_decimal: "A source numeric value is invalid or unsupported.",
  library_invalid_array: "A source PostgreSQL array is malformed.",
  library_invalid_enum: "A source value is outside its reviewed value domain.",
  library_app_id_out_of_range: "A source Steam AppID is outside the accepted catalogue range.",
  library_target_overflow: "A deterministic target identity does not fit the destination range.",
  library_duplicate_identity: "The source contains duplicate or conflicting identities.",
  library_unrepresentable_value: "A source value has no destination that can hold it without loss.",
  library_physical_gap: "The current target contract cannot represent this library fact safely.",
};

export type LibraryDiagnostic = Readonly<{
  code: LibraryErrorCode;
  relation: string;
  field: string | null;
  count: number;
}>;

/**
 * A library failure carries a stable code, the source relation/field and a
 * count.  It never carries a UUID, Steam ID, AppID, note, error text,
 * timestamp or measurement.
 */
export class LibraryTransformError extends ExportError {
  readonly libraryCode: LibraryErrorCode;
  readonly diagnostics: readonly LibraryDiagnostic[];

  constructor(code: LibraryErrorCode, diagnostic: LibraryDiagnostic) {
    super(code, LIBRARY_MESSAGES[code], {
      relation: diagnostic.relation,
      field: diagnostic.field,
      count: diagnostic.count,
    });
    this.name = "LibraryTransformError";
    this.libraryCode = code;
    this.diagnostics = Object.freeze([Object.freeze({ ...diagnostic })]);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), diagnostics: this.diagnostics };
  }
}

export function libraryFailure(
  code: LibraryErrorCode,
  relation: string,
  field: string | null = null,
  count = 1,
): never {
  throw new LibraryTransformError(code, { code, relation, field, count });
}

const UUID_TEXT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const RUN_ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_TEXT = /^[0-9a-f]{64}$/;
const STEAM_ID_TEXT = /^[0-9]{17}$/;

export const STEAM_APP_ID_MIN = BigInt(1);
/** `catalog.games.steam_app_id` accepts 1..4294967295 (M1). */
export const STEAM_APP_ID_MAX = BigInt("4294967295");
export const TARGET_INTEGER_MAX = BigInt("2147483647");
export const TARGET_BIGINT_MAX = BigInt("9223372036854775807");
const ZERO = BigInt(0);

export type LibraryRunIdentity = Readonly<{
  runId: string;
  snapshotHash: string;
}>;

export function validateRunIdentity(value: unknown): LibraryRunIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    libraryFailure("library_run_invalid", "run_identity");
  }
  const candidate = value as Record<string, unknown>;
  // Runtime types are checked before the regexes: RegExp.test coerces
  // undefined, numbers and objects to text and would otherwise accept them.
  if (typeof candidate.runId !== "string" || typeof candidate.snapshotHash !== "string") {
    libraryFailure("library_run_invalid", "run_identity");
  }
  if (!RUN_ID_TEXT.test(candidate.runId) || !SHA256_TEXT.test(candidate.snapshotHash)) {
    libraryFailure("library_run_invalid", "run_identity");
  }
  return Object.freeze({ runId: candidate.runId, snapshotHash: candidate.snapshotHash });
}

export function asObject(value: unknown, relation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    libraryFailure("library_input_invalid", relation);
  }
  return value as Record<string, unknown>;
}

export function ensureArray(value: unknown, relation: string): readonly object[] {
  if (!Array.isArray(value)) libraryFailure("library_input_invalid", relation);
  return value as readonly object[];
}

export function sourceCell(row: object, key: string, relation: string): string {
  const value = (row as Record<string, unknown>)[key];
  if (typeof value !== "string") libraryFailure("library_input_invalid", relation, key);
  return value;
}

export function nullableSourceCell(row: object, key: string, relation: string): string | null {
  const value = (row as Record<string, unknown>)[key];
  if (value === null) return null;
  if (typeof value !== "string") libraryFailure("library_input_invalid", relation, key);
  return value;
}

function optionalAlias(row: object, first: string, second: string): unknown {
  const record = row as Record<string, unknown>;
  const left = record[first];
  const right = record[second];
  if (left !== undefined && right !== undefined && left !== right) return { mismatch: true };
  return left ?? right;
}

/** Reject a row annotated with a different run than the one being transformed. */
export function checkRowRunIdentity(row: object, run: LibraryRunIdentity, relation: string): void {
  const rowRunId = optionalAlias(row, "runId", "run_id");
  const rowSnapshotHash = optionalAlias(row, "snapshotHash", "snapshot_hash");
  if (
    typeof rowRunId === "object" ||
    typeof rowSnapshotHash === "object" ||
    (rowRunId !== undefined && typeof rowRunId !== "string") ||
    (rowSnapshotHash !== undefined && typeof rowSnapshotHash !== "string")
  ) {
    libraryFailure("library_mixed_run_identity", relation);
  }
  if (
    (rowRunId !== undefined && rowRunId !== run.runId) ||
    (rowSnapshotHash !== undefined && rowSnapshotHash !== run.snapshotHash)
  ) {
    libraryFailure("library_mixed_run_identity", relation);
  }
}

export type CanonicalUuid = Readonly<{ original: string; canonical: string }>;

export function canonicalUuid(value: string, relation: string, field: string): CanonicalUuid {
  if (!UUID_TEXT.test(value)) libraryFailure("library_invalid_uuid", relation, field);
  return Object.freeze({ original: value, canonical: value.toLowerCase() });
}

export function requiredTimestamp(value: string | null, relation: string, field: string): PgTimestamp {
  const parsed = optionalTimestamp(value, relation, field);
  if (parsed === null) libraryFailure("library_invalid_timestamp", relation, field);
  return parsed;
}

export function optionalTimestamp(value: string | null, relation: string, field: string): PgTimestamp | null {
  try {
    return parsePgTimestamptz(value, { field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof ScalarError) libraryFailure("library_invalid_timestamp", relation, field);
    throw error;
  }
}

/** A civil date never passes through an instant: it is a day, not a moment. */
export function requiredCivilDate(value: string | null, relation: string, field: string): CivilDate {
  let parsed: CivilDate | null;
  try {
    parsed = parseCivilDate(value, `${relation}.${field}`);
  } catch (error) {
    if (error instanceof ScalarError) libraryFailure("library_invalid_civil_date", relation, field);
    throw error;
  }
  if (parsed === null) libraryFailure("library_invalid_civil_date", relation, field);
  return parsed;
}

export type IntegerFieldBounds = Readonly<{ min: bigint; max: bigint }>;

export function optionalInteger(
  value: string | null,
  relation: string,
  field: string,
  bounds: IntegerFieldBounds,
): bigint | null {
  try {
    return parsePgInteger(value, {
      minInclusive: bounds.min,
      maxInclusive: bounds.max,
      field: `${relation}.${field}`,
    });
  } catch (error) {
    if (error instanceof ScalarError) libraryFailure("library_invalid_integer", relation, field);
    throw error;
  }
}

export function requiredInteger(
  value: string | null,
  relation: string,
  field: string,
  bounds: IntegerFieldBounds,
): bigint {
  const parsed = optionalInteger(value, relation, field, bounds);
  if (parsed === null) libraryFailure("library_invalid_integer", relation, field);
  return parsed;
}

export function optionalDecimal(value: string | null, relation: string, field: string): PgDecimal | null {
  try {
    return parsePgDecimal(value, { field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof ScalarError) libraryFailure("library_invalid_decimal", relation, field);
    throw error;
  }
}

export function requiredDecimal(value: string | null, relation: string, field: string): PgDecimal {
  const parsed = optionalDecimal(value, relation, field);
  if (parsed === null) libraryFailure("library_invalid_decimal", relation, field);
  return parsed;
}

/**
 * A Steam AppID stays exact text; only its range is checked here.
 *
 * The value is parsed against the full bigint domain first so that an
 * out-of-range AppID reports as an AppID range failure rather than as a
 * generic integer failure, and the text is never re-rendered.
 */
export function steamAppId(value: string, relation: string, field: string): { source: string; target: bigint } {
  const parsed = requiredInteger(value, relation, field, {
    min: -TARGET_BIGINT_MAX - BigInt(1),
    max: TARGET_BIGINT_MAX,
  });
  if (parsed < STEAM_APP_ID_MIN || parsed > STEAM_APP_ID_MAX || parsed.toString(10) !== value) {
    libraryFailure("library_app_id_out_of_range", relation, field);
  }
  return { source: value, target: parsed };
}

export function steamAccountId(value: string, relation: string, field: string): { source: string; target: bigint } {
  if (!STEAM_ID_TEXT.test(value)) libraryFailure("library_invalid_integer", relation, field);
  const parsed = requiredInteger(value, relation, field, { min: BigInt(1), max: TARGET_BIGINT_MAX });
  if (parsed.toString(10) !== value) libraryFailure("library_invalid_integer", relation, field);
  return { source: value, target: parsed };
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** PostgreSQL `btrim(text)` with its default single-space trim character. */
export function pgBtrim(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

/**
 * PostgreSQL `length(text)` counts characters, and a bounded target column is
 * checked against that count.  Over-length text is never truncated: the caller
 * decides between an archive destination and an explicit failure.
 */
export function fitsBoundedText(value: string, maxLength: number): boolean {
  return codePointLength(value) <= maxLength;
}

export function enumValue<T extends string>(
  value: string,
  allowed: readonly T[],
  relation: string,
  field: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) libraryFailure("library_invalid_enum", relation, field);
  return value as T;
}

/**
 * Parse PostgreSQL array output text for a one-dimensional integer array.
 *
 * The grammar accepted here is deliberately narrow: `{}`, `{1,2}` and quoted
 * elements.  A nested array, a NULL element, a non-integer element or unbalanced
 * quoting is a malformed row, never a silently repaired one.
 */
export function parsePgIntegerArray(
  value: string,
  relation: string,
  field: string,
  bounds: IntegerFieldBounds,
  maxElements: number,
): readonly bigint[] {
  if (typeof value !== "string" || value.length < 2 || value[0] !== "{" || value[value.length - 1] !== "}") {
    libraryFailure("library_invalid_array", relation, field);
  }
  const body = value.slice(1, -1);
  if (body.length === 0) return Object.freeze([]);
  const elements: bigint[] = [];
  let index = 0;
  while (index <= body.length) {
    let token: string;
    let quoted = false;
    if (body[index] === '"') {
      quoted = true;
      index += 1;
      let text = "";
      let closed = false;
      while (index < body.length) {
        const character = body[index];
        if (character === "\\") {
          if (index + 1 >= body.length) libraryFailure("library_invalid_array", relation, field);
          text += body[index + 1];
          index += 2;
          continue;
        }
        if (character === '"') {
          closed = true;
          index += 1;
          break;
        }
        text += character;
        index += 1;
      }
      if (!closed) libraryFailure("library_invalid_array", relation, field);
      token = text;
    } else {
      const next = body.indexOf(",", index);
      const end = next === -1 ? body.length : next;
      token = body.slice(index, end);
      index = end;
    }
    if (!quoted && (token.includes("{") || token.includes("}") || token.includes('"'))) {
      libraryFailure("library_invalid_array", relation, field);
    }
    if (!quoted && token.toUpperCase() === "NULL") libraryFailure("library_invalid_array", relation, field);
    if (elements.length >= maxElements) libraryFailure("library_row_limit", relation, field);
    elements.push(requiredInteger(token, relation, field, bounds));
    if (index >= body.length) break;
    if (body[index] !== ",") libraryFailure("library_invalid_array", relation, field);
    index += 1;
    if (index >= body.length) libraryFailure("library_invalid_array", relation, field);
  }
  return Object.freeze(elements);
}

/**
 * The shared game map, produced by the catalogue implementer and consumed
 * here.  The shape is fixed by `docs/v2-claude-domain-transforms.md`; this
 * module never builds a map, it only indexes and reads one.
 */
export type GameMapTargetRecord = Readonly<{
  legacy_app_id: string;
  game_id: number;
  source_kind: "catalog_games" | "stub";
  source_snapshot_hash: string;
}>;

export type GameMap = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  entries: readonly GameMapTargetRecord[];
}>;

export type GameMapIndex = Readonly<{
  /** Resolve exact source AppID text to `catalog.games.id`. Throws when absent. */
  lookup: (legacyAppId: string | null) => number;
  has: (legacyAppId: string | null) => boolean;
  /** Prove that an intermediate library row points at a mapped target game. */
  hasTarget: (gameId: number) => boolean;
  size: number;
}>;

/**
 * Index a supplied game map for lookup.
 *
 * Identity is not ownership: the presence of an entry says a catalogue row
 * exists, never that an account owns or can reach that game.
 */
export function indexGameMap(map: unknown, run: LibraryRunIdentity): GameMapIndex {
  const root = asObject(map, "game_map");
  const identity = asObject(root.run_identity, "game_map");
  if (typeof identity.run_id !== "string" || typeof identity.snapshot_hash !== "string") {
    libraryFailure("library_game_map_invalid", "game_map", "run_identity");
  }
  if (identity.run_id !== run.runId || identity.snapshot_hash !== run.snapshotHash) {
    libraryFailure("library_mixed_run_identity", "game_map", "run_identity");
  }
  const entries = ensureArray(root.entries, "game_map");
  checkRowLimit(entries, "game_map", 5_000_000);
  const byAppId = new Map<string, number>();
  const claimedGameIds = new Set<number>();
  for (const raw of entries) {
    const entry = asObject(raw, "game_map");
    if (typeof entry.legacy_app_id !== "string") libraryFailure("library_game_map_invalid", "game_map", "legacy_app_id");
    if (typeof entry.source_snapshot_hash !== "string") {
      libraryFailure("library_game_map_invalid", "game_map", "source_snapshot_hash");
    }
    if (entry.source_snapshot_hash !== run.snapshotHash) {
      libraryFailure("library_mixed_run_identity", "game_map", "source_snapshot_hash");
    }
    if (entry.source_kind !== "catalog_games" && entry.source_kind !== "stub") {
      libraryFailure("library_game_map_invalid", "game_map", "source_kind");
    }
    const appId = steamAppId(entry.legacy_app_id, "game_map", "legacy_app_id");
    const gameId = entry.game_id;
    if (
      typeof gameId !== "number" ||
      !Number.isSafeInteger(gameId) ||
      gameId < 1 ||
      BigInt(gameId) > TARGET_INTEGER_MAX
    ) {
      libraryFailure("library_game_map_invalid", "game_map", "game_id");
    }
    if (byAppId.has(appId.source)) libraryFailure("library_duplicate_identity", "game_map", "legacy_app_id");
    if (claimedGameIds.has(gameId)) libraryFailure("library_duplicate_identity", "game_map", "game_id");
    byAppId.set(appId.source, gameId);
    claimedGameIds.add(gameId);
  }
  const lookup = (legacyAppId: string | null): number => {
    if (legacyAppId === null) libraryFailure("library_game_unmapped", "game_map", "legacy_app_id");
    if (typeof legacyAppId !== "string") libraryFailure("library_game_unmapped", "game_map", "legacy_app_id");
    const resolved = byAppId.get(legacyAppId);
    if (resolved === undefined) libraryFailure("library_game_unmapped", "game_map", "legacy_app_id");
    return resolved;
  };
  return Object.freeze({
    lookup,
    has: (legacyAppId: string | null): boolean =>
      typeof legacyAppId === "string" && byAppId.has(legacyAppId),
    hasTarget: (gameId: number): boolean => claimedGameIds.has(gameId),
    size: byAppId.size,
  });
}

export type AccountMapIndex = Readonly<{
  lookup: (legacyId: string) => number;
  has: (legacyId: string) => boolean;
  /** Prove that a banked target account belongs to this same map. */
  hasTarget: (accountId: number) => boolean;
  size: number;
}>;

/** Index the same-run account map produced by the identity transform. */
export function indexAccountMap(map: unknown, run: LibraryRunIdentity): AccountMapIndex {
  const entries = ensureArray(map, "account_map") as readonly AccountMapTargetRecord[];
  checkRowLimit(entries, "account_map", 5_000_000);
  const byLegacyId = new Map<string, number>();
  const claimedAccountIds = new Set<number>();
  for (const raw of entries) {
    const entry = asObject(raw, "account_map");
    if (typeof entry.legacy_id !== "string") libraryFailure("library_account_map_invalid", "account_map", "legacy_id");
    if (typeof entry.source_snapshot_hash !== "string") {
      libraryFailure("library_account_map_invalid", "account_map", "source_snapshot_hash");
    }
    if (entry.source_snapshot_hash !== run.snapshotHash) {
      libraryFailure("library_mixed_run_identity", "account_map", "source_snapshot_hash");
    }
    if (entry.source_kind !== "app_accounts" && entry.source_kind !== "unknown") {
      libraryFailure("library_account_map_invalid", "account_map", "source_kind");
    }
    const legacyId = canonicalUuid(entry.legacy_id, "account_map", "legacy_id");
    const accountId = entry.account_id;
    if (
      typeof accountId !== "number" ||
      !Number.isSafeInteger(accountId) ||
      accountId < 1 ||
      BigInt(accountId) > TARGET_INTEGER_MAX
    ) {
      libraryFailure("library_account_map_invalid", "account_map", "account_id");
    }
    if (byLegacyId.has(legacyId.canonical)) libraryFailure("library_duplicate_identity", "account_map", "legacy_id");
    if (claimedAccountIds.has(accountId)) libraryFailure("library_duplicate_identity", "account_map", "account_id");
    byLegacyId.set(legacyId.canonical, accountId);
    claimedAccountIds.add(accountId);
  }
  const lookup = (legacyId: string): number => {
    if (typeof legacyId !== "string") libraryFailure("library_account_unmapped", "account_map", "legacy_id");
    const resolved = byLegacyId.get(legacyId.toLowerCase());
    if (resolved === undefined) libraryFailure("library_account_unmapped", "account_map", "legacy_id");
    return resolved;
  };
  return Object.freeze({
    lookup,
    has: (legacyId: string): boolean => typeof legacyId === "string" && byLegacyId.has(legacyId.toLowerCase()),
    hasTarget: (accountId: number): boolean => claimedAccountIds.has(accountId),
    size: byLegacyId.size,
  });
}

/**
 * A conflict record shaped for `migration.conflict_report`.
 *
 * It carries a class, the source relation/column, a count and a decision
 * string.  Raw source values never enter it: the physical contract is explicit
 * that counts and decisions go here and values go to a named evidence table.
 */
export type ConflictRecord = Readonly<{
  conflict_class: string;
  source_relation: string;
  source_column: string;
  conflict_count: number;
  decision: string;
  details: Readonly<Record<string, string | number | boolean>>;
}>;

type ConflictSeed = Readonly<{
  conflict_class: string;
  source_relation: string;
  source_column: string;
  decision: string;
  details?: Readonly<Record<string, string | number | boolean>>;
}>;

/**
 * Accumulate conflict counts without retaining any source value.
 *
 * The collector is bounded by the number of distinct conflict classes, not by
 * the number of rows, so a whole-library run holds a fixed-size report.
 */
export class ConflictCollector {
  private readonly entries = new Map<string, { seed: ConflictSeed; count: number }>();

  record(seed: ConflictSeed, increment = 1): void {
    if (!Number.isSafeInteger(increment) || increment < 0) {
      libraryFailure("library_input_invalid", "conflict_report", "conflict_count");
    }
    const key = `${seed.conflict_class}\u0000${seed.source_relation}\u0000${seed.source_column}`;
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, { seed, count: increment });
      return;
    }
    existing.count += increment;
    if (!Number.isSafeInteger(existing.count)) {
      libraryFailure("library_target_overflow", "conflict_report", "conflict_count");
    }
  }

  count(conflictClass: string): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.seed.conflict_class === conflictClass) total += entry.count;
    }
    return total;
  }

  /** Deterministic order: class, then relation, then column. */
  toRecords(): readonly ConflictRecord[] {
    const records = [...this.entries.values()].map(({ seed, count }) =>
      Object.freeze({
        conflict_class: seed.conflict_class,
        source_relation: seed.source_relation,
        source_column: seed.source_column,
        conflict_count: count,
        decision: seed.decision,
        details: Object.freeze({ ...(seed.details ?? {}) }),
      }),
    );
    records.sort((left, right) => {
      if (left.conflict_class !== right.conflict_class) {
        return left.conflict_class < right.conflict_class ? -1 : 1;
      }
      if (left.source_relation !== right.source_relation) {
        return left.source_relation < right.source_relation ? -1 : 1;
      }
      return left.source_column < right.source_column ? -1 : left.source_column > right.source_column ? 1 : 0;
    });
    return Object.freeze(records);
  }
}

export function checkRowLimit(rows: readonly unknown[], relation: string, maxRows: number): void {
  if (!Number.isSafeInteger(maxRows) || maxRows < 0) {
    libraryFailure("library_input_invalid", relation, "maxRows");
  }
  if (rows.length > maxRows) libraryFailure("library_row_limit", relation, null, rows.length);
}

/** Exact integer text for a JSON/COPY/SQL boundary; never a float. */
export function integerText(value: bigint): string {
  return value.toString(10);
}

const TEN = BigInt(10);

/**
 * The exact product `value * 10^targetScale` when it is an integer, else null.
 *
 * A null result means the destination scale cannot hold the source value
 * without rounding, which is a conflict for the caller to report rather than a
 * rounding it may perform.
 */
export function decimalToScaledInteger(value: PgDecimal, targetScale: number): bigint | null {
  if (!Number.isSafeInteger(targetScale) || targetScale < 0 || targetScale > 64) {
    libraryFailure("library_invalid_decimal", "decimal_scale", null);
  }
  if (value.coefficient === ZERO) return ZERO;
  const shift = targetScale - value.scale;
  if (shift >= 0) {
    if (shift > 64) return null;
    const scaled = value.coefficient * TEN ** BigInt(shift);
    return value.sign < 0 ? -scaled : scaled;
  }
  const divisor = TEN ** BigInt(-shift);
  if (value.coefficient % divisor !== ZERO) return null;
  const scaled = value.coefficient / divisor;
  return value.sign < 0 ? -scaled : scaled;
}

/** Exact integer product, or null when multiplication still leaves a fraction. */
export function decimalTimesIntegerToInteger(value: PgDecimal, factor: bigint): bigint | null {
  if (typeof factor !== "bigint") libraryFailure("library_invalid_decimal", "decimal_factor", null);
  const signed = (value.sign < 0 ? -value.coefficient : value.coefficient) * factor;
  if (value.scale <= 0) return signed * TEN ** BigInt(-value.scale);
  const divisor = TEN ** BigInt(value.scale);
  return signed % divisor === ZERO ? signed / divisor : null;
}

/** True when the value fits `numeric(precision, scale)` with no rounding. */
export function fitsNumeric(value: PgDecimal, precision: number, scale: number): boolean {
  const scaled = decimalToScaledInteger(value, scale);
  if (scaled === null) return false;
  const magnitude = scaled < ZERO ? -scaled : scaled;
  return magnitude < TEN ** BigInt(precision);
}

/**
 * A provable upper bound, in bytes, for `pg_column_size()` of the JSONB object
 * a flat evidence payload becomes.
 *
 * The M1/M3 evidence columns are guarded by `pg_column_size(evidence) <= N`,
 * and JSONB is not the same size as its JSON text: it adds a varlena header, a
 * container header, a 4-byte JEntry per key and per value, alignment padding,
 * and a binary `numeric` for every JSON number.  Comparing the JSON text
 * length against the SQL bound would therefore under-count.  Every term below
 * is deliberately generous, so a payload this function accepts is smaller than
 * the bound in PostgreSQL as well.
 *
 * A JSON number here always came from a JavaScript double, which carries at
 * most 17 significant digits and so at most 5 base-10000 `numeric` digits; 32
 * bytes covers the header, the digits and the worst alignment padding.  A
 * boolean and a null are encoded entirely inside their JEntry and add nothing.
 */
export function jsonbUpperBoundBytes(value: Readonly<Record<string, string | number | boolean>>): number {
  // 4-byte varlena header (worst case) plus the JsonbContainer header.
  let total = 8;
  for (const [key, entry] of Object.entries(value)) {
    // One JEntry for the key and one for the value, plus alignment slack.
    total += 8 + 3;
    total += Buffer.byteLength(key, "utf8");
    if (typeof entry === "string") {
      total += Buffer.byteLength(entry, "utf8") + 3;
    } else if (typeof entry === "number") {
      total += 32;
    }
  }
  return total;
}

export function bigintToTargetInteger(value: bigint, relation: string, field: string): number {
  if (value < ZERO || value > TARGET_INTEGER_MAX) libraryFailure("library_target_overflow", relation, field);
  return Number(value);
}

export function compareBigints(left: bigint, right: bigint): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareText(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}
