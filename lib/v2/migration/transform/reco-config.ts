import {
  BlockerCollector,
  INT32_MAX,
  STEAM_APP_ID_MAX,
  boundedText,
  cell,
  compareNumericText,
  enumValue,
  instant,
  integerValue,
  jsonDocument,
  jsonScalarString,
  jsonStringLiteral,
  nullableCell,
  numericTextOrNull,
  remainingAccountMap,
  remainingFailure,
  remainingGameMap,
  remainingRow,
  remainingRows,
  remainingRun,
  requireColumns,
  uuidText,
  type AccountMapTargetRecord,
  type GameMap,
  type PgTimestamp,
  type RemainingBlocker,
  type RemainingRunIdentity,
} from "./remaining-shared.ts";

/**
 * Recommendation warm-start evidence and operator configuration.
 *
 * Five source relations, all of them derived counters or authored settings:
 * `user_genre_preferences`, `genre_preference_globals`,
 * `game_preference_globals`, `algorithm_weights` and `app_settings`.
 *
 * Three rules shape every branch below.
 *
 * 1. **A frozen snapshot, not live training state.** The reco tables are keyed
 *    by `snapshot_id` in the target, so the whole population is one immutable
 *    warm-start snapshot rather than a running model. No counter is
 *    recomputed, rescaled or seeded here: the source's exact
 *    positive/total/total_hours values are carried as exact decimal text.
 * 2. **`double precision` is read as text, never as a number.** The COPY cell
 *    is PostgreSQL's shortest round-trip decimal rendering of the float, which
 *    is the exact value; passing it through a JavaScript `number` on the way
 *    to a `numeric(30, 12)` column would re-round it. Anything that will not
 *    fit the destination is refused rather than rounded.
 * 3. **A setting is not a secret store, and this transform does not decide
 *    that it is.** `app_settings` is an open key/value table; a key whose
 *    semantics this batch cannot verify is quarantined into evidence with a
 *    blocker instead of being collapsed into the runtime preference document.
 *    No value is ever logged, and no worker or feature is activated.
 */

const USER_GENRE_RELATION = "user_genre_preferences";
const GENRE_GLOBAL_RELATION = "genre_preference_globals";
const GAME_GLOBAL_RELATION = "game_preference_globals";
const WEIGHTS_RELATION = "algorithm_weights";
const SETTINGS_RELATION = "app_settings";

export const USER_GENRE_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "user_id",
  "genre",
  "context_mood",
  "positive",
  "total",
  "updated_at",
]);
export const GENRE_GLOBAL_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "genre",
  "context_mood",
  "positive",
  "total",
  "updated_at",
]);
export const GAME_GLOBAL_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "steam_appid",
  "positive",
  "total",
  "updated_at",
  "total_hours",
]);
export const WEIGHTS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "key",
  "positive",
  "total",
  "note",
  "updated_at",
]);
export const SETTINGS_SOURCE_COLUMNS: readonly string[] = Object.freeze([
  "id",
  "user_id",
  "key",
  "value",
  "created_at",
  "updated_at",
]);

/** The source's own `context_mood` CHECK, reproduced as the target's `mood`. */
const MOODS = ["any", "brain-off", "chill", "intense"] as const;
export type PreferenceMood = (typeof MOODS)[number];

/**
 * `app_settings` keys this batch has verified against the application code and
 * can collapse into `app.account_preferences.preferences`.
 *
 * The list is deliberately explicit. `app_settings` has no key vocabulary in
 * the schema -- any string can be written -- so an unrecognised key may be an
 * ordinary preference, a feature flag, or a credential someone stored in a
 * convenient place. Collapsing an unknown key into the durable runtime
 * document would carry an unknown semantic (and possibly a secret) into v2,
 * while dropping it would lose an authored value. It is quarantined into
 * bounded evidence with a blocker instead, and root decides.
 */
export const VERIFIED_PREFERENCE_KEYS: readonly string[] = Object.freeze([
  "theme",
  "reduced_motion",
  "default_mood",
  "default_sort",
  "hide_completed",
  "hide_slept",
  "vault_size",
  "duration_bucket",
  "email_opt_in",
]);

/**
 * A key that looks like a credential rather than a preference.
 *
 * This is a defence against a value reaching a durable, exportable runtime
 * document, not a claim about what the source intended. A match is quarantined
 * and blocked; it is never logged, never collapsed, and never echoed in a
 * diagnostic.
 */
const SECRET_LIKE_KEY = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|session)/i;

export type RecoUserGenreRecord = Readonly<{
  account_id: number;
  source_user_id: string;
  genre: string;
  mood: PreferenceMood;
  positive: string;
  total: string;
  source_updated_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

export type RecoGenreGlobalRecord = Readonly<{
  genre: string;
  mood: PreferenceMood;
  positive: string;
  total: string;
  source_updated_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

export type RecoGameGlobalRecord = Readonly<{
  steam_app_id: string;
  /** NULL when the catalogue never held the app; the AppID still survives. */
  game_id: number | null;
  positive: string;
  total: string;
  total_hours: string;
  source_updated_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

export type OperatorWeightRecord = Readonly<{
  config_version: string;
  weight_key: string;
  positive: string;
  total: string;
  note: string | null;
  source_updated_at: PgTimestamp;
  effective_at: PgTimestamp;
  /** Always NULL here: this is the first recorded version of these weights. */
  supersedes_id: null;
  source_snapshot_hash: string;
}>;

/**
 * `reco.warm_start_snapshots`. One row for the whole reco population.
 *
 * `id` is `generated always as identity` in the target, so the loader inserts
 * this row first and stamps the returned id onto every child record below;
 * this transform never invents a surrogate key. The children carry no
 * `snapshot_id` for that reason.
 */
export type WarmStartSnapshotRecord = Readonly<{
  snapshot_key: string;
  source_project_ref: string | null;
  source_captured_at: PgTimestamp | null;
  source_manifest_hash: string | null;
  snapshot_version: number;
  status: "frozen";
  frozen_at: PgTimestamp;
}>;

export type AccountPreferenceRecord = Readonly<{
  account_id: number;
  /** Exact JSON document text; the loader casts it to jsonb. */
  preferences: Readonly<{ text: string; utf8Bytes: number }>;
  updated_at: PgTimestamp;
  source_snapshot_hash: string;
}>;

export type PreferenceEvidenceRecord = Readonly<{
  account_id: number;
  source_account_id: string;
  preference_key: string;
  /** The exact source value, encoded as a JSON string document. */
  value: Readonly<{ text: string; utf8Bytes: number }>;
  source_created_at: PgTimestamp;
  source_updated_at: PgTimestamp;
  source_snapshot_hash: string;
  retention_class: "staging-30d-post-cutover";
}>;

/** A non-loadable private record whose setting semantics remain unresolved. */
export type WithheldSettingRecord = Readonly<{
  account_id: number;
  source_account_id: string;
  preference_key: string;
  value: Readonly<{ text: string; utf8Bytes: number }>;
  source_created_at: PgTimestamp;
  source_updated_at: PgTimestamp;
  source_snapshot_hash: string;
  reason: "unverified_key" | "credential_like_key";
}>;

/**
 * Facts the source does not carry, supplied explicitly by the caller.
 *
 * `frozen_at` and `effective_at` are real instants the migration run records;
 * neither is read from a clock here. Absent or malformed evidence produces a
 * blocker and no snapshot, rather than a snapshot stamped `now()`.
 */
export type WarmStartEvidence = Readonly<{
  snapshot_key: string;
  snapshot_version: string;
  frozen_at: string;
  source_project_ref?: string | null;
  source_captured_at?: string | null;
  source_manifest_hash?: string | null;
}>;

export type OperatorConfigEvidence = Readonly<{
  config_version: string;
  effective_at: string;
}>;

export type RecoConfigInput = Readonly<{
  runIdentity: RemainingRunIdentity;
  accountMap: readonly AccountMapTargetRecord[];
  gameMap: GameMap;
  warmStart: WarmStartEvidence;
  operatorConfig: OperatorConfigEvidence;
  userGenrePreferences: readonly object[];
  genrePreferenceGlobals: readonly object[];
  gamePreferenceGlobals: readonly object[];
  algorithmWeights: readonly object[];
  appSettings: readonly object[];
}>;

/**
 * A counter row withheld because the destination cannot represent it exactly.
 *
 * It carries the identity needed to find the row again plus the exact source
 * text of every counter, so nothing is lost -- the row is simply not loaded
 * until root decides. Never loaded; a nonempty array blocks final commit.
 */
export type WithheldCounterRecord = Readonly<{
  source_relation: "user_genre_preferences" | "genre_preference_globals" | "game_preference_globals" | "algorithm_weights";
  key: string;
  positive_raw: string;
  total_raw: string;
  total_hours_raw: string | null;
  source_snapshot_hash: string;
}>;

export type RecoConfigResult = Readonly<{
  run_identity: Readonly<{ run_id: string; snapshot_hash: string }>;
  warm_start_snapshot: WarmStartSnapshotRecord;
  user_genre_preferences: readonly RecoUserGenreRecord[];
  genre_preference_globals: readonly RecoGenreGlobalRecord[];
  game_preference_globals: readonly RecoGameGlobalRecord[];
  operator_weight_versions: readonly OperatorWeightRecord[];
  account_preferences: readonly AccountPreferenceRecord[];
  legacy_account_preferences_evidence: readonly PreferenceEvidenceRecord[];
  withheld_settings: readonly WithheldSettingRecord[];
  withheld_counters: readonly WithheldCounterRecord[];
  blockers: readonly RemainingBlocker[];
  counts: Readonly<{
    user_genre_rows: number;
    genre_global_rows: number;
    game_global_rows: number;
    weight_rows: number;
    setting_rows: number;
    settings_collapsed: number;
    settings_quarantined: number;
    withheld_settings: number;
    unmapped_games: number;
    withheld_counters: number;
  }>;
}>;

/**
 * `positive`/`total`, or `null` when the destination cannot hold them.
 *
 * `positive <= total` is a real target CHECK and is compared exactly, on the
 * decimal text rather than through a float. An unrepresentable value is not an
 * error: `double precision` carries up to 17 significant digits and
 * `numeric(30, 12)` does not, so the caller withholds that row with a blocker
 * instead of rounding a recorded counter.
 */
function tally(
  row: Record<string, unknown>,
  relation: string,
): Readonly<{ positive: string; total: string }> | null {
  const positive = numericTextOrNull(cell(row, "positive", relation), relation, "positive", { nonNegative: true });
  const total = numericTextOrNull(cell(row, "total", relation), relation, "total", { nonNegative: true });
  if (positive === null || total === null) return null;
  if (compareNumericText(total, positive) < 0) {
    remainingFailure("remaining_order_conflict", relation, "total");
  }
  return Object.freeze({ positive, total });
}

const UNREPRESENTABLE_COUNTER_DECISION =
  "UNRESOLVED for root: this counter is a source `double precision` value with more significant digits than the " +
  "target numeric(30, 12) can hold. Rounding it would change a recorded preference counter, so the row is withheld " +
  "with its exact source text in `withheld_counters` rather than written approximately. Root decides whether the " +
  "target column should widen or whether the loss of precision is acceptable for this population.";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function transformRecoConfigBatch(input: RecoConfigInput): RecoConfigResult {
  if (typeof input !== "object" || input === null) remainingFailure("remaining_input_invalid", "reco_config_input");
  const run = remainingRun(input.runIdentity);
  const accounts = remainingAccountMap(input.accountMap, run);
  const games = remainingGameMap(input.gameMap, run);
  const blockers = new BlockerCollector();
  const withheldCounters: WithheldCounterRecord[] = [];

  /* ---- the frozen warm-start snapshot ---------------------------------- */
  const warmStart = input.warmStart;
  if (typeof warmStart !== "object" || warmStart === null) {
    remainingFailure("remaining_input_invalid", "warm_start_evidence");
  }
  const snapshotKey = boundedText(warmStart.snapshot_key, "warm_start_evidence", "snapshot_key", {
    min: 1,
    max: 200,
    measure: "btrim",
  }) as string;
  const snapshotVersion = integerValue(
    warmStart.snapshot_version,
    "warm_start_evidence",
    "snapshot_version",
    { min: BigInt(1), max: INT32_MAX },
  ) as number;
  const frozenAt = instant(warmStart.frozen_at, "warm_start_evidence", "frozen_at", true) as PgTimestamp;
  const snapshot: WarmStartSnapshotRecord = Object.freeze({
    snapshot_key: snapshotKey,
    source_project_ref: boundedText(
      warmStart.source_project_ref ?? null,
      "warm_start_evidence",
      "source_project_ref",
      { min: 1, max: 200, nullable: true, measure: "btrim" },
    ),
    source_captured_at: instant(
      warmStart.source_captured_at ?? null,
      "warm_start_evidence",
      "source_captured_at",
      false,
    ),
    source_manifest_hash: warmStart.source_manifest_hash ?? null,
    snapshot_version: snapshotVersion,
    status: "frozen" as const,
    frozen_at: frozenAt,
  });

  const configVersion = boundedText(
    input.operatorConfig?.config_version ?? null,
    "operator_config_evidence",
    "config_version",
    { min: 1, max: 200, measure: "btrim" },
  ) as string;
  const effectiveAt = instant(
    input.operatorConfig?.effective_at ?? null,
    "operator_config_evidence",
    "effective_at",
    true,
  ) as PgTimestamp;

  /* ---- reco.user_genre_preferences ------------------------------------- */
  const userGenre: RecoUserGenreRecord[] = [];
  const seenUserGenre = new Set<string>();
  for (const raw of remainingRows(input.userGenrePreferences, USER_GENRE_RELATION)) {
    const row = remainingRow(raw, USER_GENRE_RELATION, run);
    requireColumns(row, USER_GENRE_SOURCE_COLUMNS, USER_GENRE_RELATION);
    const sourceUser = uuidText(cell(row, "user_id", USER_GENRE_RELATION), USER_GENRE_RELATION, "user_id") as {
      original: string;
      canonical: string;
    };
    const genre = boundedText(cell(row, "genre", USER_GENRE_RELATION), USER_GENRE_RELATION, "genre", {
      min: 1,
      max: 200,
      measure: "btrim",
    }) as string;
    const mood = enumValue(cell(row, "context_mood", USER_GENRE_RELATION), MOODS, USER_GENRE_RELATION, "context_mood");
    const key = `${sourceUser.canonical}\0${genre}\0${mood}`;
    if (seenUserGenre.has(key)) remainingFailure("remaining_duplicate_row", USER_GENRE_RELATION, "genre");
    seenUserGenre.add(key);
    let accountId: number;
    try {
      accountId = accounts.lookup(sourceUser.original);
    } catch {
      // The target PK is (snapshot, account, genre, mood): a preference for an
      // account that does not exist has nowhere to go and must not be
      // reassigned to another account.
      remainingFailure("remaining_account_unmapped", USER_GENRE_RELATION, "user_id");
    }
    const counters = tally(row, USER_GENRE_RELATION);
    if (counters === null) {
      withheldCounters.push(
        Object.freeze({
          source_relation: USER_GENRE_RELATION as "user_genre_preferences",
          key,
          positive_raw: cell(row, "positive", USER_GENRE_RELATION),
          total_raw: cell(row, "total", USER_GENRE_RELATION),
          total_hours_raw: null,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      blockers.record("counter_unrepresentable", USER_GENRE_RELATION, "total", UNREPRESENTABLE_COUNTER_DECISION);
      continue;
    }
    userGenre.push(
      Object.freeze({
        account_id: accountId,
        source_user_id: sourceUser.original,
        genre,
        mood,
        ...counters,
        source_updated_at: instant(
          cell(row, "updated_at", USER_GENRE_RELATION),
          USER_GENRE_RELATION,
          "updated_at",
          true,
        ) as PgTimestamp,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  /* ---- reco.genre_preference_globals ----------------------------------- */
  const genreGlobals: RecoGenreGlobalRecord[] = [];
  const seenGenreGlobal = new Set<string>();
  for (const raw of remainingRows(input.genrePreferenceGlobals, GENRE_GLOBAL_RELATION)) {
    const row = remainingRow(raw, GENRE_GLOBAL_RELATION, run);
    requireColumns(row, GENRE_GLOBAL_SOURCE_COLUMNS, GENRE_GLOBAL_RELATION);
    const genre = boundedText(cell(row, "genre", GENRE_GLOBAL_RELATION), GENRE_GLOBAL_RELATION, "genre", {
      min: 1,
      max: 200,
      measure: "btrim",
    }) as string;
    const mood = enumValue(
      cell(row, "context_mood", GENRE_GLOBAL_RELATION),
      MOODS,
      GENRE_GLOBAL_RELATION,
      "context_mood",
    );
    const key = `${genre}\0${mood}`;
    if (seenGenreGlobal.has(key)) remainingFailure("remaining_duplicate_row", GENRE_GLOBAL_RELATION, "genre");
    seenGenreGlobal.add(key);
    const genreCounters = tally(row, GENRE_GLOBAL_RELATION);
    if (genreCounters === null) {
      withheldCounters.push(
        Object.freeze({
          source_relation: GENRE_GLOBAL_RELATION as "genre_preference_globals",
          key,
          positive_raw: cell(row, "positive", GENRE_GLOBAL_RELATION),
          total_raw: cell(row, "total", GENRE_GLOBAL_RELATION),
          total_hours_raw: null,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      blockers.record("counter_unrepresentable", GENRE_GLOBAL_RELATION, "total", UNREPRESENTABLE_COUNTER_DECISION);
      continue;
    }
    genreGlobals.push(
      Object.freeze({
        genre,
        mood,
        ...genreCounters,
        source_updated_at: instant(
          cell(row, "updated_at", GENRE_GLOBAL_RELATION),
          GENRE_GLOBAL_RELATION,
          "updated_at",
          true,
        ) as PgTimestamp,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  /* ---- reco.game_preference_globals ------------------------------------ */
  const gameGlobals: RecoGameGlobalRecord[] = [];
  const seenGameGlobal = new Set<string>();
  let unmappedGames = 0;
  for (const raw of remainingRows(input.gamePreferenceGlobals, GAME_GLOBAL_RELATION)) {
    const row = remainingRow(raw, GAME_GLOBAL_RELATION, run);
    requireColumns(row, GAME_GLOBAL_SOURCE_COLUMNS, GAME_GLOBAL_RELATION);
    const appIdText = cell(row, "steam_appid", GAME_GLOBAL_RELATION);
    if (!/^[0-9]+$/.test(appIdText)) {
      remainingFailure("remaining_invalid_integer", GAME_GLOBAL_RELATION, "steam_appid");
    }
    const appId = BigInt(appIdText);
    if (appId < BigInt(1) || appId > STEAM_APP_ID_MAX) {
      remainingFailure("remaining_invalid_integer", GAME_GLOBAL_RELATION, "steam_appid");
    }
    if (seenGameGlobal.has(appIdText)) {
      remainingFailure("remaining_duplicate_row", GAME_GLOBAL_RELATION, "steam_appid");
    }
    seenGameGlobal.add(appIdText);
    // `game_id` is a nullable FK with ON DELETE SET NULL: a global counter for
    // an app the catalogue never held is still real evidence, keyed by AppID.
    const gameId = games.has(appIdText) ? games.lookup(appIdText) : null;
    const gameCounters = tally(row, GAME_GLOBAL_RELATION);
    const totalHours = numericTextOrNull(
      cell(row, "total_hours", GAME_GLOBAL_RELATION),
      GAME_GLOBAL_RELATION,
      "total_hours",
      { nonNegative: true },
    );
    if (gameCounters === null || totalHours === null) {
      withheldCounters.push(
        Object.freeze({
          source_relation: GAME_GLOBAL_RELATION as "game_preference_globals",
          key: appIdText,
          positive_raw: cell(row, "positive", GAME_GLOBAL_RELATION),
          total_raw: cell(row, "total", GAME_GLOBAL_RELATION),
          total_hours_raw: cell(row, "total_hours", GAME_GLOBAL_RELATION),
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      blockers.record("counter_unrepresentable", GAME_GLOBAL_RELATION, "total_hours", UNREPRESENTABLE_COUNTER_DECISION);
      continue;
    }
    if (gameId === null) unmappedGames += 1;
    gameGlobals.push(
      Object.freeze({
        steam_app_id: appIdText,
        game_id: gameId,
        ...gameCounters,
        total_hours: totalHours,
        source_updated_at: instant(
          cell(row, "updated_at", GAME_GLOBAL_RELATION),
          GAME_GLOBAL_RELATION,
          "updated_at",
          true,
        ) as PgTimestamp,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  /* ---- reco.operator_weight_versions ----------------------------------- */
  const weights: OperatorWeightRecord[] = [];
  const seenWeightKeys = new Set<string>();
  for (const raw of remainingRows(input.algorithmWeights, WEIGHTS_RELATION)) {
    const row = remainingRow(raw, WEIGHTS_RELATION, run);
    requireColumns(row, WEIGHTS_SOURCE_COLUMNS, WEIGHTS_RELATION);
    const sourceWeightKey = boundedText(cell(row, "key", WEIGHTS_RELATION), WEIGHTS_RELATION, "key", {
      min: 1,
      max: 200,
      measure: "btrim",
    }) as string;
    const weightKey =
      sourceWeightKey === "event:slept"
        ? "event:blacklisted"
        : sourceWeightKey === "decision:sleep"
          ? "decision:blacklist"
          : sourceWeightKey;
    if (seenWeightKeys.has(weightKey)) remainingFailure("remaining_duplicate_row", WEIGHTS_RELATION, "key");
    seenWeightKeys.add(weightKey);
    const weightCounters = tally(row, WEIGHTS_RELATION);
    if (weightCounters === null) {
      withheldCounters.push(
        Object.freeze({
          source_relation: WEIGHTS_RELATION as "algorithm_weights",
          key: weightKey,
          positive_raw: cell(row, "positive", WEIGHTS_RELATION),
          total_raw: cell(row, "total", WEIGHTS_RELATION),
          total_hours_raw: null,
          source_snapshot_hash: run.snapshotHash,
        }),
      );
      blockers.record("counter_unrepresentable", WEIGHTS_RELATION, "total", UNREPRESENTABLE_COUNTER_DECISION);
      continue;
    }
    weights.push(
      Object.freeze({
        config_version: configVersion,
        weight_key: weightKey,
        ...weightCounters,
        note: boundedText(nullableCell(row, "note", WEIGHTS_RELATION), WEIGHTS_RELATION, "note", {
          min: 0,
          max: 10_000,
          nullable: true,
        }),
        source_updated_at: instant(
          cell(row, "updated_at", WEIGHTS_RELATION),
          WEIGHTS_RELATION,
          "updated_at",
          true,
        ) as PgTimestamp,
        effective_at: effectiveAt,
        supersedes_id: null,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  /* ---- app.account_preferences + per-key evidence ---------------------- */
  const evidence: PreferenceEvidenceRecord[] = [];
  const withheldSettings: WithheldSettingRecord[] = [];
  const collapsedByAccount = new Map<
    number,
    { pairs: Map<string, string>; updatedAt: PgTimestamp }
  >();
  const seenSettingKeys = new Set<string>();
  const seenSettingIds = new Set<string>();
  let quarantined = 0;
  for (const raw of remainingRows(input.appSettings, SETTINGS_RELATION)) {
    const row = remainingRow(raw, SETTINGS_RELATION, run);
    requireColumns(row, SETTINGS_SOURCE_COLUMNS, SETTINGS_RELATION);
    const settingId = uuidText(cell(row, "id", SETTINGS_RELATION), SETTINGS_RELATION, "id") as {
      original: string;
      canonical: string;
    };
    if (seenSettingIds.has(settingId.canonical)) {
      remainingFailure("remaining_duplicate_row", SETTINGS_RELATION, "id");
    }
    seenSettingIds.add(settingId.canonical);
    const sourceUser = uuidText(cell(row, "user_id", SETTINGS_RELATION), SETTINGS_RELATION, "user_id") as {
      original: string;
      canonical: string;
    };
    const settingKey = boundedText(cell(row, "key", SETTINGS_RELATION), SETTINGS_RELATION, "key", {
      min: 1,
      max: 200,
      measure: "btrim",
    }) as string;
    const pairKey = `${sourceUser.canonical}\0${settingKey}`;
    if (seenSettingKeys.has(pairKey)) remainingFailure("remaining_duplicate_row", SETTINGS_RELATION, "key");
    seenSettingKeys.add(pairKey);
    let accountId: number;
    try {
      accountId = accounts.lookup(sourceUser.original);
    } catch {
      remainingFailure("remaining_account_unmapped", SETTINGS_RELATION, "user_id");
    }
    const value = cell(row, "value", SETTINGS_RELATION);
    const createdAt = instant(
      cell(row, "created_at", SETTINGS_RELATION),
      SETTINGS_RELATION,
      "created_at",
      true,
    ) as PgTimestamp;
    const updatedAt = instant(
      cell(row, "updated_at", SETTINGS_RELATION),
      SETTINGS_RELATION,
      "updated_at",
      true,
    ) as PgTimestamp;

    // The source column is `text`, so the value is encoded as a JSON *string*
    // rather than parsed: parsing "123" or "true" as JSON would silently
    // retype an authored text setting into a number or a boolean.
    const encodedValue = jsonScalarString(value, SETTINGS_RELATION, "value", 32_768);
    const secretLike = SECRET_LIKE_KEY.test(settingKey);
    const verified = VERIFIED_PREFERENCE_KEYS.includes(settingKey);
    if (secretLike || !verified) {
      quarantined += 1;
      withheldSettings.push(Object.freeze({
        account_id: accountId,
        source_account_id: sourceUser.original,
        preference_key: settingKey,
        value: encodedValue,
        source_created_at: createdAt,
        source_updated_at: updatedAt,
        source_snapshot_hash: run.snapshotHash,
        reason: secretLike ? "credential_like_key" : "unverified_key",
      }));
      blockers.record(
        secretLike ? "settings_secret_like_key_quarantined" : "settings_unverified_key_quarantined",
        SETTINGS_RELATION,
        "key",
        secretLike
          ? "UNRESOLVED for root: this app_settings key matches the credential-shaped pattern (secret/token/password/api key/authorization/session). app_settings has no key vocabulary in the schema, so the semantics cannot be verified here. Its private exact value stays in the non-loadable withheld stream and is NOT written to expiring staging or durable app.account_preferences. No value is logged. Root decides whether it is a preference, a feature flag, or a credential to rotate rather than migrate."
          : "UNRESOLVED for root: this app_settings key is not in the verified preference vocabulary this batch could confirm against the application code. Collapsing an unknown key into the durable, exported app.account_preferences document would carry an unverified semantic into v2; dropping it would lose an authored value. Its private exact value stays in the non-loadable withheld stream, and the blocker must be resolved before any final load.",
      );
      continue;
    }

    evidence.push(Object.freeze({
      account_id: accountId,
      source_account_id: sourceUser.original,
      preference_key: settingKey,
      value: encodedValue,
      source_created_at: createdAt,
      source_updated_at: updatedAt,
      source_snapshot_hash: run.snapshotHash,
      retention_class: "staging-30d-post-cutover" as const,
    }));

    const existing = collapsedByAccount.get(accountId);
    if (existing === undefined) {
      collapsedByAccount.set(accountId, { pairs: new Map([[settingKey, value]]), updatedAt });
    } else {
      existing.pairs.set(settingKey, value);
      // The collapsed document's updated_at is the newest contributing row's,
      // a real source instant rather than a migration-time clock.
      if (updatedAt.epochMicros > existing.updatedAt.epochMicros) existing.updatedAt = updatedAt;
    }
  }

  const preferences: AccountPreferenceRecord[] = [];
  for (const [accountId, entry] of collapsedByAccount) {
    // Keys are emitted in sorted order so the document text is deterministic
    // regardless of source row order.
    const keys = [...entry.pairs.keys()].sort(compareText);
    const body = keys
      .map((key) => `${jsonStringLiteral(key)}:${jsonStringLiteral(entry.pairs.get(key) as string)}`)
      .join(",");
    const document = jsonDocument(`{${body}}`, SETTINGS_RELATION, "preferences", {
      topLevel: "object",
      maxBytes: 32_768,
    }) as Readonly<{ text: string; utf8Bytes: number }>;
    preferences.push(
      Object.freeze({
        account_id: accountId,
        preferences: document,
        updated_at: entry.updatedAt,
        source_snapshot_hash: run.snapshotHash,
      }),
    );
  }

  userGenre.sort(
    (left, right) =>
      left.account_id - right.account_id ||
      compareText(left.genre, right.genre) ||
      compareText(left.mood, right.mood),
  );
  genreGlobals.sort((left, right) => compareText(left.genre, right.genre) || compareText(left.mood, right.mood));
  gameGlobals.sort(
    (left, right) =>
      left.steam_app_id.length - right.steam_app_id.length || compareText(left.steam_app_id, right.steam_app_id),
  );
  weights.sort((left, right) => compareText(left.weight_key, right.weight_key));
  preferences.sort((left, right) => left.account_id - right.account_id);
  evidence.sort(
    (left, right) =>
      left.account_id - right.account_id || compareText(left.preference_key, right.preference_key),
  );
  withheldSettings.sort((left, right) =>
    left.account_id - right.account_id || compareText(left.preference_key, right.preference_key),
  );

  return Object.freeze({
    run_identity: Object.freeze({ run_id: run.runId, snapshot_hash: run.snapshotHash }),
    warm_start_snapshot: snapshot,
    user_genre_preferences: Object.freeze(userGenre),
    genre_preference_globals: Object.freeze(genreGlobals),
    game_preference_globals: Object.freeze(gameGlobals),
    operator_weight_versions: Object.freeze(weights),
    account_preferences: Object.freeze(preferences),
    legacy_account_preferences_evidence: Object.freeze(evidence),
    withheld_settings: Object.freeze(withheldSettings),
    withheld_counters: Object.freeze(withheldCounters),
    blockers: blockers.toRecords(),
    counts: Object.freeze({
      user_genre_rows: userGenre.length,
      genre_global_rows: genreGlobals.length,
      game_global_rows: gameGlobals.length,
      weight_rows: weights.length,
      setting_rows: evidence.length,
      settings_collapsed: preferences.length,
      settings_quarantined: quarantined,
      withheld_settings: withheldSettings.length,
      unmapped_games: unmappedGames,
      withheld_counters: withheldCounters.length,
    }),
  });
}

/** Stable JSON for comparisons that must not depend on insertion order. */
export function canonicalRecoConfigResult(result: RecoConfigResult): string {
  return JSON.stringify(result);
}
