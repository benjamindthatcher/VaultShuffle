import { comparePgTimestamps, type CivilDate, type PgTimestamp } from "./scalars.ts";
import {
  asObject,
  canonicalUuid,
  checkRowLimit,
  checkRowRunIdentity,
  codePointLength,
  ConflictCollector,
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
  requiredCivilDate,
  requiredInteger,
  requiredTimestamp,
  sourceCell,
  steamAppId,
  TARGET_BIGINT_MAX,
  TARGET_INTEGER_MAX,
  validateRunIdentity,
  type ConflictRecord,
  type GameMap,
  type LibraryCell,
  type LibraryRunIdentity,
} from "./library-shared.ts";
import type { LibraryRowMapRecord } from "./library.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Daily playtime history, completion history and purge-review history.
 *
 * Three rules constrain this module:
 *
 * 1. daily totals are cumulative. They are copied verbatim, never differenced
 *    into gains, and a decreasing series is preserved as a conflict rather than
 *    repaired into monotonicity.
 * 2. completion identity is preserved exactly once. Every source event gets one
 *    registry row, and an event that resolves to no catalogue identity goes to
 *    the retained unknown-history relation with its original nullable
 *    identifiers rather than being given an invented game.
 * 3. a purge review never becomes a completion event. Whether an
 *    `action = 'complete'` review should also project into completion history
 *    is an open snapshot decision, so this module counts the population and
 *    generates nothing.
 */

const PLAYTIME_RELATION = "user_playtime_snapshots";
const COMPLETION_RELATION = "completion_events";
const PURGE_RELATION = "purge_reviews";

const ZERO = BigInt(0);
const ORIGIN_SURFACES = ["sweep", "sweep_bulk", "library", "vault", "purge", "details"] as const;
const PURGE_ACTIONS = ["keep", "pin", "sleep", "complete"] as const;
const MAX_RAW_TEXT_LENGTH = 128;
/** Both completion destinations bound `metric_provenance` at 8192 bytes. */
const MAX_PROVENANCE_JSONB_BYTES = 8_192;
const DEFAULT_MAX_ROWS = 5_000_000;
const NONFINITE_DOUBLE_TEXT = /^[+-]?(?:NaN|Infinity|Inf)$/i;

export type CompletionOriginSurface = (typeof ORIGIN_SURFACES)[number];
export type PurgeAction = (typeof PURGE_ACTIONS)[number];

export type PlaytimeSnapshotSourceRow = Readonly<{
  user_id: LibraryCell;
  captured_on: LibraryCell;
  total_minutes: LibraryCell;
  games_with_playtime: LibraryCell;
  created_at: LibraryCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/** `app.playtime_daily`, with the M3 semantic and coverage columns. */
export type PlaytimeDailyRecord = Readonly<{
  account_id: number;
  /** A civil day. It never passes through an instant or a timezone. */
  activity_day: CivilDate;
  /** Exact cumulative total as text; never differenced into a daily gain. */
  observed_minutes: string;
  observed_minutes_semantic: "cumulative_total";
  games_with_playtime: number;
  /** The source records no coverage, so the M1 default meaning is kept. */
  coverage: "unknown";
  recorded_at: PgTimestamp;
}>;

export type CompletionEventSourceRow = Readonly<{
  id: LibraryCell;
  user_id: LibraryCell;
  game_id: LibraryCell;
  steam_appid: LibraryCell;
  source: LibraryCell;
  claimed_at: LibraryCell;
  undone_at: LibraryCell;
  hours_played: LibraryCell;
  estimate_minutes: LibraryCell;
  price_cents: LibraryCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

type CompletionMetrics = Readonly<{
  legacy_hours_played: string | null;
  legacy_hours_played_raw: string | null;
  legacy_estimate_minutes: number | null;
  legacy_price_cents: number | null;
  metric_provenance: Readonly<Record<string, string | number | boolean>>;
}>;

/** `app.completion_events` for events that resolve to a catalogue identity.
 * Ordering is always normal here: an inverted event is routed to
 * `CompletionOrderingExceptionRecord` instead and never reaches this array. */
export type CompletionEventRecord = CompletionMetrics &
  Readonly<{
    account_id: number;
    game_id: number;
    occurred_at: PgTimestamp;
    undone_at: PgTimestamp | null;
    /** The v2 column records the ACTOR; all six legacy surfaces are user acts. */
    source: "user";
    dedupe_key: null;
    legacy_event_id: string;
    origin_surface: CompletionOriginSurface;
    legacy_game_id: string | null;
    legacy_steam_appid: string | null;
  }>;

/** `app.unknown_completion_history` for events with no catalogue identity.
 * Ordering is always normal here for the same reason. */
export type UnknownCompletionHistoryRecord = CompletionMetrics &
  Readonly<{
    legacy_event_id: string;
    account_id: number;
    source_game_id: string | null;
    source_steam_appid: string | null;
    actor: "user";
    origin_surface: CompletionOriginSurface;
    occurred_at: PgTimestamp;
    undone_at: PgTimestamp | null;
    state: "occurred" | "undone";
    source_snapshot_hash: string;
  }>;

/**
 * Root's 11 September follow-up (decision 4): both `app.completion_events`
 * and `app.unknown_completion_history` require `undone_at >= occurred_at`,
 * and the source has no such CHECK. The 9 September read-only audit
 * (`database/v2/source-conflicts-audit-20260909.json`, `completions.
 * undo_before_claim: 0` of 13,157) found none in the real snapshot it read,
 * so this stays a valid-schema possibility, not a proven one -- and that
 * audit is a separate HTTP read, not the real export snapshot itself, so it
 * cannot retire this gate on its own. An inverted event is withheld from
 * both loadable relations and from the registry entirely: no dangling
 * `completion_event_registry` row, no accidental active completion. A
 * nonempty result here blocks final load/commit; it is never counted as
 * successful parity or silently discarded.
 */
export type CompletionOrderingExceptionRecord = CompletionMetrics &
  Readonly<{
    legacy_event_id: string;
    account_id: number;
    source_game_id: string | null;
    source_steam_appid: string | null;
    origin_surface: CompletionOriginSurface;
    occurred_at: PgTimestamp;
    undone_at: PgTimestamp;
    source_snapshot_hash: string;
  }>;

/**
 * `app.completion_event_registry`.
 *
 * `resolved_event_id` and `unknown_history_id` are database identity values
 * that a pure transform cannot know, so the loader fills exactly one of them
 * from the row it just inserted for this `legacy_event_id`. The partial unique
 * indexes stop either target row from being claimed twice.
 */
export type CompletionRegistryRecord = Readonly<{
  legacy_event_id: string;
  account_id: number;
  record_kind: "resolved" | "unknown";
  source_snapshot_hash: string;
}>;

export type PurgeReviewSourceRow = Readonly<{
  id: LibraryCell;
  user_id: LibraryCell;
  game_id: LibraryCell;
  action: LibraryCell;
  reviewed_at: LibraryCell;
  playtime_minutes_at_review: LibraryCell;
  progress_at_review: LibraryCell;
  last_played_at_review: LibraryCell;
  runId?: string;
  snapshotHash?: string;
  run_id?: string;
  snapshot_hash?: string;
}>;

/** `app.purge_review_history`. Durable authored decisions. */
export type PurgeReviewHistoryRecord = Readonly<{
  account_id: number;
  game_id: number | null;
  steam_app_id: string | null;
  action: PurgeAction;
  reviewed_at: PgTimestamp;
  playtime_minutes_at_review: number;
  progress_at_review: number | null;
  last_played_at_review: PgTimestamp | null;
  source_snapshot_hash: string;
}>;

/** `migration.legacy_purge_review_archive`. Bounded staging. */
export type LegacyPurgeReviewRecord = Readonly<{
  legacy_id: string;
  account_id: number;
  source_game_id: string;
  action: PurgeAction;
  reviewed_at: PgTimestamp;
  playtime_minutes_at_review: number;
  progress_at_review: number | null;
  last_played_at_review: PgTimestamp | null;
  source_snapshot_hash: string;
  retention_class: "staging-30d-post-cutover";
}>;

export type HistoryTransformResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  playtime_daily: readonly PlaytimeDailyRecord[];
  completion_events: readonly CompletionEventRecord[];
  unknown_completion_history: readonly UnknownCompletionHistoryRecord[];
  completion_ordering_exceptions: readonly CompletionOrderingExceptionRecord[];
  completion_event_registry: readonly CompletionRegistryRecord[];
  purge_review_history: readonly PurgeReviewHistoryRecord[];
  legacy_purge_review_archive: readonly LegacyPurgeReviewRecord[];
  conflicts: readonly ConflictRecord[];
}>;

export type HistoryTransformInput = Readonly<{
  runIdentity: LibraryRunIdentity;
  accountMap: readonly AccountMapTargetRecord[];
  gameMap: GameMap;
  /** Banked by the library transform; the mandatory per-row identity map. */
  libraryRowMap: readonly LibraryRowMapRecord[];
  playtimeSnapshots?: readonly PlaytimeSnapshotSourceRow[];
  completionEvents?: readonly CompletionEventSourceRow[];
  purgeReviews?: readonly PurgeReviewSourceRow[];
}>;

export type HistoryTransformOptions = Readonly<{ maxRows?: number }>;

function civilDayKey(date: CivilDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}

function completionMetrics(
  hoursRaw: string | null,
  estimateMinutes: bigint | null,
  priceCents: bigint | null,
  conflicts: ConflictCollector,
): CompletionMetrics {
  const provenance: Record<string, string | number | boolean> = {};
  let hoursValue: string | null = null;
  let hoursRawValue: string | null = null;

  if (hoursRaw !== null) {
    if (codePointLength(hoursRaw) > MAX_RAW_TEXT_LENGTH) {
      libraryFailure("library_unrepresentable_value", COMPLETION_RELATION, "hours_played");
    }
    hoursRawValue = hoursRaw;
    provenance.hours = "legacy_double_precision_hours";
    if (NONFINITE_DOUBLE_TEXT.test(hoursRaw)) {
      provenance.hours_exact_in_numeric_30_12 = false;
      provenance.hours_finite = false;
      conflicts.record({
        conflict_class: "completion_hours_not_finite",
        source_relation: COMPLETION_RELATION,
        source_column: "hours_played",
        decision:
          "A non-finite double precision hours value has no numeric(30,12) representation. The exact source text is preserved in legacy_hours_played_raw and the numeric column stays NULL; no minutes value is synthesised from it.",
        details: { status: "resolved" },
      });
    } else {
      // A finite-looking value still has to pass the exact decimal grammar.
      // Malformed text is a source-row failure, not a non-finite measurement.
      const parsed = optionalDecimal(hoursRaw, COMPLETION_RELATION, "hours_played");
      if (parsed === null) {
        libraryFailure("library_invalid_decimal", COMPLETION_RELATION, "hours_played");
      }
      if (parsed.sign < 0) {
        provenance.hours_exact_in_numeric_30_12 = false;
        provenance.hours_nonnegative = false;
        conflicts.record({
          conflict_class: "completion_hours_negative",
          source_relation: COMPLETION_RELATION,
          source_column: "hours_played",
          decision:
            "The target completion metric is non-negative. A negative source hours value is preserved only in legacy_hours_played_raw; it is never clamped, made positive or written to the constrained numeric column.",
          details: { status: "resolved" },
        });
      } else if (fitsNumeric(parsed, 30, 12)) {
        provenance.hours_exact_in_numeric_30_12 = true;
        hoursValue = parsed.toCanonicalString();
      } else {
        provenance.hours_exact_in_numeric_30_12 = false;
        conflicts.record({
          conflict_class: "completion_hours_precision_exceeds_target",
          source_relation: COMPLETION_RELATION,
          source_column: "hours_played",
          decision:
            "The double precision hours text needs more precision than numeric(30,12) holds. Storing it would round silently, so the numeric column stays NULL and the exact source text is preserved in legacy_hours_played_raw.",
          details: { status: "resolved" },
        });
      }
    }
  }

  if (estimateMinutes !== null) provenance.estimate_minutes = "legacy_exact_minutes";
  if (priceCents !== null) provenance.price_cents = "legacy_usd_cents";
  if (jsonbUpperBoundBytes(provenance) > MAX_PROVENANCE_JSONB_BYTES) {
    libraryFailure("library_unrepresentable_value", COMPLETION_RELATION, "metric_provenance");
  }

  return Object.freeze({
    legacy_hours_played: hoursValue,
    legacy_hours_played_raw: hoursRawValue,
    legacy_estimate_minutes: estimateMinutes === null ? null : Number(estimateMinutes),
    legacy_price_cents: priceCents === null ? null : Number(priceCents),
    metric_provenance: Object.freeze(provenance),
  });
}

/**
 * Convert daily, completion and purge history into deterministic target
 * records. Pure: no filesystem, database, network or target write, and no wall
 * clock.
 */
export function transformHistoryBatch(
  input: HistoryTransformInput,
  options: HistoryTransformOptions = {},
): HistoryTransformResult {
  const root = asObject(input, "history_input");
  const run = validateRunIdentity(root.runIdentity);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const accounts = indexAccountMap(root.accountMap, run);
  const games = indexGameMap(root.gameMap, run);
  const conflicts = new ConflictCollector();

  const libraryRows = ensureArray(root.libraryRowMap, "user_games") as readonly LibraryRowMapRecord[];
  checkRowLimit(libraryRows, "user_games", maxRows);
  const libraryByLegacyId = new Map<string, LibraryRowMapRecord>();
  const libraryAccountGame = new Set<string>();
  const libraryAccountApp = new Set<string>();
  for (const raw of libraryRows) {
    const candidate = asObject(raw, "user_games");
    if (
      typeof candidate.account_id !== "number" ||
      !Number.isSafeInteger(candidate.account_id) ||
      candidate.account_id < 1 ||
      !accounts.hasTarget(candidate.account_id)
    ) {
      libraryFailure("library_input_invalid", "user_games", "account_id");
    }
    if (typeof candidate.game_id !== "number" || !Number.isSafeInteger(candidate.game_id) || candidate.game_id < 1) {
      libraryFailure("library_input_invalid", "user_games", "game_id");
    }
    if (!games.hasTarget(candidate.game_id)) libraryFailure("library_game_unmapped", "user_games", "game_id");
    if (typeof candidate.steam_appid !== "string") {
      libraryFailure("library_input_invalid", "user_games", "steam_appid");
    }
    const appId = steamAppId(candidate.steam_appid, "user_games", "steam_appid");
    if (games.lookup(appId.source) !== candidate.game_id) {
      libraryFailure("library_game_map_invalid", "user_games", "game_id");
    }
    if (typeof candidate.source_snapshot_hash !== "string") {
      libraryFailure("library_input_invalid", "user_games", "source_snapshot_hash");
    }
    if (candidate.source_snapshot_hash !== run.snapshotHash) {
      libraryFailure("library_mixed_run_identity", "user_games", "source_snapshot_hash");
    }
    const legacyId = canonicalUuid(candidate.legacy_id as string, "user_games", "id");
    if (libraryByLegacyId.has(legacyId.canonical)) libraryFailure("library_duplicate_identity", "user_games", "id");
    const accountGameKey = `${candidate.account_id}:${candidate.game_id}`;
    const accountAppKey = `${candidate.account_id}:${appId.source}`;
    if (libraryAccountGame.has(accountGameKey) || libraryAccountApp.has(accountAppKey)) {
      libraryFailure("library_duplicate_identity", "user_games", "catalog_steam_appid");
    }
    libraryAccountGame.add(accountGameKey);
    libraryAccountApp.add(accountAppKey);
    const entry: LibraryRowMapRecord = Object.freeze({
      legacy_id: legacyId.original,
      account_id: candidate.account_id,
      game_id: candidate.game_id,
      steam_appid: appId.source,
      source_snapshot_hash: run.snapshotHash,
    });
    libraryByLegacyId.set(legacyId.canonical, entry);
  }

  // ---- app.playtime_daily -------------------------------------------------
  const playtimeRows = (root.playtimeSnapshots === undefined
    ? []
    : ensureArray(root.playtimeSnapshots, PLAYTIME_RELATION)) as readonly PlaytimeSnapshotSourceRow[];
  checkRowLimit(playtimeRows, PLAYTIME_RELATION, maxRows);
  const playtime: PlaytimeDailyRecord[] = [];
  const seenPlaytimeKeys = new Set<string>();
  for (const raw of playtimeRows) {
    const row = asObject(raw, PLAYTIME_RELATION);
    checkRowRunIdentity(row, run, PLAYTIME_RELATION);
    const sourceUserId = canonicalUuid(sourceCell(row, "user_id", PLAYTIME_RELATION), PLAYTIME_RELATION, "user_id");
    const accountId = accounts.lookup(sourceUserId.original);
    const day = requiredCivilDate(sourceCell(row, "captured_on", PLAYTIME_RELATION), PLAYTIME_RELATION, "captured_on");
    const key = `${accountId}:${day.sourceText}`;
    if (seenPlaytimeKeys.has(key)) libraryFailure("library_duplicate_identity", PLAYTIME_RELATION, "captured_on");
    seenPlaytimeKeys.add(key);
    const totalMinutes = requiredInteger(
      sourceCell(row, "total_minutes", PLAYTIME_RELATION),
      PLAYTIME_RELATION,
      "total_minutes",
      { min: ZERO, max: TARGET_BIGINT_MAX },
    );
    const gamesWithPlaytime = requiredInteger(
      sourceCell(row, "games_with_playtime", PLAYTIME_RELATION),
      PLAYTIME_RELATION,
      "games_with_playtime",
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    playtime.push(
      Object.freeze({
        account_id: accountId,
        activity_day: day,
        observed_minutes: totalMinutes.toString(10),
        observed_minutes_semantic: "cumulative_total" as const,
        games_with_playtime: Number(gamesWithPlaytime),
        coverage: "unknown" as const,
        recorded_at: requiredTimestamp(
          sourceCell(row, "created_at", PLAYTIME_RELATION),
          PLAYTIME_RELATION,
          "created_at",
        ),
      }),
    );
  }
  playtime.sort((left, right) => {
    if (left.account_id !== right.account_id) return left.account_id - right.account_id;
    return civilDayKey(left.activity_day) - civilDayKey(right.activity_day);
  });
  // A decreasing cumulative total is preserved exactly as it is: the series is
  // never forced monotonic and never reinterpreted as a daily gain.
  for (let index = 1; index < playtime.length; index += 1) {
    const previous = playtime[index - 1];
    const current = playtime[index];
    if (previous.account_id !== current.account_id) continue;
    if (BigInt(current.observed_minutes) < BigInt(previous.observed_minutes)) {
      conflicts.record({
        conflict_class: "playtime_daily_cumulative_decrease",
        source_relation: PLAYTIME_RELATION,
        source_column: "total_minutes",
        decision:
          "UNRESOLVED for root (D-PT-3 / S-PT-MONOTONIC): a later cumulative total is lower than an earlier one. Both values are copied verbatim; the series is never differenced, repaired or forced monotonic.",
        details: { status: "unresolved", decision_ref: "D-PT-3" },
      });
    }
  }

  // ---- completion history -------------------------------------------------
  const completionRows = (root.completionEvents === undefined
    ? []
    : ensureArray(root.completionEvents, COMPLETION_RELATION)) as readonly CompletionEventSourceRow[];
  checkRowLimit(completionRows, COMPLETION_RELATION, maxRows);
  const resolvedEvents: CompletionEventRecord[] = [];
  const unknownEvents: UnknownCompletionHistoryRecord[] = [];
  const orderingExceptions: CompletionOrderingExceptionRecord[] = [];
  const registry: CompletionRegistryRecord[] = [];
  const seenEventIds = new Set<string>();
  const completionsByAccountGame = new Set<string>();

  for (const raw of completionRows) {
    const row = asObject(raw, COMPLETION_RELATION);
    checkRowRunIdentity(row, run, COMPLETION_RELATION);
    const eventId = canonicalUuid(sourceCell(row, "id", COMPLETION_RELATION), COMPLETION_RELATION, "id");
    if (seenEventIds.has(eventId.canonical)) libraryFailure("library_duplicate_identity", COMPLETION_RELATION, "id");
    seenEventIds.add(eventId.canonical);
    const sourceUserId = canonicalUuid(sourceCell(row, "user_id", COMPLETION_RELATION), COMPLETION_RELATION, "user_id");
    const accountId = accounts.lookup(sourceUserId.original);
    const originSurface = enumValue(
      sourceCell(row, "source", COMPLETION_RELATION),
      ORIGIN_SURFACES,
      COMPLETION_RELATION,
      "source",
    );
    const occurredAt = requiredTimestamp(
      sourceCell(row, "claimed_at", COMPLETION_RELATION),
      COMPLETION_RELATION,
      "claimed_at",
    );
    const undoneAt = optionalTimestamp(
      nullableSourceCell(row, "undone_at", COMPLETION_RELATION),
      COMPLETION_RELATION,
      "undone_at",
    );
    const undoneBeforeOccurred = undoneAt !== null && comparePgTimestamps(undoneAt, occurredAt) < 0;
    if (undoneBeforeOccurred) {
      conflicts.record({
        conflict_class: "completion_undone_before_occurred",
        source_relation: COMPLETION_RELATION,
        source_column: "undone_at",
        decision:
          "UNRESOLVED for root: both app.completion_events and app.unknown_completion_history require undone_at >= occurred_at, so an out-of-order source event has no destination. Both instants are preserved verbatim in the segregated completion_ordering_exceptions record (not swapped, nulled or clamped) and the row is withheld from every loadable array and from completion_event_registry, so it cannot dangle a reference or become an accidental active completion. Blocks final load/commit until root records a disposition.",
        details: { status: "unresolved", destination: "completion_ordering_exceptions" },
      });
    }

    const sourceGameIdText = nullableSourceCell(row, "game_id", COMPLETION_RELATION);
    const sourceGameId =
      sourceGameIdText === null ? null : canonicalUuid(sourceGameIdText, COMPLETION_RELATION, "game_id");
    const sourceAppIdText = nullableSourceCell(row, "steam_appid", COMPLETION_RELATION);
    const sourceAppId =
      sourceAppIdText === null ? null : steamAppId(sourceAppIdText, COMPLETION_RELATION, "steam_appid");

    const metrics = completionMetrics(
      nullableSourceCell(row, "hours_played", COMPLETION_RELATION),
      optionalInteger(
        nullableSourceCell(row, "estimate_minutes", COMPLETION_RELATION),
        COMPLETION_RELATION,
        "estimate_minutes",
        { min: ZERO, max: TARGET_INTEGER_MAX },
      ),
      optionalInteger(nullableSourceCell(row, "price_cents", COMPLETION_RELATION), COMPLETION_RELATION, "price_cents", {
        min: ZERO,
        max: TARGET_INTEGER_MAX,
      }),
      conflicts,
    );

    if (undoneBeforeOccurred && undoneAt !== null) {
      // Withheld from every loadable array and from the registry (decision
      // 4): catalogue identity resolution below is skipped entirely, since
      // this row will never be inserted into either destination it would
      // otherwise resolve to.
      orderingExceptions.push(
        Object.freeze({
          ...metrics,
          legacy_event_id: eventId.original,
          account_id: accountId,
          source_game_id: sourceGameId === null ? null : sourceGameId.original,
          source_steam_appid: sourceAppId === null ? null : sourceAppId.source,
          origin_surface: originSurface,
          occurred_at: occurredAt,
          undone_at: undoneAt,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      continue;
    }

    // Resolution order: the per-row library map first, then the catalogue map
    // on the AppID. Neither path may invent a catalogue row.
    let gameId: number | null = null;
    if (sourceGameId !== null) {
      const libraryRow = libraryByLegacyId.get(sourceGameId.canonical);
      if (libraryRow !== undefined) {
        if (libraryRow.account_id !== accountId) {
          conflicts.record({
            conflict_class: "completion_library_row_cross_account",
            source_relation: COMPLETION_RELATION,
            source_column: "game_id",
            decision:
              "The named library row belongs to a different account, so it cannot resolve this event's catalogue identity. The AppID fallback is used instead and the mismatch is counted.",
            details: { status: "unresolved" },
          });
        } else {
          gameId = libraryRow.game_id;
        }
      }
    }
    if (gameId === null && sourceAppId !== null && games.has(sourceAppId.source)) {
      gameId = games.lookup(sourceAppId.source);
    }

    if (gameId === null) {
      if (sourceGameId !== null || sourceAppId !== null) {
        conflicts.record({
          conflict_class: "completion_identity_unresolved",
          source_relation: COMPLETION_RELATION,
          source_column: "game_id",
          decision:
            "The event names an identity that resolves to no catalogue row. It is retained in app.unknown_completion_history with its original nullable identifiers; no catalogue row is invented to satisfy a foreign key.",
          details: { status: "resolved", destination: "app.unknown_completion_history" },
        });
      } else {
        conflicts.record({
          conflict_class: "completion_identity_absent",
          source_relation: COMPLETION_RELATION,
          source_column: "game_id",
          decision:
            "D-CE-2: an event with a null game identifier and a null AppID stays unknown history. Nothing about the game is inferred and no catalogue row is fabricated.",
          details: { status: "resolved", destination: "app.unknown_completion_history" },
        });
      }
      unknownEvents.push(
        Object.freeze({
          ...metrics,
          legacy_event_id: eventId.original,
          account_id: accountId,
          source_game_id: sourceGameId === null ? null : sourceGameId.original,
          source_steam_appid: sourceAppId === null ? null : sourceAppId.source,
          actor: "user" as const,
          origin_surface: originSurface,
          occurred_at: occurredAt,
          undone_at: undoneAt,
          state: undoneAt === null ? ("occurred" as const) : ("undone" as const),
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      registry.push(
        Object.freeze({
          legacy_event_id: eventId.original,
          account_id: accountId,
          record_kind: "unknown" as const,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      continue;
    }

    completionsByAccountGame.add(`${accountId}:${gameId}`);
    resolvedEvents.push(
      Object.freeze({
        ...metrics,
        account_id: accountId,
        game_id: gameId,
        occurred_at: occurredAt,
        undone_at: undoneAt,
        source: "user" as const,
        dedupe_key: null,
        legacy_event_id: eventId.original,
        origin_surface: originSurface,
        legacy_game_id: sourceGameId === null ? null : sourceGameId.original,
        legacy_steam_appid: sourceAppId === null ? null : sourceAppId.source,
      }),
    );
    registry.push(
      Object.freeze({
        legacy_event_id: eventId.original,
        account_id: accountId,
        record_kind: "resolved" as const,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  const byEventId = (left: { legacy_event_id: string }, right: { legacy_event_id: string }): number =>
    left.legacy_event_id < right.legacy_event_id ? -1 : left.legacy_event_id > right.legacy_event_id ? 1 : 0;
  resolvedEvents.sort(byEventId);
  unknownEvents.sort(byEventId);
  registry.sort(byEventId);

  // ---- purge reviews ------------------------------------------------------
  const purgeRows = (root.purgeReviews === undefined
    ? []
    : ensureArray(root.purgeReviews, PURGE_RELATION)) as readonly PurgeReviewSourceRow[];
  checkRowLimit(purgeRows, PURGE_RELATION, maxRows);
  const purgeHistory: PurgeReviewHistoryRecord[] = [];
  const purgeArchive: LegacyPurgeReviewRecord[] = [];
  const seenPurgeIds = new Set<string>();
  const seenPurgeGateKeys = new Set<string>();

  for (const raw of purgeRows) {
    const row = asObject(raw, PURGE_RELATION);
    checkRowRunIdentity(row, run, PURGE_RELATION);
    const legacyId = canonicalUuid(sourceCell(row, "id", PURGE_RELATION), PURGE_RELATION, "id");
    if (seenPurgeIds.has(legacyId.canonical)) libraryFailure("library_duplicate_identity", PURGE_RELATION, "id");
    seenPurgeIds.add(legacyId.canonical);
    const sourceUserId = canonicalUuid(sourceCell(row, "user_id", PURGE_RELATION), PURGE_RELATION, "user_id");
    const accountId = accounts.lookup(sourceUserId.original);
    const sourceGameId = canonicalUuid(sourceCell(row, "game_id", PURGE_RELATION), PURGE_RELATION, "game_id");
    const action = enumValue(sourceCell(row, "action", PURGE_RELATION), PURGE_ACTIONS, PURGE_RELATION, "action");
    const reviewedAt = requiredTimestamp(sourceCell(row, "reviewed_at", PURGE_RELATION), PURGE_RELATION, "reviewed_at");
    const minutes = requiredInteger(
      sourceCell(row, "playtime_minutes_at_review", PURGE_RELATION),
      PURGE_RELATION,
      "playtime_minutes_at_review",
      { min: ZERO, max: TARGET_INTEGER_MAX },
    );
    const progress = optionalInteger(
      nullableSourceCell(row, "progress_at_review", PURGE_RELATION),
      PURGE_RELATION,
      "progress_at_review",
      { min: ZERO, max: BigInt(100) },
    );
    const lastPlayedAtReview = optionalTimestamp(
      nullableSourceCell(row, "last_played_at_review", PURGE_RELATION),
      PURGE_RELATION,
      "last_played_at_review",
    );

    const gateKey = `${accountId}:${reviewedAt.epochMicrosText}`;
    if (seenPurgeGateKeys.has(gateKey)) {
      conflicts.record({
        conflict_class: "purge_review_gate_key_collision",
        source_relation: PURGE_RELATION,
        source_column: "reviewed_at",
        decision:
          "The preservation gate matches a staged purge review to its durable row on (account_id, reviewed_at). Two reviews share that key, so the gate cannot distinguish them; both rows are preserved and the collision is counted.",
        details: { status: "unresolved" },
      });
    }
    seenPurgeGateKeys.add(gateKey);

    const libraryRow = libraryByLegacyId.get(sourceGameId.canonical);
    let gameId: number | null = null;
    let appId: string | null = null;
    if (libraryRow === undefined) {
      conflicts.record({
        conflict_class: "purge_review_library_row_absent",
        source_relation: PURGE_RELATION,
        source_column: "game_id",
        decision:
          "The reviewed library row is not in the library map, so the durable decision keeps a NULL catalogue identity and the raw source UUID stays in migration.legacy_purge_review_archive. The decision itself is never dropped.",
        details: { status: "resolved" },
      });
    } else if (libraryRow.account_id !== accountId) {
      conflicts.record({
        conflict_class: "purge_review_cross_account_library_row",
        source_relation: PURGE_RELATION,
        source_column: "game_id",
        decision:
          "The reviewed library row belongs to a different account and cannot resolve this decision's catalogue identity. The durable row keeps a NULL identity and the mismatch is counted.",
        details: { status: "unresolved" },
      });
    } else {
      gameId = libraryRow.game_id;
      appId = libraryRow.steam_appid;
    }

    if (action === "complete") {
      const matched = gameId !== null && completionsByAccountGame.has(`${accountId}:${gameId}`);
      conflicts.record({
        conflict_class: matched
          ? "purge_complete_with_completion_event"
          : "purge_complete_without_completion_event",
        source_relation: PURGE_RELATION,
        source_column: "action",
        decision:
          "UNRESOLVED for root (D-PRG-1 / S-PRG-COMPLETE): whether an action='complete' review also projects into completion history is an open snapshot decision. This transform generates no completion event; the population is counted on both sides so the decision can be made from measured evidence.",
        details: { status: "unresolved", decision_ref: "D-PRG-1" },
      });
    }

    purgeHistory.push(
      Object.freeze({
        account_id: accountId,
        game_id: gameId,
        steam_app_id: appId,
        action,
        reviewed_at: reviewedAt,
        playtime_minutes_at_review: Number(minutes),
        progress_at_review: progress === null ? null : Number(progress),
        last_played_at_review: lastPlayedAtReview,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
    purgeArchive.push(
      Object.freeze({
        legacy_id: legacyId.original,
        account_id: accountId,
        source_game_id: sourceGameId.original,
        action,
        reviewed_at: reviewedAt,
        playtime_minutes_at_review: Number(minutes),
        progress_at_review: progress === null ? null : Number(progress),
        last_played_at_review: lastPlayedAtReview,
        source_snapshot_hash: run.snapshotHash,
        retention_class: "staging-30d-post-cutover" as const,
      }),
    );
  }

  const byPurgeOrder = (
    left: {
      account_id: number;
      reviewed_at: PgTimestamp;
      game_id?: number | null;
      steam_app_id?: string | null;
      action: PurgeAction;
      playtime_minutes_at_review: number;
      progress_at_review: number | null;
      last_played_at_review: PgTimestamp | null;
    },
    right: {
      account_id: number;
      reviewed_at: PgTimestamp;
      game_id?: number | null;
      steam_app_id?: string | null;
      action: PurgeAction;
      playtime_minutes_at_review: number;
      progress_at_review: number | null;
      last_played_at_review: PgTimestamp | null;
    },
  ): number => {
    if (left.account_id !== right.account_id) return left.account_id - right.account_id;
    const reviewed = comparePgTimestamps(left.reviewed_at, right.reviewed_at);
    if (reviewed !== 0) return reviewed;
    const leftGame = left.game_id ?? -1;
    const rightGame = right.game_id ?? -1;
    if (leftGame !== rightGame) return leftGame - rightGame;
    const leftApp = left.steam_app_id ?? "";
    const rightApp = right.steam_app_id ?? "";
    if (leftApp !== rightApp) return leftApp < rightApp ? -1 : 1;
    if (left.action !== right.action) return left.action < right.action ? -1 : 1;
    if (left.playtime_minutes_at_review !== right.playtime_minutes_at_review) {
      return left.playtime_minutes_at_review - right.playtime_minutes_at_review;
    }
    const leftProgress = left.progress_at_review ?? -1;
    const rightProgress = right.progress_at_review ?? -1;
    if (leftProgress !== rightProgress) return leftProgress - rightProgress;
    return comparePgTimestamps(left.last_played_at_review, right.last_played_at_review);
  };
  purgeHistory.sort(byPurgeOrder);
  purgeArchive.sort((left, right) => {
    const primary = byPurgeOrder(left, right);
    if (primary !== 0) return primary;
    if (left.source_game_id !== right.source_game_id) return left.source_game_id < right.source_game_id ? -1 : 1;
    return left.legacy_id < right.legacy_id ? -1 : left.legacy_id > right.legacy_id ? 1 : 0;
  });

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    playtime_daily: Object.freeze(playtime),
    completion_events: Object.freeze(resolvedEvents),
    unknown_completion_history: Object.freeze(unknownEvents),
    completion_ordering_exceptions: Object.freeze(orderingExceptions),
    completion_event_registry: Object.freeze(registry),
    purge_review_history: Object.freeze(purgeHistory),
    legacy_purge_review_archive: Object.freeze(purgeArchive),
    conflicts: conflicts.toRecords(),
  });
}

/** Stable JSON for order-independent comparisons in tests and reports. */
export function canonicalHistoryResult(result: HistoryTransformResult): string {
  return JSON.stringify({
    run_identity: result.run_identity,
    playtime_daily: result.playtime_daily,
    completion_events: result.completion_events,
    unknown_completion_history: result.unknown_completion_history,
    completion_ordering_exceptions: result.completion_ordering_exceptions,
    completion_event_registry: result.completion_event_registry,
    purge_review_history: result.purge_review_history,
    legacy_purge_review_archive: result.legacy_purge_review_archive,
    conflicts: result.conflicts,
  });
}
