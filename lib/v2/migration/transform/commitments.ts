import {
  compareNumber,
  compareUuid,
  freezeArray,
  m3AccountMap,
  m3Baseline,
  m3Cell,
  m3CheckRowIdentity,
  m3ConflictCollector,
  m3Failure,
  m3Integer,
  m3LibraryRowMap,
  m3LookupAccount,
  m3NullableCell,
  m3Object,
  m3OptionalTimestamp,
  m3RunIdentity,
  m3Rows,
  m3Timestamp,
  m3Uuid,
  sameTenant,
  type BaselineStatus,
  type ConflictRecord,
  type LibraryRowMapRecord,
  type M3GCell,
  type M3GRunIdentity,
  type M3GSourceRunTag,
  type PgTimestamp,
} from "./commitments-shared.ts";

/**
 * `public.user_game_pins`, `public.user_game_snoozes` and
 * `public.user_vault_state`: the three relations that record what a user has
 * committed to rather than what they own.
 *
 * Each one addresses its game by the per-account `user_games` UUID, so each
 * resolves through the same-run library-row map and validates tenancy. None of
 * them consults ownership: a pin is a deliberate act and survives whether or
 * not the library still reports the game as playable.
 *
 * Three unit and bound changes matter here.
 *
 * `hours_at_pin` is `double precision` HOURS and
 * `app.pins.personal_minutes_baseline` is integer MINUTES. The conversion is
 * exact where it can be, checked where it rounds, and reported with the raw
 * source text where it can be neither.
 *
 * `snoozed_until` is unconstrained in the source and
 * `app.snoozes` requires `until_at is null or until_at >= snoozed_at`. A null
 * expiry is an indefinite snooze and stays null. An inverted one is
 * unrepresentable and has no evidence destination, so it is a blocker rather
 * than a silent swap, clamp or null.
 *
 * `app.vault_state.current_draw_ref` has no source column at all. It is left
 * null and the gap is returned as an explicit finding.
 */

const PINS = "user_game_pins";
const SNOOZES = "user_game_snoozes";
const VAULT_STATE = "user_vault_state";

const DEFAULT_MAX_ROWS = 5_000_000;

const SMALLINT_MIN = BigInt("-32768");
const SMALLINT_MAX = BigInt("32767");

/** `app.pins.scope`: `scope in ('library','wishlist','family','all')` (M1:375). */
const PIN_SCOPES = Object.freeze(["library", "wishlist", "family", "all"] as const);
export type PinScope = (typeof PIN_SCOPES)[number];

export type PinSourceRow = Readonly<{
  user_id: M3GCell;
  game_id: M3GCell;
  slot: M3GCell;
  pinned_at: M3GCell;
  scope: M3GCell;
  hours_at_pin: M3GCell;
}> &
  M3GSourceRunTag;

export type SnoozeSourceRow = Readonly<{
  user_id: M3GCell;
  game_id: M3GCell;
  snoozed_at: M3GCell;
  snoozed_until: M3GCell;
}> &
  M3GSourceRunTag;

export type VaultStateSourceRow = Readonly<{
  user_id: M3GCell;
  current_game_id: M3GCell;
  updated_at: M3GCell;
}> &
  M3GSourceRunTag;

/** `app.pins`, including the M3 baseline-provenance extension. */
export type PinRecord = Readonly<{
  account_id: number;
  scope: PinScope;
  slot: number;
  game_id: number;
  pinned_at: PgTimestamp;
  /** Whole minutes, or null when the conversion could not be proven. */
  personal_minutes_baseline: number | null;
  /** Canonical `numeric(30,12)` text, or null when the source does not fit it. */
  legacy_hours_at_pin: string | null;
  /** The source cell, preserved verbatim. */
  legacy_hours_at_pin_raw: string | null;
  baseline_conversion_status: BaselineStatus;
}>;

/** `app.snoozes`. `reason` and `source` have no source column and stay null. */
export type SnoozeRecord = Readonly<{
  account_id: number;
  game_id: number;
  snoozed_at: PgTimestamp;
  /** Null is an indefinite snooze, not a missing value. */
  until_at: PgTimestamp | null;
  reason: null;
  source: null;
}>;

/** `app.vault_state`. `revision` keeps its default. */
export type VaultStateRecord = Readonly<{
  account_id: number;
  current_game_id: number | null;
  /** Always null: the source relation has no current-draw column. */
  current_draw_ref: null;
  updated_at: PgTimestamp;
}>;

/**
 * A destination the source cannot fill, reported rather than invented.
 *
 * This is evidence for root, not a transform decision: the transform emits the
 * honest null and names the column that has no source.
 */
export type CommitmentPhysicalFinding = Readonly<{
  code: string;
  target_relation: string;
  target_column: string;
  source_relation: string;
  detail: string;
}>;

export type CommitmentTransformInput = Readonly<{
  runIdentity: M3GRunIdentity;
  accountMap: unknown;
  libraryRowMap: readonly LibraryRowMapRecord[] | unknown;
  pins: readonly PinSourceRow[];
  snoozes: readonly SnoozeSourceRow[];
  vaultState: readonly VaultStateSourceRow[];
}>;

export type CommitmentTransformOptions = Readonly<{
  maxPins?: number;
  maxSnoozes?: number;
  maxVaultState?: number;
}>;

export type CommitmentTransformResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  pins: readonly PinRecord[];
  snoozes: readonly SnoozeRecord[];
  vault_state: readonly VaultStateRecord[];
  physical_findings: readonly CommitmentPhysicalFinding[];
  conflicts: readonly ConflictRecord[];
}>;

function boundedOption(value: number | undefined, fallback: number, relation: string, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) m3Failure("m3g_input_invalid", relation, field);
  return value;
}

function scopeRank(scope: PinScope): number {
  return PIN_SCOPES.indexOf(scope);
}

export function transformCommitments(
  input: CommitmentTransformInput,
  options: CommitmentTransformOptions = {},
): CommitmentTransformResult {
  const root = m3Object(input, "commitment_input");
  const run = m3RunIdentity(root.runIdentity);
  const accountMap = m3AccountMap(root.accountMap, run);
  const libraryRowMap = m3LibraryRowMap(root.libraryRowMap, run);
  const conflicts = m3ConflictCollector();
  const findings: CommitmentPhysicalFinding[] = [];

  const pins = readPins(root.pins, run, accountMap, libraryRowMap, conflicts, options);
  const snoozes = readSnoozes(root.snoozes, run, accountMap, libraryRowMap, conflicts, options);
  const vaultState = readVaultState(root.vaultState, run, accountMap, libraryRowMap, options);

  if (vaultState.length > 0) {
    findings.push(
      Object.freeze({
        code: "m3g_no_source_for_current_draw_ref",
        target_relation: "app.vault_state",
        target_column: "current_draw_ref",
        source_relation: VAULT_STATE,
        detail:
          "D-VLT-1 states that current_draw_ref is populated with the legacy vault_draws.id, but the 2026-09-09 source inventory of public.user_vault_state has only user_id, current_game_id and updated_at. There is no source column to read, so every row loads with a null current draw and the pointer is left for root to decide. Deriving one from the latest vault_draws row would invent a current pick the source never recorded.",
      }),
    );
  }

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    pins,
    snoozes,
    vault_state: vaultState,
    physical_findings: freezeArray(findings),
    conflicts: conflicts.toRecords(),
  });
}

function readPins(
  value: unknown,
  run: M3GRunIdentity,
  accountMap: ReturnType<typeof m3AccountMap>,
  libraryRowMap: ReturnType<typeof m3LibraryRowMap>,
  conflicts: ReturnType<typeof m3ConflictCollector>,
  options: CommitmentTransformOptions,
): readonly PinRecord[] {
  const maxRows = boundedOption(options.maxPins, DEFAULT_MAX_ROWS, PINS, "maxPins");
  const rows = m3Rows(value, PINS, maxRows);
  const records: PinRecord[] = [];
  const slotKeys = new Set<string>();
  const gameKeys = new Set<string>();

  for (const raw of rows) {
    const row = m3Object(raw, PINS);
    m3CheckRowIdentity(row, run, PINS);

    const accountId = m3LookupAccount(accountMap, m3Cell(row, "user_id", PINS), PINS, "user_id");
    const sourceGame = m3Uuid(m3Cell(row, "game_id", PINS), PINS, "game_id");
    const libraryRow = libraryRowMap.lookup(sourceGame.original);
    sameTenant(accountId, libraryRow.account_id, PINS, "game_id");

    const scopeText = m3Cell(row, "scope", PINS);
    // The source has no scope CHECK, so an unknown scope is a real possibility
    // and the target will not hold it. Scope is the pin's meaning, so it is
    // never collapsed to 'library' to make the row fit.
    if (!(PIN_SCOPES as readonly string[]).includes(scopeText)) m3Failure("m3g_invalid_enum", PINS, "scope");
    const scope = scopeText as PinScope;

    const slotValue = m3Integer(m3Cell(row, "slot", PINS), PINS, "slot", SMALLINT_MIN, SMALLINT_MAX);
    if (slotValue < BigInt(1) || slotValue > BigInt(3)) m3Failure("m3g_slot_out_of_range", PINS, "slot");
    const slot = Number(slotValue);

    const slotKey = `${accountId}/${scope}/${slot}`;
    const gameKey = `${accountId}/${scope}/${libraryRow.game_id}`;
    if (slotKeys.has(slotKey)) m3Failure("m3g_duplicate_identity", PINS, "slot");
    if (gameKeys.has(gameKey)) m3Failure("m3g_duplicate_identity", PINS, "game_id");
    slotKeys.add(slotKey);
    gameKeys.add(gameKey);

    const baseline = m3Baseline(m3NullableCell(row, "hours_at_pin", PINS), PINS, "hours_at_pin");
    if (baseline.status === "rounded_checked") {
      conflicts.record({
        conflict_class: "pin_baseline_rounded",
        source_relation: PINS,
        source_column: "hours_at_pin",
        decision:
          "Hours were converted to whole minutes as round(hours * 60) and accepted only because the stated inverse round(minutes / 6) reproduced round(hours * 10). The source decimal is retained in legacy_hours_at_pin and its exact text in legacy_hours_at_pin_raw.",
      });
    }
    if (baseline.status === "conflict") {
      conflicts.record({
        conflict_class: "pin_baseline_unrepresentable",
        source_relation: PINS,
        source_column: "hours_at_pin",
        decision:
          "The source hours are negative, non-finite, beyond the integer minute bound, or do not survive the checked inverse. personal_minutes_baseline stays null, the exact source text is retained in legacy_hours_at_pin_raw, and nothing is clamped or rounded into range.",
      });
    }

    records.push(
      Object.freeze({
        account_id: accountId,
        scope,
        slot,
        game_id: libraryRow.game_id,
        pinned_at: m3Timestamp(m3Cell(row, "pinned_at", PINS), PINS, "pinned_at"),
        personal_minutes_baseline: baseline.personalMinutesBaseline,
        legacy_hours_at_pin: baseline.legacyHoursAtPin,
        legacy_hours_at_pin_raw: baseline.hoursRaw,
        baseline_conversion_status: baseline.status,
      }),
    );
  }

  records.sort((left, right) => {
    if (left.account_id !== right.account_id) return compareNumber(left.account_id, right.account_id);
    const byScope = compareNumber(scopeRank(left.scope), scopeRank(right.scope));
    if (byScope !== 0) return byScope;
    return compareNumber(left.slot, right.slot);
  });
  return freezeArray(records);
}

function readSnoozes(
  value: unknown,
  run: M3GRunIdentity,
  accountMap: ReturnType<typeof m3AccountMap>,
  libraryRowMap: ReturnType<typeof m3LibraryRowMap>,
  conflicts: ReturnType<typeof m3ConflictCollector>,
  options: CommitmentTransformOptions,
): readonly SnoozeRecord[] {
  const maxRows = boundedOption(options.maxSnoozes, DEFAULT_MAX_ROWS, SNOOZES, "maxSnoozes");
  const rows = m3Rows(value, SNOOZES, maxRows);
  const records: SnoozeRecord[] = [];
  const keys = new Set<string>();

  for (const raw of rows) {
    const row = m3Object(raw, SNOOZES);
    m3CheckRowIdentity(row, run, SNOOZES);

    const accountId = m3LookupAccount(accountMap, m3Cell(row, "user_id", SNOOZES), SNOOZES, "user_id");
    const sourceGame = m3Uuid(m3Cell(row, "game_id", SNOOZES), SNOOZES, "game_id");
    const libraryRow = libraryRowMap.lookup(sourceGame.original);
    sameTenant(accountId, libraryRow.account_id, SNOOZES, "game_id");

    const key = `${accountId}/${libraryRow.game_id}`;
    if (keys.has(key)) m3Failure("m3g_duplicate_identity", SNOOZES, "game_id");
    keys.add(key);

    const snoozedAt = m3Timestamp(m3Cell(row, "snoozed_at", SNOOZES), SNOOZES, "snoozed_at");
    const untilAt = m3OptionalTimestamp(m3NullableCell(row, "snoozed_until", SNOOZES), SNOOZES, "snoozed_until");
    if (untilAt !== null && untilAt.epochMicros < snoozedAt.epochMicros) {
      // M1:393 rejects this row and no evidence relation holds a snooze, so
      // there is nowhere to preserve it. Swapping, clamping or nulling the end
      // would each change what the user asked for.
      conflicts.record({
        conflict_class: "snooze_end_precedes_start",
        source_relation: SNOOZES,
        source_column: "snoozed_until",
        decision:
          "The source does not enforce until_at >= snoozed_at and M1:393 does. There is no snooze evidence relation, so this row has no representable destination and the run stops for a physical decision rather than swapping, clamping or nulling the expiry.",
      });
      m3Failure("m3g_snooze_inverted", SNOOZES, "snoozed_until");
    }

    records.push(
      Object.freeze({
        account_id: accountId,
        game_id: libraryRow.game_id,
        snoozed_at: snoozedAt,
        until_at: untilAt,
        reason: null,
        source: null,
      }),
    );
  }

  records.sort((left, right) => {
    if (left.account_id !== right.account_id) return compareNumber(left.account_id, right.account_id);
    return compareNumber(left.game_id, right.game_id);
  });
  return freezeArray(records);
}

function readVaultState(
  value: unknown,
  run: M3GRunIdentity,
  accountMap: ReturnType<typeof m3AccountMap>,
  libraryRowMap: ReturnType<typeof m3LibraryRowMap>,
  options: CommitmentTransformOptions,
): readonly VaultStateRecord[] {
  const maxRows = boundedOption(options.maxVaultState, DEFAULT_MAX_ROWS, VAULT_STATE, "maxVaultState");
  const rows = m3Rows(value, VAULT_STATE, maxRows);
  const records: VaultStateRecord[] = [];
  const seen = new Set<number>();

  for (const raw of rows) {
    const row = m3Object(raw, VAULT_STATE);
    m3CheckRowIdentity(row, run, VAULT_STATE);

    const accountId = m3LookupAccount(accountMap, m3Cell(row, "user_id", VAULT_STATE), VAULT_STATE, "user_id");
    if (seen.has(accountId)) m3Failure("m3g_duplicate_identity", VAULT_STATE, "user_id");
    seen.add(accountId);

    const currentGameCell = m3NullableCell(row, "current_game_id", VAULT_STATE);
    let currentGameId: number | null = null;
    if (currentGameCell !== null) {
      const sourceGame = m3Uuid(currentGameCell, VAULT_STATE, "current_game_id");
      const libraryRow = libraryRowMap.lookup(sourceGame.original);
      // A current pick is the one commitment that must never be re-owned: a
      // cross-tenant pointer stops the run rather than nulling a real pick or
      // pointing this account at another account's game.
      sameTenant(accountId, libraryRow.account_id, VAULT_STATE, "current_game_id");
      currentGameId = libraryRow.game_id;
    }

    records.push(
      Object.freeze({
        account_id: accountId,
        current_game_id: currentGameId,
        current_draw_ref: null,
        updated_at: m3Timestamp(m3Cell(row, "updated_at", VAULT_STATE), VAULT_STATE, "updated_at"),
      }),
    );
  }

  records.sort((left, right) => compareNumber(left.account_id, right.account_id));
  return freezeArray(records);
}

export { compareUuid, PIN_SCOPES };
