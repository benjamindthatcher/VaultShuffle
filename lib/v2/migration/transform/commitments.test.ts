import assert from "node:assert/strict";
import test from "node:test";
import { M3GTransformError } from "./commitments-shared.ts";
import {
  transformCommitments,
  type CommitmentTransformInput,
  type PinSourceRow,
  type SnoozeSourceRow,
  type VaultStateSourceRow,
} from "./commitments.ts";

/* -------------------------------------------------------------------------
 * Fixtures. The baseline expectations below were computed independently with
 * exact rational arithmetic, not with this module's own conversion.
 * ---------------------------------------------------------------------- */

const SNAPSHOT = "c3".repeat(32);
const FOREIGN_SNAPSHOT = "d4".repeat(32);
const RUN = Object.freeze({ runId: "m3g-commitments-test", snapshotHash: SNAPSHOT });

function uuid(tag: string): string {
  return `00000000-0000-4000-8000-${tag.padStart(12, "0")}`;
}

const ACCOUNT_A = uuid("a1");
const ACCOUNT_B = uuid("b1");
const GAME_1 = uuid("d1");
const GAME_2 = uuid("d2");
const GAME_3 = uuid("d3");
const GAME_B1 = uuid("e1");

const ACCOUNT_MAP = Object.freeze([
  Object.freeze({ legacy_id: ACCOUNT_A, account_id: 7, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: ACCOUNT_B, account_id: 9, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT }),
]);

const LIBRARY_ROW_MAP = Object.freeze([
  Object.freeze({ legacy_id: GAME_1, account_id: 7, game_id: 101, steam_appid: "440", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: GAME_2, account_id: 7, game_id: 102, steam_appid: "570", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: GAME_3, account_id: 7, game_id: 103, steam_appid: "620", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: GAME_B1, account_id: 9, game_id: 101, steam_appid: "440", source_snapshot_hash: SNAPSHOT }),
]);

function pinRow(overrides: Partial<PinSourceRow> = {}): PinSourceRow {
  return {
    user_id: ACCOUNT_A,
    game_id: GAME_1,
    slot: "1",
    pinned_at: "2026-03-04 05:06:07.008009+00",
    scope: "library",
    hours_at_pin: null,
    ...overrides,
  };
}

function snoozeRow(overrides: Partial<SnoozeSourceRow> = {}): SnoozeSourceRow {
  return {
    user_id: ACCOUNT_A,
    game_id: GAME_1,
    snoozed_at: "2026-03-04 05:06:07+00",
    snoozed_until: null,
    ...overrides,
  };
}

function vaultRow(overrides: Partial<VaultStateSourceRow> = {}): VaultStateSourceRow {
  return {
    user_id: ACCOUNT_A,
    current_game_id: null,
    updated_at: "2026-03-04 05:06:07+00",
    ...overrides,
  };
}

function input(overrides: Partial<CommitmentTransformInput> = {}): CommitmentTransformInput {
  return {
    runIdentity: RUN,
    accountMap: ACCOUNT_MAP,
    libraryRowMap: LIBRARY_ROW_MAP,
    pins: [],
    snoozes: [],
    vaultState: [],
    ...overrides,
  };
}

function failure(run: () => unknown): M3GTransformError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof M3GTransformError, `expected M3GTransformError, received ${String(error)}`);
    return error;
  }
  assert.fail("expected an M3GTransformError");
}

function code(run: () => unknown): string {
  return failure(run).m3gCode;
}

function onePin(overrides: Partial<PinSourceRow> = {}) {
  return transformCommitments(input({ pins: [pinRow(overrides)] })).pins[0];
}

/* -------------------------------------------------------------------------
 * Pin baselines: a real unit change, hours to minutes
 * ---------------------------------------------------------------------- */

test("converts whole-minute hours exactly and says so", () => {
  const pin = onePin({ hours_at_pin: "12.5" });
  assert.equal(pin.personal_minutes_baseline, 750);
  assert.equal(pin.baseline_conversion_status, "exact_minutes");
  assert.equal(pin.legacy_hours_at_pin, "12.5");
  assert.equal(pin.legacy_hours_at_pin_raw, "12.5");
});

test("converts the small exact cases the same way", () => {
  assert.equal(onePin({ hours_at_pin: "0" }).personal_minutes_baseline, 0);
  assert.equal(onePin({ hours_at_pin: "0.1" }).personal_minutes_baseline, 6);
  assert.equal(onePin({ hours_at_pin: "0.05" }).personal_minutes_baseline, 3);
  assert.equal(onePin({ hours_at_pin: "0.9" }).personal_minutes_baseline, 54);
});

test("treats a zero baseline as a real measurement, not an absent one", () => {
  const pin = onePin({ hours_at_pin: "0" });
  assert.equal(pin.personal_minutes_baseline, 0);
  assert.equal(pin.baseline_conversion_status, "exact_minutes");
  assert.notEqual(pin.personal_minutes_baseline, null);
});

test("accepts a rounded conversion only when the stated inverse holds", () => {
  // 1.11 hours is 66.6 minutes; round -> 67, and round(67/6) == round(11.1).
  const pin = onePin({ hours_at_pin: "1.11" });
  assert.equal(pin.personal_minutes_baseline, 67);
  assert.equal(pin.baseline_conversion_status, "rounded_checked");
  assert.equal(pin.legacy_hours_at_pin, "1.11");
});

test("reports a rounding that fails the inverse instead of storing it", () => {
  // 1.145 hours is 68.7 minutes; round -> 69, but round(69/6) is 12 and
  // round(11.45) is 11, so the conversion is not reversible to one decimal.
  const pin = onePin({ hours_at_pin: "1.145" });
  assert.equal(pin.personal_minutes_baseline, null);
  assert.equal(pin.baseline_conversion_status, "conflict");
  assert.equal(pin.legacy_hours_at_pin, "1.145");
  assert.equal(pin.legacy_hours_at_pin_raw, "1.145");
});

test("records a rounded and an unrepresentable conversion as separate classes", () => {
  const result = transformCommitments(
    input({
      pins: [
        pinRow({ game_id: GAME_1, slot: "1", hours_at_pin: "1.11" }),
        pinRow({ game_id: GAME_2, slot: "2", hours_at_pin: "1.145" }),
      ],
    }),
  );
  assert.deepEqual(
    result.conflicts.map((row) => [row.conflict_class, row.conflict_count]),
    [
      ["pin_baseline_rounded", 1],
      ["pin_baseline_unrepresentable", 1],
    ],
  );
});

test("keeps a negative baseline out of the target and its text in evidence", () => {
  const pin = onePin({ hours_at_pin: "-1.5" });
  assert.equal(pin.personal_minutes_baseline, null);
  assert.equal(pin.baseline_conversion_status, "conflict");
  assert.equal(pin.legacy_hours_at_pin, "-1.5");
  assert.equal(pin.legacy_hours_at_pin_raw, "-1.5");
});

test("keeps a double that numeric(30,12) cannot hold as raw text only", () => {
  // A shortest-round-trip double can carry 16 decimals; numeric(30,12) cannot.
  const pin = onePin({ hours_at_pin: "1.7000000000000002" });
  assert.equal(pin.legacy_hours_at_pin, null);
  assert.equal(pin.legacy_hours_at_pin_raw, "1.7000000000000002");
  assert.equal(pin.personal_minutes_baseline, null);
  assert.equal(pin.baseline_conversion_status, "conflict");
});

test("reports a baseline beyond the integer minute bound", () => {
  // 40000000 hours is 2400000000 minutes, past integer.
  const pin = onePin({ hours_at_pin: "40000000" });
  assert.equal(pin.personal_minutes_baseline, null);
  assert.equal(pin.baseline_conversion_status, "conflict");
  assert.equal(pin.legacy_hours_at_pin, "40000000");
});

test("accepts the largest baseline that does fit", () => {
  // 35791394 hours is exactly 2147483640 minutes.
  const pin = onePin({ hours_at_pin: "35791394" });
  assert.equal(pin.personal_minutes_baseline, 2147483640);
  assert.equal(pin.baseline_conversion_status, "exact_minutes");
});

test("keeps exponent text raw while the numeric column gets canonical digits", () => {
  const pin = onePin({ hours_at_pin: "1.5e1" });
  assert.equal(pin.personal_minutes_baseline, 900);
  assert.equal(pin.legacy_hours_at_pin, "15");
  assert.equal(pin.legacy_hours_at_pin_raw, "1.5e1");
});

test("reports a non-finite double rather than failing the run", () => {
  for (const raw of ["NaN", "Infinity", "-Infinity"]) {
    const pin = onePin({ hours_at_pin: raw });
    assert.equal(pin.baseline_conversion_status, "conflict", raw);
    assert.equal(pin.legacy_hours_at_pin_raw, raw);
    assert.equal(pin.legacy_hours_at_pin, null, raw);
    assert.equal(pin.personal_minutes_baseline, null, raw);
  }
});

test("calls a null baseline unknown, never zero", () => {
  const pin = onePin({ hours_at_pin: null });
  assert.equal(pin.baseline_conversion_status, "unknown");
  assert.equal(pin.personal_minutes_baseline, null);
  assert.equal(pin.legacy_hours_at_pin, null);
  assert.equal(pin.legacy_hours_at_pin_raw, null);
});

test("refuses a malformed or over-long baseline cell", () => {
  assert.equal(code(() => onePin({ hours_at_pin: "twelve" })), "m3g_invalid_decimal");
  assert.equal(code(() => onePin({ hours_at_pin: "1".repeat(129) })), "m3g_invalid_decimal");
});

/* -------------------------------------------------------------------------
 * Pin scope, slot and identity
 * ---------------------------------------------------------------------- */

test("preserves a deliberate wishlist pin alongside a library pin", () => {
  const result = transformCommitments(
    input({
      pins: [
        pinRow({ scope: "wishlist", slot: "1", game_id: GAME_1 }),
        pinRow({ scope: "library", slot: "1", game_id: GAME_1 }),
      ],
    }),
  );
  assert.deepEqual(
    result.pins.map((row) => [row.scope, row.slot, row.game_id]),
    [
      ["library", 1, 101],
      ["wishlist", 1, 101],
    ],
  );
});

test("keeps every scope the target allows", () => {
  const result = transformCommitments(
    input({
      pins: [
        pinRow({ scope: "all", game_id: GAME_1, slot: "1" }),
        pinRow({ scope: "family", game_id: GAME_2, slot: "1" }),
        pinRow({ scope: "wishlist", game_id: GAME_3, slot: "1" }),
      ],
    }),
  );
  assert.deepEqual(result.pins.map((row) => row.scope), ["library" === "library" ? "wishlist" : "", "family", "all"].slice(1).length === 2 ? ["wishlist", "family", "all"] : []);
});

test("orders pins by account, then the scope order the target declares, then slot", () => {
  const rows = [
    pinRow({ user_id: ACCOUNT_B, game_id: GAME_B1, scope: "all", slot: "3" }),
    pinRow({ scope: "all", game_id: GAME_3, slot: "1" }),
    pinRow({ scope: "library", game_id: GAME_1, slot: "2" }),
    pinRow({ scope: "wishlist", game_id: GAME_2, slot: "1" }),
  ];
  const result = transformCommitments(input({ pins: rows }));
  assert.deepEqual(
    result.pins.map((row) => [row.account_id, row.scope, row.slot]),
    [
      [7, "library", 2],
      [7, "wishlist", 1],
      [7, "all", 1],
      [9, "all", 3],
    ],
  );
});

test("produces the same pin output under every permutation", () => {
  const rows = [
    pinRow({ scope: "library", game_id: GAME_1, slot: "1", hours_at_pin: "1.11" }),
    pinRow({ scope: "wishlist", game_id: GAME_2, slot: "2" }),
    pinRow({ user_id: ACCOUNT_B, game_id: GAME_B1, scope: "family", slot: "3" }),
  ];
  const baseline = JSON.stringify(transformCommitments(input({ pins: rows })));
  for (const order of [
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    assert.equal(JSON.stringify(transformCommitments(input({ pins: order.map((index) => rows[index]) }))), baseline);
  }
});

test("refuses an unknown scope rather than collapsing it", () => {
  assert.equal(code(() => onePin({ scope: "shelf" })), "m3g_invalid_enum");
  assert.equal(code(() => onePin({ scope: "Library" })), "m3g_invalid_enum");
  assert.equal(code(() => onePin({ scope: "" })), "m3g_invalid_enum");
});

test("refuses a slot outside 1..3 rather than clamping it", () => {
  assert.equal(code(() => onePin({ slot: "0" })), "m3g_slot_out_of_range");
  assert.equal(code(() => onePin({ slot: "4" })), "m3g_slot_out_of_range");
  assert.equal(code(() => onePin({ slot: "-1" })), "m3g_slot_out_of_range");
  assert.equal(code(() => onePin({ slot: "1.0" })), "m3g_invalid_integer");
  assert.equal(code(() => onePin({ slot: "40000" })), "m3g_invalid_integer");
});

test("keeps every slot the target allows", () => {
  const result = transformCommitments(
    input({
      pins: [
        pinRow({ slot: "3", game_id: GAME_3 }),
        pinRow({ slot: "1", game_id: GAME_1 }),
        pinRow({ slot: "2", game_id: GAME_2 }),
      ],
    }),
  );
  assert.deepEqual(result.pins.map((row) => row.slot), [1, 2, 3]);
});

test("refuses two pins claiming one slot, or one game twice in a scope", () => {
  assert.equal(
    code(() =>
      transformCommitments(input({ pins: [pinRow({ game_id: GAME_1, slot: "1" }), pinRow({ game_id: GAME_2, slot: "1" })] })),
    ),
    "m3g_duplicate_identity",
  );
  assert.equal(
    code(() =>
      transformCommitments(input({ pins: [pinRow({ game_id: GAME_1, slot: "1" }), pinRow({ game_id: GAME_1, slot: "2" })] })),
    ),
    "m3g_duplicate_identity",
  );
});

test("keeps the pin instant exactly and never restamps it", () => {
  const pin = onePin();
  assert.equal(pin.pinned_at.canonicalUtc, "2026-03-04T05:06:07.008009Z");
  assert.equal(pin.pinned_at.sourceText, "2026-03-04 05:06:07.008009+00");
});

test("refuses a pin on another account's library row", () => {
  assert.equal(code(() => onePin({ game_id: GAME_B1 })), "m3g_cross_tenant_reference");
});

test("refuses a pin whose library row is unmapped", () => {
  assert.equal(code(() => onePin({ game_id: uuid("ff") })), "m3g_library_unmapped");
});

/* -------------------------------------------------------------------------
 * Snoozes
 * ---------------------------------------------------------------------- */

test("keeps an indefinite snooze as a null expiry", () => {
  const result = transformCommitments(input({ snoozes: [snoozeRow({ snoozed_until: null })] }));
  assert.equal(result.snoozes.length, 1);
  assert.equal(result.snoozes[0].until_at, null);
  assert.equal(result.snoozes[0].snoozed_at.canonicalUtc, "2026-03-04T05:06:07.000000Z");
  assert.deepEqual(result.conflicts, []);
});

test("keeps the explicit expiry instant and the columns with no source", () => {
  const result = transformCommitments(
    input({ snoozes: [snoozeRow({ snoozed_until: "2026-04-01 00:00:00.000001+00" })] }),
  );
  assert.equal(result.snoozes[0].until_at?.canonicalUtc, "2026-04-01T00:00:00.000001Z");
  assert.equal(result.snoozes[0].reason, null);
  assert.equal(result.snoozes[0].source, null);
});

test("accepts an expiry equal to the snooze instant", () => {
  const at = "2026-03-04 05:06:07.000000+00";
  const result = transformCommitments(input({ snoozes: [snoozeRow({ snoozed_at: at, snoozed_until: at })] }));
  assert.equal(result.snoozes[0].until_at?.epochMicros, result.snoozes[0].snoozed_at.epochMicros);
});

test("accepts an expiry written in another offset for the same instant", () => {
  const result = transformCommitments(
    input({
      snoozes: [snoozeRow({ snoozed_at: "2026-03-04 05:06:07+00", snoozed_until: "2026-03-04 00:06:07-05" })],
    }),
  );
  assert.equal(result.snoozes[0].until_at?.epochMicros, result.snoozes[0].snoozed_at.epochMicros);
});

test("refuses an inverted snooze by one microsecond rather than repairing it", () => {
  const error = failure(() =>
    transformCommitments(
      input({
        snoozes: [snoozeRow({ snoozed_at: "2026-03-04 05:06:07.000001+00", snoozed_until: "2026-03-04 05:06:07.000000+00" })],
      }),
    ),
  );
  assert.equal(error.m3gCode, "m3g_snooze_inverted");
  assert.equal(error.diagnostics[0].field, "snoozed_until");
});

test("orders snoozes by account then game and refuses a duplicate", () => {
  const result = transformCommitments(
    input({
      snoozes: [
        snoozeRow({ game_id: GAME_3 }),
        snoozeRow({ user_id: ACCOUNT_B, game_id: GAME_B1 }),
        snoozeRow({ game_id: GAME_1 }),
      ],
    }),
  );
  assert.deepEqual(
    result.snoozes.map((row) => [row.account_id, row.game_id]),
    [
      [7, 101],
      [7, 103],
      [9, 101],
    ],
  );
  assert.equal(
    code(() => transformCommitments(input({ snoozes: [snoozeRow(), snoozeRow()] }))),
    "m3g_duplicate_identity",
  );
});

test("refuses a snooze on another account's library row", () => {
  assert.equal(code(() => transformCommitments(input({ snoozes: [snoozeRow({ game_id: GAME_B1 })] }))), "m3g_cross_tenant_reference");
});

/* -------------------------------------------------------------------------
 * Vault state
 * ---------------------------------------------------------------------- */

test("keeps a null current game as a real state", () => {
  const result = transformCommitments(input({ vaultState: [vaultRow({ current_game_id: null })] }));
  assert.deepEqual(
    result.vault_state.map((row) => [row.account_id, row.current_game_id, row.current_draw_ref]),
    [[7, null, null]],
  );
});

test("resolves the current game through the library-row map", () => {
  const result = transformCommitments(input({ vaultState: [vaultRow({ current_game_id: GAME_2 })] }));
  assert.equal(result.vault_state[0].current_game_id, 102);
  assert.equal(result.vault_state[0].updated_at.canonicalUtc, "2026-03-04T05:06:07.000000Z");
});

test("leaves current_draw_ref null and returns the missing-source finding", () => {
  const result = transformCommitments(input({ vaultState: [vaultRow()] }));
  assert.equal(result.vault_state[0].current_draw_ref, null);
  assert.equal(result.physical_findings.length, 1);
  assert.equal(result.physical_findings[0].code, "m3g_no_source_for_current_draw_ref");
  assert.equal(result.physical_findings[0].target_relation, "app.vault_state");
  assert.equal(result.physical_findings[0].target_column, "current_draw_ref");
  assert.equal(result.physical_findings[0].source_relation, "user_vault_state");
});

test("raises no finding when there is no vault state to load", () => {
  assert.deepEqual(transformCommitments(input()).physical_findings, []);
});

test("refuses two vault rows for one account", () => {
  assert.equal(code(() => transformCommitments(input({ vaultState: [vaultRow(), vaultRow()] }))), "m3g_duplicate_identity");
});

test("refuses a current game belonging to another account", () => {
  assert.equal(
    code(() => transformCommitments(input({ vaultState: [vaultRow({ current_game_id: GAME_B1 })] }))),
    "m3g_cross_tenant_reference",
  );
});

test("refuses an unmapped current game rather than nulling a real pick", () => {
  assert.equal(
    code(() => transformCommitments(input({ vaultState: [vaultRow({ current_game_id: uuid("ff") })] }))),
    "m3g_library_unmapped",
  );
});

/* -------------------------------------------------------------------------
 * Run identity, bounds and safe errors
 * ---------------------------------------------------------------------- */

test("keeps the three families separate", () => {
  const result = transformCommitments(
    input({ pins: [pinRow()], snoozes: [snoozeRow({ game_id: GAME_2 })], vaultState: [vaultRow()] }),
  );
  assert.equal(result.pins.length, 1);
  assert.equal(result.snoozes.length, 1);
  assert.equal(result.vault_state.length, 1);
  assert.deepEqual(result.run_identity, { run_id: RUN.runId, snapshot_hash: SNAPSHOT });
});

test("requires an explicit run identity and refuses a foreign-tagged row", () => {
  assert.equal(code(() => transformCommitments(input({ runIdentity: null as never }))), "m3g_run_invalid");
  assert.equal(
    code(() => transformCommitments(input({ pins: [{ ...pinRow(), snapshot_hash: FOREIGN_SNAPSHOT }] }))),
    "m3g_mixed_run_identity",
  );
  assert.equal(
    code(() => transformCommitments(input({ snoozes: [{ ...snoozeRow(), run_id: "other" }] }))),
    "m3g_mixed_run_identity",
  );
  assert.equal(
    code(() => transformCommitments(input({ vaultState: [{ ...vaultRow(), snapshot_hash: FOREIGN_SNAPSHOT }] }))),
    "m3g_mixed_run_identity",
  );
});

test("refuses a library map from another snapshot", () => {
  const foreign = [{ ...LIBRARY_ROW_MAP[0], source_snapshot_hash: FOREIGN_SNAPSHOT }];
  assert.equal(code(() => transformCommitments(input({ libraryRowMap: foreign }))), "m3g_mixed_run_identity");
});

test("enforces explicit row bounds per relation", () => {
  assert.equal(code(() => transformCommitments(input({ pins: [pinRow()] }), { maxPins: 0 })), "m3g_row_limit");
  assert.equal(code(() => transformCommitments(input({ snoozes: [snoozeRow()] }), { maxSnoozes: 0 })), "m3g_row_limit");
  assert.equal(code(() => transformCommitments(input({ vaultState: [vaultRow()] }), { maxVaultState: 0 })), "m3g_row_limit");
});

test("refuses a missing cell rather than reading it as NULL", () => {
  const row = { ...pinRow() } as Record<string, unknown>;
  delete row.scope;
  assert.equal(code(() => transformCommitments(input({ pins: [row as PinSourceRow] }))), "m3g_input_invalid");
  // `snoozed_at` is read as `m3Timestamp(m3Cell(row, "snoozed_at", ...), ...)`, the
  // same two-step shape as `pinned_at` and `updated_at`. An absent key fails at
  // `m3Cell` before `m3Timestamp` ever runs, so it is `m3g_input_invalid` too;
  // `m3g_invalid_timestamp` is reserved for a present-but-unparseable string,
  // which the next test covers.
  const snooze = { ...snoozeRow() } as Record<string, unknown>;
  delete snooze.snoozed_at;
  assert.equal(code(() => transformCommitments(input({ snoozes: [snooze as SnoozeSourceRow] }))), "m3g_input_invalid");
});

test("refuses a malformed instant rather than defaulting to the wall clock", () => {
  assert.equal(code(() => onePin({ pinned_at: "2026-03-04 05:06:07" })), "m3g_invalid_timestamp");
  assert.equal(code(() => onePin({ pinned_at: "yesterday" })), "m3g_invalid_timestamp");
  assert.equal(
    code(() => transformCommitments(input({ vaultState: [vaultRow({ updated_at: "" })] }))),
    "m3g_invalid_timestamp",
  );
});

test("keeps private values out of every failure", () => {
  const error = failure(() => onePin({ scope: "my-secret-shelf" }));
  const serialised = JSON.stringify(error.toJSON()) + error.message;
  assert.ok(!serialised.includes("secret-shelf"));
  assert.ok(!serialised.includes(GAME_1));
  assert.ok(!serialised.includes(ACCOUNT_A));
  assert.deepEqual(error.diagnostics, [
    { code: "m3g_invalid_enum", relation: "user_game_pins", field: "scope", count: 1 },
  ]);
});

test("keeps the baseline source text out of a conversion failure", () => {
  const error = failure(() => onePin({ hours_at_pin: "3.14159secret" }));
  const serialised = JSON.stringify(error.toJSON()) + error.message;
  assert.ok(!serialised.includes("secret"));
  assert.ok(!serialised.includes("3.14159"));
});
