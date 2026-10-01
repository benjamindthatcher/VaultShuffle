import { ExportError } from "../shared/redaction.ts";
import { parsePgInteger, ScalarError } from "./scalars.ts";

/**
 * The shared M3-F game map.
 *
 * Five legacy relations address a game by the per-account library UUID and a
 * sixth carries a nullable AppID with no foreign key, so both domain
 * transforms have to resolve identity through one agreed mapping.  The shape
 * published in `docs/v2-claude-domain-transforms.md` is the contract; this
 * module implements it and adds only the builder inputs and evidence that the
 * contract already requires.  It deliberately mirrors `accounts.ts`: the same
 * run-identity checks, the same redaction-safe failures, the same
 * deterministic sort-then-number discipline.
 *
 * This module is pure.  It performs no filesystem, database, network or target
 * access, and it never derives an instant from a wall clock.
 */

/** COPY cells stay `string | null` until a reviewed conversion consumes them. */
export type GameMapCell = string | null;

export type GameMapErrorCode =
  | "game_map_run_invalid"
  | "game_map_mixed_run_identity"
  | "game_map_input_invalid"
  | "game_map_count_limit"
  | "game_map_app_id_invalid"
  | "game_map_app_id_out_of_range"
  | "game_map_duplicate_identity"
  | "game_map_conflicting_identity"
  | "game_map_missing_reference"
  | "game_map_reference_identity_missing"
  | "game_map_stub_invalid"
  | "game_map_stub_unneeded"
  | "game_map_game_id_overflow"
  | "game_map_inconsistent"
  | "game_map_unknown_app_id";

const GAME_MAP_MESSAGES: Readonly<Record<GameMapErrorCode, string>> = {
  game_map_run_invalid: "The game map run identity is invalid.",
  game_map_mixed_run_identity: "Game map rows do not belong to one explicit migration run.",
  game_map_input_invalid: "The game map input shape is invalid.",
  game_map_count_limit: "The game map identity bound was exceeded.",
  game_map_app_id_invalid: "A source Steam AppID is not exact canonical PostgreSQL integer text.",
  game_map_app_id_out_of_range: "A source Steam AppID is outside the supported AppID or target key range.",
  game_map_duplicate_identity: "The source contains duplicate catalogue identities.",
  game_map_conflicting_identity: "A catalogue identity is claimed by more than one source kind.",
  game_map_missing_reference: "A source relation references a Steam AppID with no catalogue identity.",
  game_map_reference_identity_missing: "A required game reference has no source Steam AppID.",
  game_map_stub_invalid: "Catalogue stub evidence does not satisfy the documented fallback rule.",
  game_map_stub_unneeded: "Catalogue stub evidence was supplied for an AppID the catalogue already contains.",
  game_map_game_id_overflow: "The deterministic catalogue identity does not fit the target integer range.",
  game_map_inconsistent: "The supplied game map is not one internally consistent same-run map.",
  game_map_unknown_app_id: "The game map has no entry for the requested source Steam AppID.",
};

export type GameMapDiagnostic = Readonly<{
  code: GameMapErrorCode;
  relation: string;
  field: string | null;
  count: number;
}>;

/**
 * A game map error carries only a stable code, a source relation/field and a
 * count.  It never carries an AppID, a title, a UUID or a timestamp: a
 * catalogue identity joined against an account is an account fact, and the
 * standing rule is that no source value reaches a message or a log.
 */
export class GameMapError extends ExportError {
  readonly gameMapCode: GameMapErrorCode;
  readonly diagnostics: readonly GameMapDiagnostic[];

  constructor(code: GameMapErrorCode, diagnostic: GameMapDiagnostic) {
    super(code, GAME_MAP_MESSAGES[code], {
      relation: diagnostic.relation,
      field: diagnostic.field,
      count: diagnostic.count,
    });
    this.name = "GameMapError";
    this.gameMapCode = code;
    this.diagnostics = Object.freeze([Object.freeze({ ...diagnostic })]);
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), diagnostics: this.diagnostics };
  }
}

export function gameMapFailure(
  code: GameMapErrorCode,
  relation: string,
  field: string | null = null,
  count = 1,
): never {
  throw new GameMapError(code, { code, relation, field, count });
}

const RUN_ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_TEXT = /^[0-9a-f]{64}$/;
const RELATION_TEXT = /^[a-z_][a-z0-9_]{0,62}$/;
const FIELD_TEXT = /^[a-z_][a-z0-9_]{0,62}$/;

/** M1 `catalog.games.steam_app_id between 1 and 4294967295` (unsigned 32-bit). */
export const STEAM_APP_ID_MIN = BigInt(1);
export const STEAM_APP_ID_MAX = BigInt("4294967295");
/** M1 `catalog.games.id` is `integer generated always as identity`. */
export const TARGET_GAME_ID_MAX = 2147483647;

const MAX_STUB_REASON_LENGTH = 500;
const MAX_STUB_TITLE_LENGTH = 500;

export type GameMapRunIdentity = Readonly<{
  runId: string;
  snapshotHash: string;
  /** Optional labels copied from the verified export manifest. */
  sourceProjectRef?: string;
  sourceDatabase?: string;
}>;

/* -------------------------------------------------------------------------
 * The published interface.  These three declarations are the integration
 * contract in docs/v2-claude-domain-transforms.md and are not redesigned here.
 * ---------------------------------------------------------------------- */

export type GameMapTargetRecord = Readonly<{
  /** Exact source AppID text. Never a number, never re-rendered. */
  legacy_app_id: string;
  /** Target catalog.games.id. */
  game_id: number;
  /** Where the identity came from, so a stub is never mistaken for a catalogue row. */
  source_kind: "catalog_games" | "stub";
  source_snapshot_hash: string;
}>;

export type GameMap = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  entries: readonly GameMapTargetRecord[];
}>;

/* ---------------------------------------------------------------------- */

/**
 * One `catalog_games` identity.  Only the primary key is read here; the rest
 * of the 58-column disposition belongs to `catalogue.ts`.
 */
export type CatalogueGameIdentityRow = Readonly<{
  steam_appid: GameMapCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/**
 * An AppID that some other source relation requires to resolve to a catalogue
 * row.  `relation`/`field` name the actual source column so a missing
 * reference names the relation that needs it without naming the value.
 */
export type GameReferenceRow = Readonly<{
  relation: string;
  field: string;
  steam_appid: GameMapCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/**
 * Evidence that a catalogue row must exist for an AppID the source catalogue
 * does not contain.
 *
 * A stub is never created by inference.  The caller supplies this record, and
 * the documented fallback rule is the one the live import path already uses:
 * `title_source = 'catalog_stub'` with the title `Steam App <appid>`
 * (`lib/v2/import/steam-owned-snapshot.ts`, M2 contract, v2 import contract).
 * `source_relation_title` is the alternative for a caller that has a real
 * source title to preserve; the title is then supplied, never invented.  No
 * timestamp is accepted, because the source has none to give.
 */
export type CatalogueStubEvidence = Readonly<{
  steam_appid: GameMapCell;
  title_provenance: "catalog_stub_fallback" | "source_relation_title";
  /** Required for `source_relation_title`; rejected for the fallback rule. */
  title?: GameMapCell;
  required_by_relation: string;
  required_by_field: string;
  /** Bounded operator text recording why the stub is required. */
  reason: string;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

export type GameMapInput = Readonly<{
  runIdentity: GameMapRunIdentity;
  /** The complete `catalog_games` identity set for this snapshot. */
  catalogueGames: readonly CatalogueGameIdentityRow[];
  /** Every AppID the real source relationships require to resolve. */
  references?: readonly GameReferenceRow[];
  /** Explicit stub evidence; never inferred from a missing reference. */
  stubs?: readonly CatalogueStubEvidence[];
}>;

export type GameMapOptions = Readonly<{
  /** Maximum complete catalogue union held by this bounded phase. */
  maxGames?: number;
  /** Maximum reference rows inspected in one call. */
  maxReferences?: number;
}>;

/**
 * A catalogue row that exists only because another relation required it.
 *
 * It carries no `first_seen_at`, `last_seen_at` or `updated_at`: the source
 * has no such instant for an AppID it never catalogued, and inventing one
 * would fabricate provenance.  `catalogue.ts` turns this into the
 * `catalog.games` row and leaves those target columns to their defaults.
 */
export type GameStubTargetRecord = Readonly<{
  legacy_app_id: string;
  game_id: number;
  title: string;
  normalized_sort_title: string;
  title_source: "catalog_stub";
  title_provenance: "catalog_stub_fallback" | "source_relation_title";
  required_by_relation: string;
  required_by_field: string;
  reason: string;
  source_snapshot_hash: string;
}>;

export type GameMapBuildResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  map: GameMap;
  stubs: readonly GameStubTargetRecord[];
  counts: Readonly<{
    catalogue_identities: number;
    stub_identities: number;
    mapped_identities: number;
    resolved_references: number;
  }>;
}>;

function asObject(value: unknown, relation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    gameMapFailure("game_map_input_invalid", relation);
  }
  return value as Record<string, unknown>;
}

function ensureArray(value: unknown, relation: string): readonly object[] {
  if (!Array.isArray(value)) gameMapFailure("game_map_input_invalid", relation);
  return value as readonly object[];
}

function optionalAlias(row: object, first: string, second: string): unknown {
  const record = row as Record<string, unknown>;
  const left = record[first];
  const right = record[second];
  if (left !== undefined && right !== undefined && left !== right) return { mismatch: true };
  // `null` is an explicitly supplied malformed identity, not the same thing
  // as an omitted alias.  Preserve it so the runtime type check rejects it.
  return left !== undefined ? left : right;
}

function checkRowRunIdentity(row: object, run: GameMapRunIdentity, relation: string): void {
  const rowRunId = optionalAlias(row, "runId", "run_id");
  const rowSnapshotHash = optionalAlias(row, "snapshotHash", "snapshot_hash");
  if (
    typeof rowRunId === "object" ||
    typeof rowSnapshotHash === "object" ||
    (rowRunId !== undefined && typeof rowRunId !== "string") ||
    (rowSnapshotHash !== undefined && typeof rowSnapshotHash !== "string")
  ) {
    gameMapFailure("game_map_mixed_run_identity", relation);
  }
  if (
    (rowRunId !== undefined && rowRunId !== run.runId) ||
    (rowSnapshotHash !== undefined && rowSnapshotHash !== run.snapshotHash)
  ) {
    gameMapFailure("game_map_mixed_run_identity", relation);
  }
}

function validateRunIdentity(value: unknown): GameMapRunIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    gameMapFailure("game_map_run_invalid", "run_identity");
  }
  const candidate = value as Record<string, unknown>;
  // Runtime types are checked before the regexes: RegExp.test coerces
  // undefined, numbers and objects to text, which could make malformed input
  // look valid.
  if (typeof candidate.runId !== "string" || typeof candidate.snapshotHash !== "string") {
    gameMapFailure("game_map_run_invalid", "run_identity");
  }
  if (!RUN_ID_TEXT.test(candidate.runId) || !SHA256_TEXT.test(candidate.snapshotHash)) {
    gameMapFailure("game_map_run_invalid", "run_identity");
  }
  const sourceProjectRef = candidate.sourceProjectRef;
  const sourceDatabase = candidate.sourceDatabase;
  if (
    (sourceProjectRef !== undefined && (typeof sourceProjectRef !== "string" || sourceProjectRef.length === 0)) ||
    (sourceDatabase !== undefined && (typeof sourceDatabase !== "string" || sourceDatabase.length === 0))
  ) {
    gameMapFailure("game_map_run_invalid", "run_identity");
  }
  const checkedSourceProjectRef = sourceProjectRef as string | undefined;
  const checkedSourceDatabase = sourceDatabase as string | undefined;
  return Object.freeze({
    runId: candidate.runId,
    snapshotHash: candidate.snapshotHash,
    ...(checkedSourceProjectRef === undefined ? {} : { sourceProjectRef: checkedSourceProjectRef }),
    ...(checkedSourceDatabase === undefined ? {} : { sourceDatabase: checkedSourceDatabase }),
  });
}

/**
 * Validate one source AppID cell exactly.
 *
 * The text is never re-rendered and never round-tripped through a float.  The
 * canonical-text check rejects `+7`, `007`, ` 7` and `7.0`: a source bigint
 * column cannot produce them, so accepting them would let two spellings of one
 * identity into the same map.
 */
export function parseSteamAppIdText(
  value: GameMapCell | undefined,
  relation: string,
  field: string,
): { text: string; value: bigint } {
  // `null` is a source NULL and is a routing decision the caller owes an
  // answer to.  `undefined` is a missing column, which is a broken input
  // shape; the two must not collapse into one diagnosis.
  if (value === undefined) gameMapFailure("game_map_input_invalid", relation, field);
  if (value === null) gameMapFailure("game_map_reference_identity_missing", relation, field);
  if (typeof value !== "string") gameMapFailure("game_map_app_id_invalid", relation, field);
  let parsed: bigint | null;
  try {
    parsed = parsePgInteger(value, {
      minInclusive: STEAM_APP_ID_MIN,
      maxInclusive: STEAM_APP_ID_MAX,
      field: `${relation}.${field}`,
    });
  } catch (error) {
    if (error instanceof ScalarError) {
      gameMapFailure(
        error.scalarCode === "scalar_integer_overflow"
          ? "game_map_app_id_out_of_range"
          : "game_map_app_id_invalid",
        relation,
        field,
      );
    }
    throw error;
  }
  if (parsed === null) gameMapFailure("game_map_reference_identity_missing", relation, field);
  if (parsed.toString(10) !== value) gameMapFailure("game_map_app_id_invalid", relation, field);
  return { text: value, value: parsed };
}

function boundedRelationName(value: unknown, relation: string, field: string): string {
  if (typeof value !== "string" || !RELATION_TEXT.test(value)) {
    gameMapFailure(relation === "catalogue_stubs" ? "game_map_stub_invalid" : "game_map_input_invalid", relation, field);
  }
  return value;
}

function boundedFieldName(value: unknown, relation: string, field: string): string {
  if (typeof value !== "string" || !FIELD_TEXT.test(value)) {
    gameMapFailure(relation === "catalogue_stubs" ? "game_map_stub_invalid" : "game_map_input_invalid", relation, field);
  }
  return value;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** PostgreSQL `btrim(text)` with its default single-space trim character. */
function pgBtrim(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

/**
 * The documented catalogue-stub title fallback.
 *
 * `Steam App <appid>` is the exact form the live owned-import normalizer
 * produces for a missing provider name, so a migration stub and an import stub
 * are the same identity rather than two competing spellings.
 */
export function catalogueStubTitle(appIdText: string): string {
  return `Steam App ${appIdText}`;
}

/**
 * The normalized sort title for a stub.
 *
 * M2's publish path seeds `normalized_sort_title` as `lower(btrim(title))`.  A
 * catalogued row keeps its own source `normalized_name` instead; this rule
 * applies only where the source has no normalized name to preserve.
 */
export function catalogueStubNormalizedTitle(title: string): string {
  return pgBtrim(title).toLowerCase();
}

type NormalizedStub = {
  appIdText: string;
  appIdValue: bigint;
  title: string;
  normalizedSortTitle: string;
  titleProvenance: "catalog_stub_fallback" | "source_relation_title";
  requiredByRelation: string;
  requiredByField: string;
  reason: string;
};

function normalizeStub(raw: CatalogueStubEvidence, run: GameMapRunIdentity): NormalizedStub {
  const row = asObject(raw, "catalogue_stubs");
  checkRowRunIdentity(row, run, "catalogue_stubs");
  const appId = parseSteamAppIdText(
    row.steam_appid as GameMapCell | undefined,
    "catalogue_stubs",
    "steam_appid",
  );
  const provenance = row.title_provenance;
  if (provenance !== "catalog_stub_fallback" && provenance !== "source_relation_title") {
    gameMapFailure("game_map_stub_invalid", "catalogue_stubs", "title_provenance");
  }
  const suppliedTitle = row.title;
  let title: string;
  if (provenance === "catalog_stub_fallback") {
    // A supplied title with the fallback provenance is ambiguous: the caller
    // is claiming both a fallback and a source title.  Refuse rather than
    // choose one.
    if (suppliedTitle !== undefined && suppliedTitle !== null) {
      gameMapFailure("game_map_stub_invalid", "catalogue_stubs", "title");
    }
    title = catalogueStubTitle(appId.text);
  } else {
    if (typeof suppliedTitle !== "string") {
      gameMapFailure("game_map_stub_invalid", "catalogue_stubs", "title");
    }
    title = suppliedTitle;
  }
  // M1: check (length(btrim(title)) between 1 and 500).  The bound is on the
  // trimmed length exactly as the target states it; applying a stricter rule
  // here would reject a title the target would have accepted.
  const trimmedLength = codePointLength(pgBtrim(title));
  if (trimmedLength < 1 || trimmedLength > MAX_STUB_TITLE_LENGTH) {
    gameMapFailure("game_map_stub_invalid", "catalogue_stubs", "title");
  }
  const normalizedSortTitle = catalogueStubNormalizedTitle(title);
  // M1: check (length(normalized_sort_title) between 1 and 500) — no btrim.
  const normalizedLength = codePointLength(normalizedSortTitle);
  if (normalizedLength < 1 || normalizedLength > MAX_STUB_TITLE_LENGTH) {
    gameMapFailure("game_map_stub_invalid", "catalogue_stubs", "normalized_sort_title");
  }
  const reason = row.reason;
  if (typeof reason !== "string" || codePointLength(pgBtrim(reason)) < 1 || codePointLength(reason) > MAX_STUB_REASON_LENGTH) {
    gameMapFailure("game_map_stub_invalid", "catalogue_stubs", "reason");
  }
  return {
    appIdText: appId.text,
    appIdValue: appId.value,
    title,
    normalizedSortTitle,
    titleProvenance: provenance,
    requiredByRelation: boundedRelationName(row.required_by_relation, "catalogue_stubs", "required_by_relation"),
    requiredByField: boundedFieldName(row.required_by_field, "catalogue_stubs", "required_by_field"),
    reason,
  };
}

function boundedCount(value: number | undefined, fallback: number, relation: string, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > TARGET_GAME_ID_MAX) {
    gameMapFailure("game_map_count_limit", relation, field);
  }
  return resolved;
}

/**
 * Inventory the complete valid AppID union the real source relationships
 * require, then sort it numerically and number it.
 *
 * The order of the two halves matters.  Numbering before the union is complete
 * would make the identity of a game depend on which relation was read first,
 * and a rerun that read the references in a different order would produce a
 * different `catalog.games.id` for the same AppID.
 */
export function buildGameMap(input: GameMapInput, options: GameMapOptions = {}): GameMapBuildResult {
  const root = asObject(input, "game_map_input");
  const run = validateRunIdentity(root.runIdentity);
  const maxGames = boundedCount(options.maxGames, 1_000_000, "game_map_input", "maxGames");
  const maxReferences = boundedCount(options.maxReferences, 20_000_000, "game_map_input", "maxReferences");

  const catalogueRows = ensureArray(root.catalogueGames, "catalog_games") as readonly CatalogueGameIdentityRow[];
  const referenceRows =
    root.references === undefined ? [] : (ensureArray(root.references, "game_references") as readonly GameReferenceRow[]);
  const stubRows =
    root.stubs === undefined ? [] : (ensureArray(root.stubs, "catalogue_stubs") as readonly CatalogueStubEvidence[]);

  if (catalogueRows.length > maxGames || stubRows.length > maxGames || catalogueRows.length + stubRows.length > maxGames) {
    gameMapFailure("game_map_count_limit", "game_map_input", "maxGames");
  }
  if (referenceRows.length > maxReferences) {
    gameMapFailure("game_map_count_limit", "game_map_input", "maxReferences");
  }

  // 1. The catalogue itself.
  const catalogue = new Map<string, bigint>();
  for (const raw of catalogueRows) {
    const row = asObject(raw, "catalog_games");
    checkRowRunIdentity(row, run, "catalog_games");
    const appId = parseSteamAppIdText(row.steam_appid as GameMapCell | undefined, "catalog_games", "steam_appid");
    if (catalogue.has(appId.text)) gameMapFailure("game_map_duplicate_identity", "catalog_games", "steam_appid");
    catalogue.set(appId.text, appId.value);
  }

  // 2. Explicit stub evidence, which may not shadow a catalogued identity.
  const stubs = new Map<string, NormalizedStub>();
  for (const raw of stubRows) {
    const stub = normalizeStub(raw, run);
    if (catalogue.has(stub.appIdText)) {
      gameMapFailure("game_map_stub_unneeded", "catalogue_stubs", "steam_appid");
    }
    if (stubs.has(stub.appIdText)) {
      gameMapFailure("game_map_duplicate_identity", "catalogue_stubs", "steam_appid");
    }
    stubs.set(stub.appIdText, stub);
  }

  // 3. Every AppID the real source relationships require must be in the union.
  //    A reference is checked, never added: an unreferenced identity cannot
  //    appear out of a relation that only points at one.
  let resolvedReferences = 0;
  for (const raw of referenceRows) {
    const row = asObject(raw, "game_references");
    const relation = boundedRelationName(row.relation, "game_references", "relation");
    const field = boundedFieldName(row.field, "game_references", "field");
    checkRowRunIdentity(row, run, relation);
    const appId = parseSteamAppIdText(row.steam_appid as GameMapCell | undefined, relation, field);
    if (!catalogue.has(appId.text) && !stubs.has(appId.text)) {
      gameMapFailure("game_map_missing_reference", relation, field);
    }
    resolvedReferences += 1;
  }

  // 4. Deterministic numbering over the complete union.
  const union: { text: string; value: bigint; kind: "catalog_games" | "stub" }[] = [];
  for (const [text, value] of catalogue) union.push({ text, value, kind: "catalog_games" });
  for (const [text, stub] of stubs) union.push({ text, value: stub.appIdValue, kind: "stub" });
  if (union.length > maxGames) gameMapFailure("game_map_count_limit", "game_map_input", "maxGames");
  if (union.length > TARGET_GAME_ID_MAX) gameMapFailure("game_map_game_id_overflow", "catalogue_union", "id");
  union.sort((left, right) => (left.value < right.value ? -1 : left.value > right.value ? 1 : 0));
  for (let index = 1; index < union.length; index += 1) {
    // Two distinct texts cannot share a value while the canonical-text check
    // above rejects every alternative spelling, and a stub may not shadow a
    // catalogued AppID.  The scan is kept so a relaxed check upstream fails
    // here rather than silently giving one game two target identities.
    if (union[index].value === union[index - 1].value) {
      gameMapFailure("game_map_conflicting_identity", "catalogue_union", "steam_appid");
    }
  }

  const entries: GameMapTargetRecord[] = [];
  const stubRecords: GameStubTargetRecord[] = [];
  union.forEach((identity, index) => {
    const gameId = index + 1;
    if (!Number.isSafeInteger(gameId) || gameId < 1 || gameId > TARGET_GAME_ID_MAX) {
      gameMapFailure("game_map_game_id_overflow", "catalogue_union", "id");
    }
    entries.push(
      Object.freeze({
        legacy_app_id: identity.text,
        game_id: gameId,
        source_kind: identity.kind,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
    if (identity.kind === "stub") {
      const stub = stubs.get(identity.text);
      if (!stub) gameMapFailure("game_map_inconsistent", "catalogue_union", "steam_appid");
      stubRecords.push(
        Object.freeze({
          legacy_app_id: stub.appIdText,
          game_id: gameId,
          title: stub.title,
          normalized_sort_title: stub.normalizedSortTitle,
          title_source: "catalog_stub" as const,
          title_provenance: stub.titleProvenance,
          required_by_relation: stub.requiredByRelation,
          required_by_field: stub.requiredByField,
          reason: stub.reason,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
    }
  });

  const runIdentity = Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash });
  return Object.freeze({
    run_identity: runIdentity,
    map: Object.freeze({ run_identity: runIdentity, entries: Object.freeze(entries) }),
    stubs: Object.freeze(stubRecords),
    counts: Object.freeze({
      catalogue_identities: catalogue.size,
      stub_identities: stubs.size,
      mapped_identities: entries.length,
      resolved_references: resolvedReferences,
    }),
  });
}

type GameMapIndex = Readonly<{
  byAppId: ReadonlyMap<string, number>;
  byAppIdKind: ReadonlyMap<string, "catalog_games" | "stub">;
}>;

const INDEX_CACHE = new WeakMap<object, GameMapIndex>();

/**
 * True only for the exact frozen graph `buildGameMap` produces: the map
 * itself, its `run_identity` and its `entries` array and every entry frozen.
 *
 * The identity cache below may only remember an index for a graph this rule
 * accepts.  A caller-constructed map is not required to be frozen at all, and
 * a mutable map can be edited in place after its first lookup; caching by
 * object identity in that case would let a later lookup see a stale answer
 * for a map the caller has since changed.  This check never mutates the
 * caller's map to make it eligible — an ineligible map is simply re-indexed,
 * uncached, on every call.
 */
function isFullyFrozenGameMap(map: object): boolean {
  if (!Object.isFrozen(map)) return false;
  const identity = (map as GameMap).run_identity;
  if (typeof identity !== "object" || identity === null || !Object.isFrozen(identity)) return false;
  const entries = (map as GameMap).entries;
  if (!Array.isArray(entries) || !Object.isFrozen(entries)) return false;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !Object.isFrozen(entry)) return false;
  }
  return true;
}

/**
 * Index a map once per object, checking that it really is one same-run map.
 *
 * A library transform can call `lookupGameId` millions of times, so a linear
 * scan per call would make the library phase quadratic for the normal,
 * immutable, builder-produced map.  Only such a fully-frozen graph is ever
 * cached; a mutable map is revalidated and re-indexed on every call so a
 * caller's later edit is never masked by a stale cached index.
 *
 * The cache is checked BEFORE `isFullyFrozenGameMap` runs, not after: that
 * check is itself an O(entries) scan, and running it ahead of every cache
 * lookup would make a cache hit cost as much as a miss, defeating the whole
 * point of caching for the large frozen maps this exists for.  A `WeakMap`
 * lookup on `map` is used as the sole cache gate instead. This is safe
 * because `Object.freeze` is irreversible: the cache is only ever populated
 * for a map this function has itself already proven fully frozen, so any
 * later hit is necessarily still for that same immutable graph. The
 * O(entries) frozen check therefore runs at most once per distinct map
 * object, exactly when its index is first built.
 */
function indexGameMap(map: GameMap): GameMapIndex {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    gameMapFailure("game_map_inconsistent", "game_map");
  }
  const cached = INDEX_CACHE.get(map as object);
  if (cached) return cached;

  const identity = (map as GameMap).run_identity;
  if (
    typeof identity !== "object" ||
    identity === null ||
    typeof identity.run_id !== "string" ||
    typeof identity.snapshot_hash !== "string" ||
    !RUN_ID_TEXT.test(identity.run_id) ||
    !SHA256_TEXT.test(identity.snapshot_hash)
  ) {
    gameMapFailure("game_map_inconsistent", "game_map", "run_identity");
  }
  const entries = (map as GameMap).entries;
  if (!Array.isArray(entries)) gameMapFailure("game_map_inconsistent", "game_map", "entries");

  const byAppId = new Map<string, number>();
  const byAppIdKind = new Map<string, "catalog_games" | "stub">();
  const seenGameIds = new Set<number>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) gameMapFailure("game_map_inconsistent", "game_map", "entries");
    const record = entry as GameMapTargetRecord;
    if (typeof record.legacy_app_id !== "string") gameMapFailure("game_map_inconsistent", "game_map", "legacy_app_id");
    parseSteamAppIdText(record.legacy_app_id, "game_map", "legacy_app_id");
    if (
      typeof record.game_id !== "number" ||
      !Number.isSafeInteger(record.game_id) ||
      record.game_id < 1 ||
      record.game_id > TARGET_GAME_ID_MAX
    ) {
      gameMapFailure("game_map_inconsistent", "game_map", "game_id");
    }
    if (record.source_kind !== "catalog_games" && record.source_kind !== "stub") {
      gameMapFailure("game_map_inconsistent", "game_map", "source_kind");
    }
    // `migration.game_map` is unique in both directions: one AppID, one target
    // identity, and no target identity claimed twice.
    if (record.source_snapshot_hash !== identity.snapshot_hash) {
      gameMapFailure("game_map_inconsistent", "game_map", "source_snapshot_hash");
    }
    if (byAppId.has(record.legacy_app_id)) gameMapFailure("game_map_inconsistent", "game_map", "legacy_app_id");
    if (seenGameIds.has(record.game_id)) gameMapFailure("game_map_inconsistent", "game_map", "game_id");
    byAppId.set(record.legacy_app_id, record.game_id);
    byAppIdKind.set(record.legacy_app_id, record.source_kind);
    seenGameIds.add(record.game_id);
  }
  const index: GameMapIndex = Object.freeze({ byAppId, byAppIdKind });
  if (isFullyFrozenGameMap(map as object)) INDEX_CACHE.set(map as object, index);
  return index;
}

/**
 * Resolve one source AppID to its target `catalog.games.id`.
 *
 * It throws rather than returning null or a sentinel.  A missing identity is a
 * transform failure, not a value, and a caller that wants an unknown-history
 * route must decide that before it asks the map.
 *
 * Catalogue identity is not ownership: an entry proves a catalogue row exists
 * and says nothing about who may see that game.
 */
export function lookupGameId(map: GameMap, legacyAppId: string | null): number {
  const index = indexGameMap(map);
  if (legacyAppId === null) {
    gameMapFailure("game_map_reference_identity_missing", "game_map", "legacy_app_id");
  }
  parseSteamAppIdText(legacyAppId, "game_map", "legacy_app_id");
  const gameId = index.byAppId.get(legacyAppId);
  if (gameId === undefined) gameMapFailure("game_map_unknown_app_id", "game_map", "legacy_app_id");
  return gameId;
}

/** True when the map has this identity, without throwing on a miss. */
export function hasGameId(map: GameMap, legacyAppId: string | null): boolean {
  const index = indexGameMap(map);
  if (legacyAppId === null) return false;
  parseSteamAppIdText(legacyAppId, "game_map", "legacy_app_id");
  return index.byAppId.has(legacyAppId);
}

/**
 * Resolve one source AppID's provenance in the map: whether the catalogue
 * itself already carried this identity, or a stub was required to represent
 * it.
 *
 * A consumer that emits a `catalog_games` row or a stub row must agree with
 * this before writing `source_kind`: the map is the one place that decided
 * provenance, and a row's own claim is never trusted over it.
 */
export function gameMapEntryKind(map: GameMap, legacyAppId: string): "catalog_games" | "stub" {
  const index = indexGameMap(map);
  parseSteamAppIdText(legacyAppId, "game_map", "legacy_app_id");
  const kind = index.byAppIdKind.get(legacyAppId);
  if (kind === undefined) gameMapFailure("game_map_unknown_app_id", "game_map", "legacy_app_id");
  return kind;
}

/**
 * Validate an externally-supplied stub record against the same rule
 * `buildGameMap` enforces on the evidence it is built from.
 *
 * `catalogue.ts` receives `GameStubTargetRecord` values across a module
 * boundary and cannot assume they came from this module's own builder: a
 * caller can hand it any object shaped like one.  This re-derives every
 * bound this module already enforces — trimmed title length, normalized
 * title length and its exact derivation, the title/provenance agreement for
 * the fallback rule, and the bounded relation/field/reason text — so a
 * forged or truncated stub is refused at the point it is consumed, not only
 * at the point one was built.  A stub this module itself produced always
 * passes unchanged: it already satisfies every check below by construction.
 */
export function validateGameStubTargetRecord(value: unknown, relation: string): GameStubTargetRecord {
  const row = asObject(value, relation);
  const legacyAppId = row.legacy_app_id;
  if (typeof legacyAppId !== "string") gameMapFailure("game_map_stub_invalid", relation, "legacy_app_id");
  parseSteamAppIdText(legacyAppId, relation, "legacy_app_id");

  const gameId = row.game_id;
  if (typeof gameId !== "number" || !Number.isSafeInteger(gameId) || gameId < 1 || gameId > TARGET_GAME_ID_MAX) {
    gameMapFailure("game_map_stub_invalid", relation, "game_id");
  }

  const titleProvenance = row.title_provenance;
  if (titleProvenance !== "catalog_stub_fallback" && titleProvenance !== "source_relation_title") {
    gameMapFailure("game_map_stub_invalid", relation, "title_provenance");
  }

  const title = row.title;
  if (typeof title !== "string") gameMapFailure("game_map_stub_invalid", relation, "title");
  const trimmedLength = codePointLength(pgBtrim(title));
  if (trimmedLength < 1 || trimmedLength > MAX_STUB_TITLE_LENGTH) {
    gameMapFailure("game_map_stub_invalid", relation, "title");
  }
  // The fallback rule is a deterministic function of the AppID: a stub
  // claiming the fallback provenance must carry exactly that title, never a
  // caller-substituted one.
  if (titleProvenance === "catalog_stub_fallback" && title !== catalogueStubTitle(legacyAppId)) {
    gameMapFailure("game_map_stub_invalid", relation, "title");
  }

  const normalizedSortTitle = row.normalized_sort_title;
  if (typeof normalizedSortTitle !== "string") {
    gameMapFailure("game_map_stub_invalid", relation, "normalized_sort_title");
  }
  const normalizedLength = codePointLength(normalizedSortTitle);
  if (normalizedLength < 1 || normalizedLength > MAX_STUB_TITLE_LENGTH) {
    gameMapFailure("game_map_stub_invalid", relation, "normalized_sort_title");
  }
  if (normalizedSortTitle !== catalogueStubNormalizedTitle(title)) {
    gameMapFailure("game_map_stub_invalid", relation, "normalized_sort_title");
  }

  if (row.title_source !== "catalog_stub") {
    gameMapFailure("game_map_stub_invalid", relation, "title_source");
  }

  const requiredByRelation = boundedRelationName(row.required_by_relation, relation, "required_by_relation");
  const requiredByField = boundedFieldName(row.required_by_field, relation, "required_by_field");

  const reason = row.reason;
  if (
    typeof reason !== "string" ||
    codePointLength(pgBtrim(reason)) < 1 ||
    codePointLength(reason) > MAX_STUB_REASON_LENGTH
  ) {
    gameMapFailure("game_map_stub_invalid", relation, "reason");
  }

  const sourceSnapshotHash = row.source_snapshot_hash;
  if (typeof sourceSnapshotHash !== "string" || !SHA256_TEXT.test(sourceSnapshotHash)) {
    gameMapFailure("game_map_stub_invalid", relation, "source_snapshot_hash");
  }

  return Object.freeze({
    legacy_app_id: legacyAppId,
    game_id: gameId,
    title,
    normalized_sort_title: normalizedSortTitle,
    title_source: "catalog_stub" as const,
    title_provenance: titleProvenance,
    required_by_relation: requiredByRelation,
    required_by_field: requiredByField,
    reason,
    source_snapshot_hash: sourceSnapshotHash,
  });
}

/**
 * Fail unless the map belongs to the caller's run.
 *
 * Counts from an older audit are evidence, never preconditions, so the check
 * is on identity rather than on size.
 */
export function assertGameMapRunIdentity(map: GameMap, run: GameMapRunIdentity): void {
  const expected = validateRunIdentity(run);
  indexGameMap(map);
  if (map.run_identity.run_id !== expected.runId || map.run_identity.snapshot_hash !== expected.snapshotHash) {
    gameMapFailure("game_map_mixed_run_identity", "game_map", "run_identity");
  }
}

/** Make map comparisons independent of construction order. */
export function canonicalGameMap(map: GameMap): string {
  const entries = [...map.entries].sort((left, right) => left.game_id - right.game_id);
  return JSON.stringify({ run_identity: map.run_identity, entries });
}
