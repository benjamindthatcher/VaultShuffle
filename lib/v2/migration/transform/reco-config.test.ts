import assert from "node:assert/strict";
import test from "node:test";
import { buildGameMap, type GameMap } from "./games.ts";
import { RemainingTransformError } from "./remaining-shared.ts";
import {
  canonicalRecoConfigResult,
  transformRecoConfigBatch,
  VERIFIED_PREFERENCE_KEYS,
  type RecoConfigInput,
} from "./reco-config.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Expectations are written against the physical target, not against the
 * transform: each assertion names the exact record `reco.*`,
 * `app.account_preferences` or `migration.legacy_account_preferences_evidence`
 * should receive, derived from the source values by hand.
 */

const SNAPSHOT = "c".repeat(64);
const RUN = Object.freeze({ runId: "reco-test-run", snapshotHash: SNAPSHOT });
const ACCOUNT_A = "40000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "40000000-0000-4000-8000-00000000000b";

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

function gameMap(appIds: readonly string[] = ["440", "220"]): GameMap {
  return buildGameMap({ runIdentity: RUN, catalogueGames: appIds.map((steam_appid) => ({ steam_appid })) }).map;
}

const WARM_START = Object.freeze({
  snapshot_key: "legacy-reco-warm-start",
  snapshot_version: "1",
  frozen_at: "2026-09-11 00:00:00+00",
  source_project_ref: "pfvblcopcmairdfeqdep",
  source_captured_at: "2026-09-09 00:29:20+00",
});
const OPERATOR_CONFIG = Object.freeze({ config_version: "legacy-import", effective_at: "2026-09-11 00:00:00+00" });

function input(overrides: Partial<RecoConfigInput> = {}): RecoConfigInput {
  return {
    runIdentity: RUN,
    accountMap: ACCOUNT_MAP,
    gameMap: gameMap(),
    warmStart: WARM_START,
    operatorConfig: OPERATOR_CONFIG,
    userGenrePreferences: [],
    genrePreferenceGlobals: [],
    gamePreferenceGlobals: [],
    algorithmWeights: [],
    appSettings: [],
    ...overrides,
  };
}

function failureCode(execute: () => unknown): string {
  try {
    execute();
  } catch (error) {
    assert.ok(error instanceof RemainingTransformError, `expected RemainingTransformError, received ${String(error)}`);
    return error.remainingCode;
  }
  assert.fail("expected a RemainingTransformError");
}

function userGenreRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: ACCOUNT_A,
    genre: "Action",
    context_mood: "chill",
    positive: "3",
    total: "7",
    updated_at: "2026-08-01 12:00:00.000123+00",
    ...overrides,
  };
}

function settingsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "50000000-0000-4000-8000-000000000001",
    user_id: ACCOUNT_A,
    key: "theme",
    value: "dark",
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-02-01 00:00:00+00",
    ...overrides,
  };
}

test("the warm-start snapshot is built from supplied evidence, never from a clock", () => {
  const result = transformRecoConfigBatch(input());
  assert.equal(result.warm_start_snapshot.snapshot_key, "legacy-reco-warm-start");
  assert.equal(result.warm_start_snapshot.snapshot_version, 1);
  assert.equal(result.warm_start_snapshot.status, "frozen");
  assert.equal(result.warm_start_snapshot.frozen_at.canonicalUtc, "2026-09-11T00:00:00.000000Z");
  assert.equal(result.warm_start_snapshot.source_captured_at?.canonicalUtc, "2026-09-09T00:29:20.000000Z");
  // The child rows carry no snapshot_id: the target generates it on insert.
  assert.equal(Object.hasOwn(result.warm_start_snapshot, "id"), false);
});

test("a missing or malformed snapshot version is refused rather than defaulted", () => {
  assert.equal(
    failureCode(() => transformRecoConfigBatch(input({ warmStart: { ...WARM_START, snapshot_version: "0" } }))),
    "remaining_invalid_integer",
  );
  assert.equal(
    failureCode(() => transformRecoConfigBatch(input({ warmStart: { ...WARM_START, frozen_at: "not-a-time" } }))),
    "remaining_invalid_timestamp",
  );
});

test("a preference counter keeps its exact decimal text and never passes through a float", () => {
  const result = transformRecoConfigBatch(
    input({ userGenrePreferences: [userGenreRow({ positive: "0.1", total: "0.300000000001" })] }),
  );
  const row = result.user_genre_preferences[0];
  assert.equal(row.account_id, 1);
  assert.equal(row.source_user_id, ACCOUNT_A);
  assert.equal(row.genre, "Action");
  assert.equal(row.mood, "chill");
  // Exactly the text PostgreSQL printed for the float, to the last digit the
  // destination can hold; nothing is re-rendered through a JS number.
  assert.equal(row.positive, "0.1");
  assert.equal(row.total, "0.300000000001");
  assert.equal(row.source_updated_at.canonicalUtc, "2026-08-01T12:00:00.000123Z");
});

test("a float8 counter too precise for numeric(30,12) is withheld with a blocker, never rounded", () => {
  // 0.30000000000000004 is a real shortest-round-trip float8 rendering: 17
  // significant digits, which the destination cannot represent.
  const result = transformRecoConfigBatch(
    input({ userGenrePreferences: [userGenreRow({ positive: "0.1", total: "0.30000000000000004" })] }),
  );
  assert.equal(result.user_genre_preferences.length, 0);
  assert.equal(result.withheld_counters.length, 1);
  const withheld = result.withheld_counters[0];
  assert.equal(withheld.source_relation, "user_genre_preferences");
  // The exact source text survives in the withheld record.
  assert.equal(withheld.total_raw, "0.30000000000000004");
  assert.equal(result.counts.withheld_counters, 1);
  const blocker = result.blockers.find((entry) => entry.code === "counter_unrepresentable");
  assert.ok(blocker, "an unrepresentable counter must block");
  assert.doesNotMatch(blocker.decision, /0\.30000000000000004/);
});

test("positive above total is the target's own CHECK and fails closed", () => {
  assert.equal(
    failureCode(() =>
      transformRecoConfigBatch(input({ userGenrePreferences: [userGenreRow({ positive: "9", total: "2" })] })),
    ),
    "remaining_order_conflict",
  );
});

test("a non-finite or over-precise counter is refused rather than rounded into numeric(30,12)", () => {
  assert.equal(
    failureCode(() => transformRecoConfigBatch(input({ userGenrePreferences: [userGenreRow({ total: "NaN" })] }))),
    "remaining_invalid_decimal",
  );
  assert.equal(
    failureCode(() => transformRecoConfigBatch(input({ userGenrePreferences: [userGenreRow({ total: "Infinity" })] }))),
    "remaining_invalid_decimal",
  );
  // An over-precise value is withheld rather than thrown: see the dedicated
  // test above for why that is a population case, not a malformed row.
  const overPrecise = transformRecoConfigBatch(
    input({ userGenrePreferences: [userGenreRow({ positive: "1", total: "1.0000000000001" })] }),
  );
  assert.equal(overPrecise.user_genre_preferences.length, 0);
  assert.equal(overPrecise.withheld_counters.length, 1);
});

test("a preference for an account outside the map is refused, never reassigned", () => {
  assert.equal(
    failureCode(() =>
      transformRecoConfigBatch(
        input({ userGenrePreferences: [userGenreRow({ user_id: "40000000-0000-4000-8000-0000000000ff" })] }),
      ),
    ),
    "remaining_account_unmapped",
  );
});

test("a global counter for an app the catalogue never held keeps the AppID with a NULL game_id", () => {
  const result = transformRecoConfigBatch(
    input({
      gamePreferenceGlobals: [
        { steam_appid: "440", positive: "5", total: "9", total_hours: "12.5", updated_at: "2026-08-01 00:00:00+00" },
        { steam_appid: "999999", positive: "1", total: "1", total_hours: "0", updated_at: "2026-08-01 00:00:00+00" },
      ],
    }),
  );
  assert.equal(result.game_preference_globals.length, 2);
  const mapped = result.game_preference_globals.find((row) => row.steam_app_id === "440");
  const unmapped = result.game_preference_globals.find((row) => row.steam_app_id === "999999");
  assert.equal(mapped?.game_id !== null && mapped?.game_id !== undefined, true);
  assert.equal(unmapped?.game_id, null);
  assert.equal(unmapped?.total_hours, "0");
  assert.equal(result.counts.unmapped_games, 1);
});

test("operator weights carry the supplied config version and the source's own instants", () => {
  const result = transformRecoConfigBatch(
    input({
      algorithmWeights: [
        { key: "genre_affinity", positive: "12", total: "20", note: "  hand tuned  ", updated_at: "2026-07-01 00:00:00+00" },
      ],
    }),
  );
  const weight = result.operator_weight_versions[0];
  assert.equal(weight.config_version, "legacy-import");
  assert.equal(weight.weight_key, "genre_affinity");
  assert.equal(weight.note, "  hand tuned  ");
  assert.equal(weight.effective_at.canonicalUtc, "2026-09-11T00:00:00.000000Z");
  assert.equal(weight.source_updated_at.canonicalUtc, "2026-07-01T00:00:00.000000Z");
  assert.equal(weight.supersedes_id, null);
});

test("verified settings collapse into one preference document per account, with the newest source instant", () => {
  const result = transformRecoConfigBatch(
    input({
      appSettings: [
        settingsRow({ id: "50000000-0000-4000-8000-000000000001", key: "theme", value: "dark", updated_at: "2026-02-01 00:00:00+00" }),
        settingsRow({ id: "50000000-0000-4000-8000-000000000002", key: "hide_completed", value: "true", updated_at: "2026-03-05 00:00:00+00" }),
        settingsRow({ id: "50000000-0000-4000-8000-000000000003", user_id: ACCOUNT_B, key: "vault_size", value: "5" }),
      ],
    }),
  );
  assert.equal(result.account_preferences.length, 2);
  const first = result.account_preferences[0];
  assert.equal(first.account_id, 1);
  // Keys sorted, values kept as JSON strings: "true" was authored as text and
  // is not retyped into a boolean.
  assert.equal(first.preferences.text, '{"hide_completed":"true","theme":"dark"}');
  assert.equal(first.updated_at.canonicalUtc, "2026-03-05T00:00:00.000000Z");
  // Every verified setting also reaches bounded evidence.
  assert.equal(result.legacy_account_preferences_evidence.length, 3);
  assert.equal(result.legacy_account_preferences_evidence[0].retention_class, "staging-30d-post-cutover");
  assert.equal(result.counts.settings_collapsed, 2);
  assert.equal(result.counts.settings_quarantined, 0);
});

test("an unverified settings key is withheld with a blocker, never collapsed or loaded into expiring evidence", () => {
  const result = transformRecoConfigBatch(
    input({ appSettings: [settingsRow({ key: "experimental_ranker_v3", value: "on" })] }),
  );
  assert.equal(result.account_preferences.length, 0);
  assert.equal(result.legacy_account_preferences_evidence.length, 0);
  assert.equal(result.withheld_settings.length, 1);
  assert.equal(result.withheld_settings[0].value.text, '"on"');
  assert.equal(result.withheld_settings[0].reason, "unverified_key");
  assert.equal(result.counts.settings_quarantined, 1);
  const blocker = result.blockers.find((entry) => entry.code === "settings_unverified_key_quarantined");
  assert.ok(blocker, "an unverified key must block");
  // The blocker names no key and no value.
  assert.doesNotMatch(blocker.decision, /experimental_ranker_v3|"on"/);
});

test("a credential-shaped settings key is quarantined under its own blocker and never reaches the exported document", () => {
  const result = transformRecoConfigBatch(
    input({ appSettings: [settingsRow({ key: "steam_api_key", value: "ABCDEF0123456789" })] }),
  );
  assert.equal(result.account_preferences.length, 0);
  const blocker = result.blockers.find((entry) => entry.code === "settings_secret_like_key_quarantined");
  assert.ok(blocker, "a secret-shaped key must block");
  assert.doesNotMatch(blocker.decision, /ABCDEF0123456789/);
  // It survives only in the non-loadable private withheld stream.
  assert.equal(result.legacy_account_preferences_evidence.length, 0);
  assert.equal(result.withheld_settings[0].value.text, '"ABCDEF0123456789"');
  assert.equal(result.withheld_settings[0].reason, "credential_like_key");
});

test("every verified preference key is a plain identifier, so none of them trips the secret pattern", () => {
  const result = transformRecoConfigBatch(
    input({
      appSettings: VERIFIED_PREFERENCE_KEYS.map((key, index) =>
        settingsRow({ id: `50000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`, key, value: "x" }),
      ),
    }),
  );
  assert.equal(result.counts.settings_quarantined, 0);
  assert.equal(result.blockers.length, 0);
});

test("duplicate natural keys fail explicitly rather than overwriting", () => {
  assert.equal(
    failureCode(() => transformRecoConfigBatch(input({ userGenrePreferences: [userGenreRow(), userGenreRow()] }))),
    "remaining_duplicate_row",
  );
  assert.equal(
    failureCode(() =>
      transformRecoConfigBatch(
        input({
          appSettings: [settingsRow(), settingsRow({ id: "50000000-0000-4000-8000-000000000002" })],
        }),
      ),
    ),
    "remaining_duplicate_row",
  );
});

test("an unknown mood is refused rather than defaulted to 'any'", () => {
  assert.equal(
    failureCode(() =>
      transformRecoConfigBatch(input({ userGenrePreferences: [userGenreRow({ context_mood: "spicy" })] })),
    ),
    "remaining_invalid_enum",
  );
});

test("a row from another run is refused", () => {
  assert.equal(
    failureCode(() =>
      transformRecoConfigBatch(input({ userGenrePreferences: [userGenreRow({ run_id: "another-run" })] })),
    ),
    "remaining_input_invalid",
  );
});

test("output is identical under permuted input order", () => {
  const rows = [
    userGenreRow({ user_id: ACCOUNT_B, genre: "Puzzle", context_mood: "any" }),
    userGenreRow({ user_id: ACCOUNT_A, genre: "Action", context_mood: "chill" }),
    userGenreRow({ user_id: ACCOUNT_A, genre: "Action", context_mood: "intense" }),
  ];
  const settings = [
    settingsRow({ id: "50000000-0000-4000-8000-00000000000a", key: "theme", value: "dark" }),
    settingsRow({ id: "50000000-0000-4000-8000-00000000000b", key: "vault_size", value: "3" }),
  ];
  const forward = canonicalRecoConfigResult(
    transformRecoConfigBatch(input({ userGenrePreferences: rows, appSettings: settings })),
  );
  const reversed = canonicalRecoConfigResult(
    transformRecoConfigBatch(
      input({ userGenrePreferences: [...rows].reverse(), appSettings: [...settings].reverse() }),
    ),
  );
  assert.equal(forward, reversed);
});
