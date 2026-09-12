import {
  compareNumber,
  compareTimestamp,
  compareUuid,
  encodeJsonIntegerArray,
  encodeJsonStringArray,
  freezeArray,
  jsonSizeAdvisory,
  m3AccountMap,
  m3BtrimBoundedText,
  m3Cell,
  m3CheckRowIdentity,
  m3CollectionMap,
  m3ConflictCollector,
  m3Failure,
  m3GameMap,
  m3Integer,
  m3JsonDocument,
  m3LibraryRowMap,
  m3LookupAccount,
  m3NullableCell,
  m3NullableBtrimBoundedText,
  m3Object,
  m3PgIntegerArray,
  m3PgTextArray,
  m3PositiveBigintAppId,
  m3RunIdentity,
  m3Rows,
  m3TargetInteger,
  m3Timestamp,
  m3Uuid,
  sameTenant,
  TARGET_BIGINT_MAX,
  TARGET_INTEGER_MAX,
  type CollectionMapIndex,
  type CollectionMapRecord,
  type ConflictRecord,
  type DrawMapRecord,
  type JsonSizeAdvisory,
  type LibraryRowMapIndex,
  type LibraryRowMapRecord,
  type M3GCell,
  type M3GRunIdentity,
  type M3GSourceRunTag,
  type PgTimestamp,
} from "./commitments-shared.ts";

const DRAWS = "vault_draws";
const DRAW_EVENTS = "vault_draw_events";
const VAULT_EVENTS = "vault_events";
const DEFAULT_MAX_DRAWS = 5_000_000;
const DEFAULT_MAX_EVENTS = 20_000_000;
const MAX_GENRE_ELEMENTS = 100_000;
const MAX_GENRE_TEXT = 1_000_000;
const MAX_FINALIST_ELEMENTS = 10_000;
const MAX_FINALIST_TEXT = 1_000_000;
const MAX_CONTEXT_TEXT = 8 * 1024 * 1024;
const SELECTED_GENRES_PG_BOUND = 32_768;
const FINALIST_APP_IDS_PG_BOUND = 262_144;
const CONTEXT_PG_BOUND = 65_536;

export type DrawSourceRow = Readonly<{
  id: M3GCell;
  user_id: M3GCell;
  steam_appid: M3GCell;
  drawn_at: M3GCell;
  session: M3GCell;
  mood: M3GCell;
  goal: M3GCell;
  collection_id: M3GCell;
  selected_genres: M3GCell;
  eligible_pool_count: M3GCell;
  reroll_index: M3GCell;
  finalist_appids: M3GCell;
}> &
  M3GSourceRunTag;

export type DrawEventSourceRow = Readonly<{
  id: M3GCell;
  user_id: M3GCell;
  draw_id: M3GCell;
  event_type: M3GCell;
  created_at: M3GCell;
}> &
  M3GSourceRunTag;

export type VaultEventSourceRow = Readonly<{
  id: M3GCell;
  user_id: M3GCell;
  game_id: M3GCell;
  action: M3GCell;
  context: M3GCell;
  created_at: M3GCell;
}> &
  M3GSourceRunTag;

export type DrawRecord = Readonly<{
  id: number;
  public_id: string;
  account_id: number;
  game_id: number | null;
  /** Exact positive source bigint text; never re-rendered. */
  steam_app_id: string;
  drawn_at: PgTimestamp;
  session: string | null;
  mood: string | null;
  goal: string | null;
  source_collection_id: string | null;
  collection_id: number | null;
  /** JSON text cast to jsonb by the loader. */
  selected_genres: string;
  eligible_pool_count: number;
  reroll_index: number;
  /** JSON text cast to jsonb by the loader, or NULL. */
  finalist_app_ids: string | null;
  source_snapshot_hash: string;
}>;

export type DrawEventRecord = Readonly<{
  id: number;
  public_id: string;
  account_id: number;
  draw_id: number;
  event_type: string;
  occurred_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

export type VaultEventRecord = Readonly<{
  id: number;
  public_id: string;
  account_id: number;
  game_id: number | null;
  /** Source UUID remains when the target game is unavailable. */
  legacy_game_id: string | null;
  action: string;
  /** Opaque JSON text cast to jsonb by the loader. */
  context: string;
  occurred_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

export type UnresolvedDrawReference = Readonly<{
  code: "draw_game_unmapped" | "draw_collection_unmapped" | "vault_event_game_unmapped";
  relation: typeof DRAWS | typeof VAULT_EVENTS;
  source_column: "steam_appid" | "collection_id" | "game_id";
  source_identity: string;
  account_id: number;
  disposition: "target_null_source_identity_retained";
}>;

export type DrawTransformInput = Readonly<{
  runIdentity: M3GRunIdentity;
  accountMap: unknown;
  gameMap: unknown;
  libraryRowMap: readonly LibraryRowMapRecord[] | unknown;
  collectionMap: readonly CollectionMapRecord[] | unknown;
  draws: readonly DrawSourceRow[];
  drawEvents: readonly DrawEventSourceRow[];
  vaultEvents: readonly VaultEventSourceRow[];
}>;

export type DrawTransformOptions = Readonly<{
  maxDraws?: number;
  maxDrawEvents?: number;
  maxVaultEvents?: number;
  startDrawId?: number;
  startDrawEventId?: number;
  startVaultEventId?: number;
}>;

export type DrawTransformResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  /** Machine selection and its inputs. */
  draws: readonly DrawRecord[];
  /** Served draw-history events, kept separate from actions. */
  draw_events: readonly DrawEventRecord[];
  /** User action history, kept separate from selection and serving. */
  vault_events: readonly VaultEventRecord[];
  draw_map: readonly DrawMapRecord[];
  unresolved_references: readonly UnresolvedDrawReference[];
  size_advisories: readonly JsonSizeAdvisory[];
  conflicts: readonly ConflictRecord[];
}>;

type StagedDraw = Readonly<{
  sourceId: string;
  canonicalId: string;
  accountId: number;
  gameId: number | null;
  steamAppId: string;
  drawnAt: PgTimestamp;
  session: string | null;
  mood: string | null;
  goal: string | null;
  sourceCollectionId: string | null;
  collectionId: number | null;
  selectedGenres: string;
  eligiblePoolCount: number;
  rerollIndex: number;
  finalistAppIds: string | null;
}>;

type StagedDrawEvent = Readonly<{
  sourceId: string;
  canonicalId: string;
  accountId: number;
  drawId: number;
  eventType: string;
  occurredAt: PgTimestamp;
}>;

type StagedVaultEvent = Readonly<{
  sourceId: string;
  canonicalId: string;
  accountId: number;
  gameId: number | null;
  legacyGameId: string | null;
  action: string;
  context: string;
  occurredAt: PgTimestamp;
}>;

function boundedOption(value: number | undefined, fallback: number, relation: string, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) m3Failure("m3g_input_invalid", relation, field);
  return value;
}

function nullablePositiveAppId(value: string | null, relation: string, field: string): string | null {
  if (value === null) return null;
  return m3PositiveBigintAppId(value, relation, field);
}

function parseTargetNonnegative(value: string, relation: string, field: string): number {
  return m3TargetInteger(m3Integer(value, relation, field, BigInt(0), TARGET_INTEGER_MAX), relation, field);
}

function resolveMappedGame(
  gameMap: ReturnType<typeof m3GameMap>,
  appId: string,
  relation: typeof DRAWS,
  accountId: number,
  unresolved: UnresolvedDrawReference[],
): number | null {
  if (!gameMap.has(appId)) {
    unresolved.push(
      Object.freeze({
        code: "draw_game_unmapped",
        relation,
        source_column: "steam_appid",
        source_identity: appId,
        account_id: accountId,
        disposition: "target_null_source_identity_retained",
      }),
    );
    return null;
  }
  return gameMap.lookup(appId);
}

function resolveCollection(
  collectionMap: CollectionMapIndex,
  sourceCollection: string | null,
  accountId: number,
  unresolved: UnresolvedDrawReference[],
): { source: string | null; target: number | null } {
  if (sourceCollection === null) return { source: null, target: null };
  const parsed = m3Uuid(sourceCollection, DRAWS, "collection_id");
  if (!collectionMap.has(parsed.original)) {
    unresolved.push(
      Object.freeze({
        code: "draw_collection_unmapped",
        relation: DRAWS,
        source_column: "collection_id",
        source_identity: parsed.original,
        account_id: accountId,
        disposition: "target_null_source_identity_retained",
      }),
    );
    return { source: parsed.original, target: null };
  }
  const mapped = collectionMap.lookup(parsed.original);
  sameTenant(accountId, mapped.account_id, DRAWS, "collection_id");
  return { source: parsed.original, target: mapped.collection_id };
}

function nullableBoundedText(value: string | null, relation: string, field: string): string | null {
  return m3NullableBtrimBoundedText(value, relation, field, 80);
}

function sortDraws(left: StagedDraw, right: StagedDraw): number {
  if (left.accountId !== right.accountId) return compareNumber(left.accountId, right.accountId);
  const byTime = compareTimestamp(left.drawnAt, right.drawnAt);
  if (byTime !== 0) return byTime;
  return compareUuid(left.canonicalId, right.canonicalId);
}

export function transformDraws(input: DrawTransformInput, options: DrawTransformOptions = {}): DrawTransformResult {
  const root = m3Object(input, "draw_input");
  const run = m3RunIdentity(root.runIdentity);
  const accountMap = m3AccountMap(root.accountMap, run);
  const gameMap = m3GameMap(root.gameMap, run);
  const libraryRowMap = m3LibraryRowMap(root.libraryRowMap, run);
  const collectionMap = m3CollectionMap(root.collectionMap, run);
  const conflicts = m3ConflictCollector();
  const advisories: JsonSizeAdvisory[] = [];
  const unresolved: UnresolvedDrawReference[] = [];

  const stagedDraws = readDraws(
    root.draws,
    run,
    accountMap,
    gameMap,
    collectionMap,
    unresolved,
    advisories,
    conflicts,
    boundedOption(options.maxDraws, DEFAULT_MAX_DRAWS, DRAWS, "maxDraws"),
  );
  stagedDraws.sort(sortDraws);
  const startDrawId = boundedOption(options.startDrawId, 1, DRAWS, "startDrawId");
  if (startDrawId < 1) m3Failure("m3g_input_invalid", DRAWS, "startDrawId");
  const drawRecords: DrawRecord[] = [];
  const drawMapRecords: DrawMapRecord[] = [];
  const drawByLegacy = new Map<string, { id: number; accountId: number }>();
  stagedDraws.forEach((draw, index) => {
    const id = startDrawId + index;
    if (!Number.isSafeInteger(id) || BigInt(id) > TARGET_BIGINT_MAX) m3Failure("m3g_target_overflow", DRAWS, "id");
    drawRecords.push(
      Object.freeze({
        id,
        public_id: draw.sourceId,
        account_id: draw.accountId,
        game_id: draw.gameId,
        steam_app_id: draw.steamAppId,
        drawn_at: draw.drawnAt,
        session: draw.session,
        mood: draw.mood,
        goal: draw.goal,
        source_collection_id: draw.sourceCollectionId,
        collection_id: draw.collectionId,
        selected_genres: draw.selectedGenres,
        eligible_pool_count: draw.eligiblePoolCount,
        reroll_index: draw.rerollIndex,
        finalist_app_ids: draw.finalistAppIds,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
    drawMapRecords.push(
      Object.freeze({
        legacy_id: draw.sourceId,
        account_id: draw.accountId,
        draw_id: id,
        public_id: draw.sourceId,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
    drawByLegacy.set(draw.canonicalId, { id, accountId: draw.accountId });
  });

  const stagedDrawEvents = readDrawEvents(
    root.drawEvents,
    run,
    accountMap,
    drawByLegacy,
    boundedOption(options.maxDrawEvents, DEFAULT_MAX_EVENTS, DRAW_EVENTS, "maxDrawEvents"),
  );
  stagedDrawEvents.sort((left, right) => {
    if (left.accountId !== right.accountId) return compareNumber(left.accountId, right.accountId);
    const byTime = compareTimestamp(left.occurredAt, right.occurredAt);
    if (byTime !== 0) return byTime;
    return compareUuid(left.canonicalId, right.canonicalId);
  });
  const startDrawEventId = boundedOption(options.startDrawEventId, 1, DRAW_EVENTS, "startDrawEventId");
  if (startDrawEventId < 1) m3Failure("m3g_input_invalid", DRAW_EVENTS, "startDrawEventId");
  const drawEvents: DrawEventRecord[] = stagedDrawEvents.map((event, index) => {
    const id = startDrawEventId + index;
    if (!Number.isSafeInteger(id) || BigInt(id) > TARGET_BIGINT_MAX) m3Failure("m3g_target_overflow", DRAW_EVENTS, "id");
    return Object.freeze({
      id,
      public_id: event.sourceId,
      account_id: event.accountId,
      draw_id: event.drawId,
      event_type: event.eventType,
      occurred_at: event.occurredAt,
      source_snapshot_hash: run.snapshotHash,
    });
  });

  const stagedVaultEvents = readVaultEvents(
    root.vaultEvents,
    run,
    accountMap,
    libraryRowMap,
    unresolved,
    advisories,
    boundedOption(options.maxVaultEvents, DEFAULT_MAX_EVENTS, VAULT_EVENTS, "maxVaultEvents"),
  );
  stagedVaultEvents.sort((left, right) => {
    if (left.accountId !== right.accountId) return compareNumber(left.accountId, right.accountId);
    const byTime = compareTimestamp(left.occurredAt, right.occurredAt);
    if (byTime !== 0) return byTime;
    return compareUuid(left.canonicalId, right.canonicalId);
  });
  const startVaultEventId = boundedOption(options.startVaultEventId, 1, VAULT_EVENTS, "startVaultEventId");
  if (startVaultEventId < 1) m3Failure("m3g_input_invalid", VAULT_EVENTS, "startVaultEventId");
  const vaultEvents: VaultEventRecord[] = stagedVaultEvents.map((event, index) => {
    const id = startVaultEventId + index;
    if (!Number.isSafeInteger(id) || BigInt(id) > TARGET_BIGINT_MAX) m3Failure("m3g_target_overflow", VAULT_EVENTS, "id");
    return Object.freeze({
      id,
      public_id: event.sourceId,
      account_id: event.accountId,
      game_id: event.gameId,
      legacy_game_id: event.legacyGameId,
      action: event.action,
      context: event.context,
      occurred_at: event.occurredAt,
      source_snapshot_hash: run.snapshotHash,
    });
  });

  unresolved.sort((left, right) => {
    if (left.relation !== right.relation) return left.relation < right.relation ? -1 : 1;
    if (left.source_column !== right.source_column) return left.source_column < right.source_column ? -1 : 1;
    if (left.account_id !== right.account_id) return compareNumber(left.account_id, right.account_id);
    return compareUuid(left.source_identity.toLowerCase(), right.source_identity.toLowerCase());
  });
  advisories.sort((left, right) => {
    if (left.relation !== right.relation) return left.relation < right.relation ? -1 : 1;
    return compareUuid(left.public_id.toLowerCase(), right.public_id.toLowerCase());
  });
  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    draws: freezeArray(drawRecords),
    draw_events: freezeArray(drawEvents),
    vault_events: freezeArray(vaultEvents),
    draw_map: freezeArray(drawMapRecords),
    unresolved_references: freezeArray(unresolved),
    size_advisories: freezeArray(advisories),
    conflicts: conflicts.toRecords(),
  });
}

function readDraws(
  value: unknown,
  run: M3GRunIdentity,
  accountMap: ReturnType<typeof m3AccountMap>,
  gameMap: ReturnType<typeof m3GameMap>,
  collectionMap: CollectionMapIndex,
  unresolved: UnresolvedDrawReference[],
  advisories: JsonSizeAdvisory[],
  conflicts: ReturnType<typeof m3ConflictCollector>,
  maxRows: number,
): StagedDraw[] {
  const rows = m3Rows(value, DRAWS, maxRows);
  const result: StagedDraw[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = m3Object(raw, DRAWS);
    m3CheckRowIdentity(row, run, DRAWS);
    const publicId = m3Uuid(m3Cell(row, "id", DRAWS), DRAWS, "id");
    if (seen.has(publicId.canonical)) m3Failure("m3g_duplicate_identity", DRAWS, "id");
    seen.add(publicId.canonical);
    const accountId = m3LookupAccount(accountMap, m3Cell(row, "user_id", DRAWS), DRAWS, "user_id");
    const steamAppId = nullablePositiveAppId(m3Cell(row, "steam_appid", DRAWS), DRAWS, "steam_appid");
    if (steamAppId === null) m3Failure("m3g_invalid_integer", DRAWS, "steam_appid");
    const gameId = resolveMappedGame(gameMap, steamAppId, DRAWS, accountId, unresolved);
    const collection = resolveCollection(collectionMap, m3NullableCell(row, "collection_id", DRAWS), accountId, unresolved);
    const genresSource = m3Cell(row, "selected_genres", DRAWS);
    const genres = m3PgTextArray(genresSource, DRAWS, "selected_genres", MAX_GENRE_ELEMENTS, MAX_GENRE_TEXT);
    if (genres.elements.some((element) => element === null)) m3Failure("m3g_invalid_array", DRAWS, "selected_genres");
    const selectedGenres = encodeJsonStringArray(genres.elements);
    if (new TextEncoder().encode(selectedGenres).byteLength > SELECTED_GENRES_PG_BOUND) {
      advisories.push(
        jsonSizeAdvisory(
          "app.vault_draws",
          "selected_genres",
          publicId.original,
          m3JsonDocument(selectedGenres, DRAWS, "selected_genres", "array", MAX_GENRE_TEXT),
          SELECTED_GENRES_PG_BOUND,
          "M3:app.vault_draws.selected_genres pg_column_size bound",
        ),
      );
      conflicts.record({
        conflict_class: "draw_selected_genres_size_advisory",
        source_relation: DRAWS,
        source_column: "selected_genres",
        decision: "The JSONB physical size requires SQL validation; the transform preserves the exact array and does not trim it.",
        details: { pg_column_size_bound: 32_768, requires_sql_validation: true },
      });
    }
    const finalistCell = m3NullableCell(row, "finalist_appids", DRAWS);
    let finalistAppIds: string | null = null;
    if (finalistCell !== null) {
      const parsed = m3PgIntegerArray(finalistCell, DRAWS, "finalist_appids", BigInt(1), TARGET_BIGINT_MAX, MAX_FINALIST_ELEMENTS);
      const json = encodeJsonIntegerArray(parsed);
      finalistAppIds = json;
      if (new TextEncoder().encode(json).byteLength > FINALIST_APP_IDS_PG_BOUND) {
        advisories.push(
          jsonSizeAdvisory(
            "app.vault_draws",
            "finalist_app_ids",
            publicId.original,
            m3JsonDocument(json, DRAWS, "finalist_appids", "array", MAX_FINALIST_TEXT),
            FINALIST_APP_IDS_PG_BOUND,
            "M3:app.vault_draws.finalist_app_ids pg_column_size bound",
          ),
        );
        conflicts.record({
          conflict_class: "draw_finalist_app_ids_size_advisory",
          source_relation: DRAWS,
          source_column: "finalist_appids",
          decision: "The JSONB physical size requires SQL validation; the transform preserves exact provider IDs and does not trim them.",
          details: { pg_column_size_bound: 262_144, requires_sql_validation: true },
        });
      }
    }
    result.push(
      Object.freeze({
        sourceId: publicId.original,
        canonicalId: publicId.canonical,
        accountId,
        gameId,
        steamAppId,
        drawnAt: m3Timestamp(m3Cell(row, "drawn_at", DRAWS), DRAWS, "drawn_at"),
        session: nullableBoundedText(m3NullableCell(row, "session", DRAWS), DRAWS, "session"),
        mood: nullableBoundedText(m3NullableCell(row, "mood", DRAWS), DRAWS, "mood"),
        goal: nullableBoundedText(m3NullableCell(row, "goal", DRAWS), DRAWS, "goal"),
        sourceCollectionId: collection.source,
        collectionId: collection.target,
        selectedGenres,
        eligiblePoolCount: parseTargetNonnegative(m3Cell(row, "eligible_pool_count", DRAWS), DRAWS, "eligible_pool_count"),
        rerollIndex: parseTargetNonnegative(m3Cell(row, "reroll_index", DRAWS), DRAWS, "reroll_index"),
        finalistAppIds,
      }),
    );
  }
  return result;
}

function readDrawEvents(
  value: unknown,
  run: M3GRunIdentity,
  accountMap: ReturnType<typeof m3AccountMap>,
  drawByLegacy: ReadonlyMap<string, { id: number; accountId: number }>,
  maxRows: number,
): StagedDrawEvent[] {
  const rows = m3Rows(value, DRAW_EVENTS, maxRows);
  const result: StagedDrawEvent[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = m3Object(raw, DRAW_EVENTS);
    m3CheckRowIdentity(row, run, DRAW_EVENTS);
    const publicId = m3Uuid(m3Cell(row, "id", DRAW_EVENTS), DRAW_EVENTS, "id");
    if (seen.has(publicId.canonical)) m3Failure("m3g_duplicate_identity", DRAW_EVENTS, "id");
    seen.add(publicId.canonical);
    const accountId = m3LookupAccount(accountMap, m3Cell(row, "user_id", DRAW_EVENTS), DRAW_EVENTS, "user_id");
    const drawId = m3Uuid(m3Cell(row, "draw_id", DRAW_EVENTS), DRAW_EVENTS, "draw_id");
    const parent = drawByLegacy.get(drawId.canonical);
    if (parent === undefined) m3Failure("m3g_draw_unmapped", DRAW_EVENTS, "draw_id");
    sameTenant(accountId, parent.accountId, DRAW_EVENTS, "draw_id");
    result.push(
      Object.freeze({
        sourceId: publicId.original,
        canonicalId: publicId.canonical,
        accountId,
        drawId: parent.id,
        eventType: m3RequiredEventText(m3Cell(row, "event_type", DRAW_EVENTS), DRAW_EVENTS, "event_type"),
        occurredAt: m3Timestamp(m3Cell(row, "created_at", DRAW_EVENTS), DRAW_EVENTS, "created_at"),
      }),
    );
  }
  return result;
}

function readVaultEvents(
  value: unknown,
  run: M3GRunIdentity,
  accountMap: ReturnType<typeof m3AccountMap>,
  libraryRowMap: LibraryRowMapIndex,
  unresolved: UnresolvedDrawReference[],
  advisories: JsonSizeAdvisory[],
  maxRows: number,
): StagedVaultEvent[] {
  const rows = m3Rows(value, VAULT_EVENTS, maxRows);
  const result: StagedVaultEvent[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = m3Object(raw, VAULT_EVENTS);
    m3CheckRowIdentity(row, run, VAULT_EVENTS);
    const publicId = m3Uuid(m3Cell(row, "id", VAULT_EVENTS), VAULT_EVENTS, "id");
    if (seen.has(publicId.canonical)) m3Failure("m3g_duplicate_identity", VAULT_EVENTS, "id");
    seen.add(publicId.canonical);
    const accountId = m3LookupAccount(accountMap, m3Cell(row, "user_id", VAULT_EVENTS), VAULT_EVENTS, "user_id");
    const sourceGameCell = m3NullableCell(row, "game_id", VAULT_EVENTS);
    let gameId: number | null = null;
    let legacyGameId: string | null = null;
    if (sourceGameCell !== null) {
      const sourceGame = m3Uuid(sourceGameCell, VAULT_EVENTS, "game_id");
      legacyGameId = sourceGame.original;
      if (!libraryRowMap.has(sourceGame.original)) {
        unresolved.push(
          Object.freeze({
            code: "vault_event_game_unmapped",
            relation: VAULT_EVENTS,
            source_column: "game_id",
            source_identity: sourceGame.original,
            account_id: accountId,
            disposition: "target_null_source_identity_retained",
          }),
        );
      } else {
        const libraryRow = libraryRowMap.lookup(sourceGame.original);
        sameTenant(accountId, libraryRow.account_id, VAULT_EVENTS, "game_id");
        gameId = libraryRow.game_id;
      }
    }
    const context = m3JsonDocument(m3Cell(row, "context", VAULT_EVENTS), VAULT_EVENTS, "context", "object", MAX_CONTEXT_TEXT);
    if (context.utf8Bytes > CONTEXT_PG_BOUND) {
      advisories.push(
        jsonSizeAdvisory(
          "app.vault_events",
          "context",
          publicId.original,
          context,
          CONTEXT_PG_BOUND,
          "M3:app.vault_events.context pg_column_size bound",
        ),
      );
    }
    result.push(
      Object.freeze({
        sourceId: publicId.original,
        canonicalId: publicId.canonical,
        accountId,
        gameId,
        legacyGameId,
        action: m3RequiredEventText(m3Cell(row, "action", VAULT_EVENTS), VAULT_EVENTS, "action"),
        context: context.sourceText,
        occurredAt: m3Timestamp(m3Cell(row, "created_at", VAULT_EVENTS), VAULT_EVENTS, "created_at"),
      }),
    );
  }
  return result;
}

function m3RequiredEventText(value: string, relation: string, field: string): string {
  return m3BtrimBoundedText(value, relation, field, 100);
}

export { m3DrawMap } from "./commitments-shared.ts";
