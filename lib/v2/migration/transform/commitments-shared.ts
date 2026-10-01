import { ExportError } from "../shared/redaction.ts";
import {
  CatalogueValueError,
  encodeJsonStringArray,
  inspectJsonDocument,
  parsePgTextArray,
  utf8ByteLength,
  type JsonDocument,
  type PgTextArray,
} from "./catalogue-values.ts";
import {
  asObject,
  canonicalUuid,
  checkRowLimit,
  checkRowRunIdentity,
  codePointLength,
  ConflictCollector,
  fitsBoundedText,
  fitsNumeric,
  indexAccountMap,
  indexGameMap,
  integerText,
  parsePgIntegerArray,
  pgBtrim,
  requiredInteger,
  requiredTimestamp,
  optionalTimestamp,
  steamAppId,
  TARGET_BIGINT_MAX,
  TARGET_INTEGER_MAX,
  validateRunIdentity,
  type AccountMapIndex,
  type GameMapIndex,
  type LibraryRunIdentity,
} from "./library-shared.ts";
import { parsePgDecimal, type PgDecimal, type PgTimestamp, ScalarError } from "./scalars.ts";

/**
 * Shared vocabulary for the M3-G domain: collections and their ordered
 * membership, pins, snoozes, vault state and the three draw-history relations.
 *
 * Nothing here builds an identity map of its own.  The game map belongs to the
 * catalogue implementer, the per-account library-row map belongs to the library
 * implementer and the account map belongs to the identity transform; this
 * module only indexes and reads them.  Exact readers for PostgreSQL array and
 * JSON text come from `catalogue-values.ts` for the same reason: a second
 * implementation of a grammar is a second set of disagreements.
 */

/** COPY cells stay `string | null` until a reviewed conversion happens. */
export type M3GCell = string | null;

/** Every source row may carry the run it was read in, and it is checked. */
export type M3GSourceRunTag = Readonly<{
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/** Shared, redaction-safe failure vocabulary for the M3-G pure transforms. */
export class M3GTransformError extends ExportError {
  readonly m3gCode: string;
  readonly diagnostics: readonly M3GDiagnostic[];

  constructor(code: string, diagnostic: M3GDiagnostic) {
    super(code, "The M3-G transform found a reconciliation blocker.", {
      relation: diagnostic.relation,
      field: diagnostic.field,
      count: diagnostic.count,
    });
    this.name = "M3GTransformError";
    this.m3gCode = code;
    this.diagnostics = Object.freeze([Object.freeze({ ...diagnostic })]);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), diagnostics: this.diagnostics };
  }
}

export type M3GDiagnostic = Readonly<{
  code: string;
  relation: string;
  field: string | null;
  count: number;
}>;

export function m3Failure(code: string, relation: string, field: string | null = null, count = 1): never {
  throw new M3GTransformError(code, { code, relation, field, count });
}

export type M3GRunIdentity = LibraryRunIdentity;

export function m3RunIdentity(value: unknown): M3GRunIdentity {
  try {
    return validateRunIdentity(value);
  } catch {
    return m3Failure("m3g_run_invalid", "run_identity");
  }
}

export function m3Object(value: unknown, relation: string): Record<string, unknown> {
  try {
    return asObject(value, relation);
  } catch {
    return m3Failure("m3g_input_invalid", relation);
  }
}

export function m3Rows(value: unknown, relation: string, maxRows: number): readonly object[] {
  if (!Array.isArray(value)) return m3Failure("m3g_input_invalid", relation);
  try {
    checkRowLimit(value, relation, maxRows);
  } catch {
    return m3Failure("m3g_row_limit", relation, null, value.length);
  }
  return value as readonly object[];
}

export function m3CheckRowIdentity(row: object, run: M3GRunIdentity, relation: string): void {
  try {
    checkRowRunIdentity(row, run, relation);
  } catch {
    m3Failure("m3g_mixed_run_identity", relation);
  }
}

/** A required source cell: present and text, never an absent key. */
export function m3Cell(row: object, key: string, relation: string): string {
  const value = (row as Record<string, unknown>)[key];
  if (typeof value !== "string") m3Failure("m3g_input_invalid", relation, key);
  return value as string;
}

/** A nullable source cell. `undefined` is a malformed input, not a NULL. */
export function m3NullableCell(row: object, key: string, relation: string): string | null {
  const value = (row as Record<string, unknown>)[key];
  if (value === null) return null;
  if (typeof value !== "string") m3Failure("m3g_input_invalid", relation, key);
  return value as string;
}

/** An optional evidence cell that a source COPY need not supply at all. */
export function m3OptionalCell(row: object, key: string, relation: string): string | null {
  const value = (row as Record<string, unknown>)[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") m3Failure("m3g_input_invalid", relation, key);
  return value as string;
}

export function m3AccountMap(value: unknown, run: M3GRunIdentity): AccountMapIndex {
  try {
    return indexAccountMap(value, run);
  } catch {
    return m3Failure("m3g_account_map_invalid", "account_map");
  }
}

export function m3GameMap(value: unknown, run: M3GRunIdentity): GameMapIndex {
  try {
    return indexGameMap(value, run);
  } catch {
    return m3Failure("m3g_game_map_invalid", "game_map");
  }
}

/**
 * The library-row map, produced by the library implementer.
 *
 * It is the only way a legacy `user_games` UUID becomes a catalogue game here.
 * The record shape is the library contract's, not a local invention, and the
 * index enforces the two per-account uniqueness properties that contract
 * states so that a malformed map fails instead of silently letting two source
 * rows collapse onto one target key.
 */
export type LibraryRowMapRecord = Readonly<{
  legacy_id: string;
  account_id: number;
  game_id: number;
  steam_appid: string;
  source_snapshot_hash: string;
}>;

export type LibraryRowMapIndex = Readonly<{
  lookup: (legacyId: string) => LibraryRowMapRecord;
  has: (legacyId: string) => boolean;
  size: number;
}>;

export function m3LibraryRowMap(value: unknown, run: M3GRunIdentity): LibraryRowMapIndex {
  const rows = m3Rows(value, "library_row_map", 5_000_000);
  const byLegacy = new Map<string, LibraryRowMapRecord>();
  const accountGame = new Set<string>();
  const accountApp = new Set<string>();
  for (const raw of rows) {
    const row = m3Object(raw, "library_row_map");
    const legacy = row.legacy_id;
    const appId = row.steam_appid;
    const snapshot = row.source_snapshot_hash;
    if (typeof legacy !== "string" || typeof appId !== "string" || typeof snapshot !== "string") {
      m3Failure("m3g_library_map_invalid", "library_row_map");
    }
    const legacyUuid = m3Uuid(legacy, "library_row_map", "legacy_id").canonical;
    if (snapshot !== run.snapshotHash) m3Failure("m3g_mixed_run_identity", "library_row_map", "source_snapshot_hash");
    let app: { source: string; target: bigint };
    try {
      app = steamAppId(appId as string, "library_row_map", "steam_appid");
    } catch {
      return m3Failure("m3g_library_map_invalid", "library_row_map", "steam_appid");
    }
    const account = row.account_id;
    const game = row.game_id;
    if (
      !isTargetInteger(account) ||
      !isTargetInteger(game)
    ) {
      m3Failure("m3g_library_map_invalid", "library_row_map");
    }
    if (byLegacy.has(legacyUuid)) m3Failure("m3g_duplicate_identity", "library_row_map", "legacy_id");
    const accountGameKey = `${account as number}/${game as number}`;
    const accountAppKey = `${account as number}/${app.source}`;
    if (accountGame.has(accountGameKey)) m3Failure("m3g_duplicate_identity", "library_row_map", "game_id");
    if (accountApp.has(accountAppKey)) m3Failure("m3g_duplicate_identity", "library_row_map", "steam_appid");
    const record: LibraryRowMapRecord = Object.freeze({
      legacy_id: legacy as string,
      account_id: account as number,
      game_id: game as number,
      steam_appid: app.source,
      source_snapshot_hash: snapshot as string,
    });
    byLegacy.set(legacyUuid, record);
    accountGame.add(accountGameKey);
    accountApp.add(accountAppKey);
  }
  return Object.freeze({
    lookup: (legacyId: string): LibraryRowMapRecord => {
      if (typeof legacyId !== "string") m3Failure("m3g_library_unmapped", "library_row_map", "legacy_id");
      const value = byLegacy.get(legacyId.toLowerCase());
      if (value === undefined) m3Failure("m3g_library_unmapped", "library_row_map", "legacy_id");
      return value;
    },
    has: (legacyId: string): boolean => typeof legacyId === "string" && byLegacy.has(legacyId.toLowerCase()),
    size: byLegacy.size,
  });
}

function isTargetInteger(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    BigInt(value) <= TARGET_INTEGER_MAX
  );
}

function isTargetBigint(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    BigInt(value) <= TARGET_BIGINT_MAX
  );
}

/** `migration.collection_map`, produced by `collections.ts` in the same run. */
export type CollectionMapRecord = Readonly<{
  legacy_id: string;
  account_id: number;
  collection_id: number;
  source_snapshot_hash: string;
}>;

export type CollectionMapIndex = Readonly<{
  lookup: (legacyId: string) => CollectionMapRecord;
  has: (legacyId: string) => boolean;
  size: number;
}>;

export function m3CollectionMap(value: unknown, run: M3GRunIdentity): CollectionMapIndex {
  const rows = m3Rows(value, "collection_map", 5_000_000);
  const byLegacy = new Map<string, CollectionMapRecord>();
  const targetIds = new Set<number>();
  for (const raw of rows) {
    const row = m3Object(raw, "collection_map");
    if (typeof row.legacy_id !== "string" || typeof row.source_snapshot_hash !== "string") {
      m3Failure("m3g_collection_map_invalid", "collection_map");
    }
    const legacy = m3Uuid(row.legacy_id, "collection_map", "legacy_id").canonical;
    if (row.source_snapshot_hash !== run.snapshotHash) {
      m3Failure("m3g_mixed_run_identity", "collection_map", "source_snapshot_hash");
    }
    if (!isTargetInteger(row.account_id) || !isTargetBigint(row.collection_id)) {
      m3Failure("m3g_collection_map_invalid", "collection_map");
    }
    if (byLegacy.has(legacy) || targetIds.has(row.collection_id as number)) {
      m3Failure("m3g_duplicate_identity", "collection_map");
    }
    const record: CollectionMapRecord = Object.freeze({
      legacy_id: row.legacy_id as string,
      account_id: row.account_id as number,
      collection_id: row.collection_id as number,
      source_snapshot_hash: row.source_snapshot_hash as string,
    });
    byLegacy.set(legacy, record);
    targetIds.add(row.collection_id as number);
  }
  return Object.freeze({
    lookup: (legacyId: string): CollectionMapRecord => {
      if (typeof legacyId !== "string") m3Failure("m3g_collection_unmapped", "collection_map", "legacy_id");
      const record = byLegacy.get(legacyId.toLowerCase());
      if (record === undefined) m3Failure("m3g_collection_unmapped", "collection_map", "legacy_id");
      return record;
    },
    has: (legacyId: string): boolean => typeof legacyId === "string" && byLegacy.has(legacyId.toLowerCase()),
    size: byLegacy.size,
  });
}

/**
 * A draw map emitted by `draws.ts` and consumed by its own child relations.
 *
 * There is no `migration.draw_map` relation in the applied schema, so this map
 * is an in-run join structure rather than a target record: draw events resolve
 * their parent through it and never through row position.
 */
export type DrawMapRecord = Readonly<{
  legacy_id: string;
  account_id: number;
  draw_id: number;
  public_id: string;
  source_snapshot_hash: string;
}>;

export type DrawMapIndex = Readonly<{
  lookup: (legacyId: string) => DrawMapRecord;
  has: (legacyId: string) => boolean;
  size: number;
}>;

export function m3DrawMap(value: unknown, run: M3GRunIdentity): DrawMapIndex {
  const rows = m3Rows(value, "draw_map", 5_000_000);
  const byLegacy = new Map<string, DrawMapRecord>();
  const targetIds = new Set<number>();
  const publicIds = new Set<string>();
  for (const raw of rows) {
    const row = m3Object(raw, "draw_map");
    if (
      typeof row.legacy_id !== "string" ||
      typeof row.public_id !== "string" ||
      typeof row.source_snapshot_hash !== "string"
    ) {
      m3Failure("m3g_draw_map_invalid", "draw_map");
    }
    const legacy = m3Uuid(row.legacy_id, "draw_map", "legacy_id").canonical;
    const publicId = m3Uuid(row.public_id, "draw_map", "public_id").canonical;
    if (row.source_snapshot_hash !== run.snapshotHash) {
      m3Failure("m3g_mixed_run_identity", "draw_map", "source_snapshot_hash");
    }
    if (!isTargetInteger(row.account_id) || !isTargetBigint(row.draw_id)) {
      m3Failure("m3g_draw_map_invalid", "draw_map");
    }
    if (byLegacy.has(legacy) || targetIds.has(row.draw_id as number) || publicIds.has(publicId)) {
      m3Failure("m3g_duplicate_identity", "draw_map");
    }
    const record: DrawMapRecord = Object.freeze({
      legacy_id: row.legacy_id as string,
      account_id: row.account_id as number,
      draw_id: row.draw_id as number,
      public_id: row.public_id as string,
      source_snapshot_hash: row.source_snapshot_hash as string,
    });
    byLegacy.set(legacy, record);
    targetIds.add(row.draw_id as number);
    publicIds.add(publicId);
  }
  return Object.freeze({
    lookup: (legacyId: string): DrawMapRecord => {
      if (typeof legacyId !== "string") m3Failure("m3g_draw_unmapped", "draw_map", "legacy_id");
      const record = byLegacy.get(legacyId.toLowerCase());
      if (record === undefined) m3Failure("m3g_draw_unmapped", "draw_map", "legacy_id");
      return record;
    },
    has: (legacyId: string): boolean => typeof legacyId === "string" && byLegacy.has(legacyId.toLowerCase()),
    size: byLegacy.size,
  });
}

/**
 * Resolve a legacy account UUID through the same-run account map.
 *
 * The map's own failure vocabulary belongs to the library module, so it is
 * translated here: an M3-G caller sees one stable M3-G code and no source value.
 */
export function m3LookupAccount(index: AccountMapIndex, legacyId: string, relation: string, field: string): number {
  if (!index.has(legacyId)) m3Failure("m3g_account_unmapped", relation, field);
  try {
    return index.lookup(legacyId);
  } catch {
    return m3Failure("m3g_account_unmapped", relation, field);
  }
}

/** Identity, never ownership: a hit proves a catalogue row exists, nothing more. */
export function m3LookupGame(index: GameMapIndex, appIdText: string, relation: string, field: string): number {
  if (!index.has(appIdText)) m3Failure("m3g_game_unmapped", relation, field);
  try {
    return index.lookup(appIdText);
  } catch {
    return m3Failure("m3g_game_unmapped", relation, field);
  }
}

export function m3Uuid(value: unknown, relation: string, field: string): { original: string; canonical: string } {
  if (typeof value !== "string") m3Failure("m3g_invalid_uuid", relation, field);
  try {
    return canonicalUuid(value as string, relation, field);
  } catch {
    return m3Failure("m3g_invalid_uuid", relation, field);
  }
}

/** Text for a `length(x) <= max` destination, with no truncation anywhere. */
export function m3RequiredText(value: unknown, relation: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || !fitsBoundedText(value as string, maxLength) || pgBtrim(value as string).length === 0) {
    m3Failure("m3g_invalid_text", relation, field);
  }
  return value as string;
}

export function m3NullableText(
  value: unknown,
  relation: string,
  field: string,
  maxLength: number,
  emptyToNull = false,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !fitsBoundedText(value as string, maxLength)) {
    m3Failure("m3g_invalid_text", relation, field);
  }
  return emptyToNull && (value as string).length === 0 ? null : (value as string);
}

/**
 * Text for a `length(btrim(x)) between 1 and max` destination.
 *
 * The bound is checked on the trimmed length exactly as the target does, and
 * the stored value stays the untrimmed source text: trimming it here would be
 * a silent rewrite of a value the target accepts as-is.
 */
export function m3BtrimBoundedText(value: unknown, relation: string, field: string, maxLength: number): string {
  if (typeof value !== "string") m3Failure("m3g_invalid_text", relation, field);
  const trimmed = pgBtrim(value as string);
  const length = codePointLength(trimmed);
  if (length < 1 || length > maxLength) m3Failure("m3g_invalid_text", relation, field);
  return value as string;
}

export function m3NullableBtrimBoundedText(
  value: unknown,
  relation: string,
  field: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  return m3BtrimBoundedText(value, relation, field, maxLength);
}

export function m3Timestamp(value: unknown, relation: string, field: string): PgTimestamp {
  if (typeof value !== "string") m3Failure("m3g_invalid_timestamp", relation, field);
  try {
    return requiredTimestamp(value as string, relation, field);
  } catch {
    return m3Failure("m3g_invalid_timestamp", relation, field);
  }
}

export function m3OptionalTimestamp(value: unknown, relation: string, field: string): PgTimestamp | null {
  if (value === null) return null;
  if (typeof value !== "string") m3Failure("m3g_invalid_timestamp", relation, field);
  try {
    return optionalTimestamp(value as string, relation, field);
  } catch {
    return m3Failure("m3g_invalid_timestamp", relation, field);
  }
}

export function m3Integer(value: unknown, relation: string, field: string, min: bigint, max: bigint): bigint {
  if (typeof value !== "string") m3Failure("m3g_invalid_integer", relation, field);
  try {
    return requiredInteger(value as string, relation, field, { min, max });
  } catch {
    return m3Failure("m3g_invalid_integer", relation, field);
  }
}

export function m3TargetInteger(value: bigint, relation: string, field: string): number {
  if (value < BigInt(0) || value > TARGET_INTEGER_MAX) m3Failure("m3g_target_overflow", relation, field);
  return Number(value);
}

/**
 * An exact, canonically rendered Steam AppID.
 *
 * The canonical check matters for identity, not for range: the game map keys on
 * the exact source text, so `0042` and `42` must not be treated as the same
 * AppID by one side and different by the other.
 */
export function m3AppId(value: unknown, relation: string, field: string): { source: string; target: bigint } {
  if (typeof value !== "string") m3Failure("m3g_app_id_out_of_range", relation, field);
  try {
    return steamAppId(value as string, relation, field);
  } catch {
    return m3Failure("m3g_app_id_out_of_range", relation, field);
  }
}

/**
 * A positive bigint AppID for a destination whose only check is `> 0`.
 *
 * `vault_draws.steam_appid` is a source `bigint` and `app.vault_draws
 * .steam_app_id` checks only positivity, so narrowing to the catalogue's
 * 1..4294967295 range here would refuse a value the target accepts. The range
 * is reported instead: the game map simply will not hold an out-of-range AppID.
 */
export function m3PositiveBigintAppId(value: unknown, relation: string, field: string): string {
  if (typeof value !== "string") m3Failure("m3g_invalid_integer", relation, field);
  const parsed = m3Integer(value, relation, field, BigInt(1), TARGET_BIGINT_MAX);
  if (integerText(parsed) !== (value as string)) m3Failure("m3g_app_id_out_of_range", relation, field);
  return value as string;
}

/** A `text[]` source cell read exactly, with SQL NULL elements preserved. */
export function m3PgTextArray(
  value: unknown,
  relation: string,
  field: string,
  maxElements: number,
  maxTextLength: number,
): PgTextArray {
  if (typeof value !== "string") m3Failure("m3g_invalid_array", relation, field);
  let parsed: PgTextArray | null;
  try {
    parsed = parsePgTextArray(value as string, {
      field: `${relation}.${field}`,
      maxElements,
      maxTextLength,
    });
  } catch (error) {
    if (error instanceof CatalogueValueError) m3Failure("m3g_invalid_array", relation, field);
    throw error;
  }
  if (parsed === null) m3Failure("m3g_invalid_array", relation, field);
  return parsed;
}

export function m3PgIntegerArray(
  value: unknown,
  relation: string,
  field: string,
  min: bigint,
  max: bigint,
  maxElements: number,
): readonly bigint[] {
  if (typeof value !== "string") m3Failure("m3g_invalid_array", relation, field);
  try {
    return parsePgIntegerArray(value as string, relation, field, { min, max }, maxElements);
  } catch {
    return m3Failure("m3g_invalid_array", relation, field);
  }
}

/**
 * Encode exact integers as a JSON array.
 *
 * The elements are rendered from `bigint` text, never from a `Number`, so a
 * 64-bit AppID survives the `jsonb` destination intact.
 */
export function encodeJsonIntegerArray(values: readonly bigint[]): string {
  return `[${values.map((value) => integerText(value)).join(",")}]`;
}

export { encodeJsonStringArray };

/**
 * Inspect a JSON/JSONB source cell without materialising or re-serialising it.
 *
 * The returned `sourceText` is what the loader casts to `jsonb`; the reported
 * `utf8Bytes` is size *evidence* only. PostgreSQL's `pg_column_size` is an
 * on-disk measure of the binary jsonb datum after possible compression, so a
 * pure transform cannot decide that bound and this function never claims to.
 */
export function m3JsonDocument(
  value: unknown,
  relation: string,
  field: string,
  expected: "object" | "array",
  maxTextLength: number,
): JsonDocument {
  if (typeof value !== "string") m3Failure("m3g_invalid_json", relation, field);
  let document: JsonDocument | null;
  try {
    document = inspectJsonDocument(value as string, { field: `${relation}.${field}`, maxTextLength });
  } catch (error) {
    if (error instanceof CatalogueValueError) {
      m3Failure(error.valueCode === "catalogue_value_json_too_large" ? "m3g_json_oversize" : "m3g_invalid_json", relation, field);
    }
    throw error;
  }
  if (document === null) m3Failure("m3g_invalid_json", relation, field);
  if (document.topLevelType !== expected) m3Failure("m3g_invalid_json", relation, field);
  return document;
}

/**
 * A JSONB size observation that only real SQL can confirm.
 *
 * `bound_source` names the physical CHECK the observation relates to, and
 * `requires_sql_validation` is always true: the loader gate is the authority.
 */
export type JsonSizeAdvisory = Readonly<{
  relation: string;
  column: string;
  /** A browser-visible public UUID, never a private cell value. */
  public_id: string;
  utf8_bytes: number;
  pg_column_size_bound: number;
  bound_source: string;
  requires_sql_validation: true;
}>;

export function jsonSizeAdvisory(
  relation: string,
  column: string,
  publicId: string,
  document: JsonDocument,
  bound: number,
  boundSource: string,
): JsonSizeAdvisory {
  return Object.freeze({
    relation,
    column,
    public_id: publicId,
    utf8_bytes: document.utf8Bytes,
    pg_column_size_bound: bound,
    bound_source: boundSource,
    requires_sql_validation: true,
  });
}

export { utf8ByteLength };

function roundPositiveRational(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;
}

function decimalTimesIntegerRounded(value: PgDecimal, multiplier: bigint): bigint {
  const coefficient = value.coefficient * multiplier;
  let magnitude: bigint;
  if (value.scale <= 0) magnitude = coefficient * BigInt(10) ** BigInt(-value.scale);
  else magnitude = roundPositiveRational(coefficient, BigInt(10) ** BigInt(value.scale));
  return value.sign < 0 ? -magnitude : magnitude;
}

function decimalToExactInteger(value: PgDecimal, multiplier: bigint): bigint | null {
  const coefficient = value.coefficient * multiplier;
  if (value.scale <= 0) {
    const result = coefficient * BigInt(10) ** BigInt(-value.scale);
    return value.sign < 0 ? -result : result;
  }
  const divisor = BigInt(10) ** BigInt(value.scale);
  if (coefficient % divisor !== BigInt(0)) return null;
  const result = coefficient / divisor;
  return value.sign < 0 ? -result : result;
}

export type BaselineStatus = "exact_minutes" | "rounded_checked" | "unknown" | "conflict";

export type BaselineConversion = Readonly<{
  /** The parsed source decimal, or null when the source was NULL or non-finite. */
  hours: PgDecimal | null;
  /** `app.pins.legacy_hours_at_pin_raw`: the source text, never re-rendered. */
  hoursRaw: string | null;
  /** `app.pins.legacy_hours_at_pin`: canonical numeric(30,12) text, or null. */
  legacyHoursAtPin: string | null;
  /** `app.pins.personal_minutes_baseline`: whole minutes, or null. */
  personalMinutesBaseline: number | null;
  status: BaselineStatus;
}>;

/**
 * `user_game_pins.hours_at_pin` hours to `app.pins.personal_minutes_baseline`
 * minutes: a real unit change, done exactly and checked in both directions.
 *
 * The source column is `double precision` and COPY renders it as shortest
 * round-trip text, which is parsed as an exact decimal rather than through a
 * float. `hours * 60` that lands on a whole number is `exact_minutes`. A value
 * that needs rounding is accepted as `rounded_checked` only when
 * `round(minutes / 6) == round(hours * 10)`, the stated inverse to one decimal
 * place. Anything negative, non-finite, over the integer bound or failing the
 * inverse keeps its raw text and reports `conflict`; nothing is clamped and no
 * precision is claimed that the source never stored.
 */
export function m3Baseline(value: unknown, relation: string, field: string): BaselineConversion {
  if (value === null || value === undefined) {
    return Object.freeze({
      hours: null,
      hoursRaw: null,
      legacyHoursAtPin: null,
      personalMinutesBaseline: null,
      status: "unknown",
    });
  }
  if (typeof value !== "string" || codePointLength(value as string) > 128) {
    m3Failure("m3g_invalid_decimal", relation, field);
  }
  const raw = value as string;
  let decimal: PgDecimal | null;
  try {
    decimal = parsePgDecimal(raw, { field: `${relation}.${field}` });
  } catch (error) {
    if (error instanceof ScalarError && error.scalarCode === "scalar_decimal_nonfinite") {
      // `NaN`/`Infinity` is a real double the target cannot represent as
      // minutes. The text is preserved and the case is reported, not dropped.
      return Object.freeze({
        hours: null,
        hoursRaw: raw,
        legacyHoursAtPin: null,
        personalMinutesBaseline: null,
        status: "conflict",
      });
    }
    if (error instanceof ScalarError) m3Failure("m3g_invalid_decimal", relation, field);
    throw error;
  }
  if (decimal === null) m3Failure("m3g_invalid_decimal", relation, field);
  const parsed = decimal as PgDecimal;
  const legacyHoursAtPin = fitsNumeric(parsed, 30, 12) ? parsed.toCanonicalString() : null;
  if (parsed.sign < 0 || legacyHoursAtPin === null) {
    return Object.freeze({
      hours: parsed,
      hoursRaw: raw,
      legacyHoursAtPin,
      personalMinutesBaseline: null,
      status: "conflict",
    });
  }
  const exactMinutes = decimalToExactInteger(parsed, BigInt(60));
  if (exactMinutes !== null) {
    if (exactMinutes > TARGET_INTEGER_MAX) {
      return Object.freeze({
        hours: parsed,
        hoursRaw: raw,
        legacyHoursAtPin,
        personalMinutesBaseline: null,
        status: "conflict",
      });
    }
    return Object.freeze({
      hours: parsed,
      hoursRaw: raw,
      legacyHoursAtPin,
      personalMinutesBaseline: Number(exactMinutes),
      status: "exact_minutes",
    });
  }
  const roundedMinutes = decimalTimesIntegerRounded(parsed, BigInt(60));
  const sourceTenths = decimalTimesIntegerRounded(parsed, BigInt(10));
  const reconstructedTenths = roundPositiveRational(roundedMinutes, BigInt(6));
  if (roundedMinutes < BigInt(0) || roundedMinutes > TARGET_INTEGER_MAX || sourceTenths !== reconstructedTenths) {
    return Object.freeze({
      hours: parsed,
      hoursRaw: raw,
      legacyHoursAtPin,
      personalMinutesBaseline: null,
      status: "conflict",
    });
  }
  return Object.freeze({
    hours: parsed,
    hoursRaw: raw,
    legacyHoursAtPin,
    personalMinutesBaseline: Number(roundedMinutes),
    status: "rounded_checked",
  });
}

export function m3ConflictCollector(): ConflictCollector {
  return new ConflictCollector();
}

export function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function compareTimestamp(left: PgTimestamp, right: PgTimestamp): number {
  return left.epochMicros < right.epochMicros ? -1 : left.epochMicros > right.epochMicros ? 1 : 0;
}

export function compareUuid(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Nulls sort last, so a row with no order evidence never outranks one with it. */
export function compareNullableBigint(left: bigint | null, right: bigint | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A required reference must stay inside one tenant. */
export function sameTenant(expected: number, actual: number, relation: string, field: string): void {
  if (expected !== actual) m3Failure("m3g_cross_tenant_reference", relation, field);
}

export function ensureSourceHash(value: unknown, run: M3GRunIdentity, relation: string): string {
  if (typeof value !== "string" || value !== run.snapshotHash) {
    m3Failure("m3g_mixed_run_identity", relation, "source_snapshot_hash");
  }
  return value as string;
}

export const STAGING_RETENTION_CLASS = "staging-30d-post-cutover";

export { integerText, TARGET_BIGINT_MAX, TARGET_INTEGER_MAX };
export type { AccountMapIndex, GameMapIndex, JsonDocument, PgDecimal, PgTextArray, PgTimestamp };
export type { ConflictRecord } from "./library-shared.ts";
