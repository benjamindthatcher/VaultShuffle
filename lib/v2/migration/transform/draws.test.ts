import assert from "node:assert/strict";
import test from "node:test";
import { M3GTransformError } from "./commitments-shared.ts";
import {
  transformDraws,
  type DrawEventSourceRow,
  type DrawSourceRow,
  type DrawTransformInput,
  type VaultEventSourceRow,
} from "./draws.ts";

/* -------------------------------------------------------------------------
 * Fixtures.
 * ---------------------------------------------------------------------- */

const SNAPSHOT = "e5".repeat(32);
const FOREIGN_SNAPSHOT = "f6".repeat(32);
const RUN = Object.freeze({ runId: "m3g-draws-test", snapshotHash: SNAPSHOT });

function uuid(tag: string): string {
  return `00000000-0000-4000-8000-${tag.padStart(12, "0")}`;
}

const ACCOUNT_A = uuid("a1");
const ACCOUNT_B = uuid("b1");
const LIBRARY_ROW_A1 = uuid("c1");
const LIBRARY_ROW_B1 = uuid("c2");
const COLLECTION_1 = uuid("d1");
const DRAW_1 = uuid("e1");
const DRAW_2 = uuid("e2");
const DRAW_EVENT_1 = uuid("f1");
const VAULT_EVENT_1 = uuid("07");

const ACCOUNT_MAP = Object.freeze([
  Object.freeze({ legacy_id: ACCOUNT_A, account_id: 7, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: ACCOUNT_B, account_id: 9, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT }),
]);

const GAME_MAP = Object.freeze({
  run_identity: { run_id: RUN.runId, snapshot_hash: SNAPSHOT },
  entries: [Object.freeze({ legacy_app_id: "440", game_id: 101, source_kind: "catalog_games", source_snapshot_hash: SNAPSHOT })],
});

const COLLECTION_MAP = Object.freeze([
  Object.freeze({ legacy_id: COLLECTION_1, account_id: 7, collection_id: 501, source_snapshot_hash: SNAPSHOT }),
]);

const LIBRARY_ROW_MAP = Object.freeze([
  Object.freeze({ legacy_id: LIBRARY_ROW_A1, account_id: 7, game_id: 101, steam_appid: "440", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: LIBRARY_ROW_B1, account_id: 9, game_id: 101, steam_appid: "440", source_snapshot_hash: SNAPSHOT }),
]);

function drawRow(overrides: Partial<DrawSourceRow> = {}): DrawSourceRow {
  return {
    id: DRAW_1,
    user_id: ACCOUNT_A,
    steam_appid: "440",
    drawn_at: "2026-03-04 05:06:07.008009+00",
    session: "evening",
    mood: "chill",
    goal: "new",
    collection_id: null,
    selected_genres: "{Roguelike,Deckbuilder}",
    eligible_pool_count: "12",
    reroll_index: "0",
    finalist_appids: null,
    ...overrides,
  };
}

function drawEventRow(overrides: Partial<DrawEventSourceRow> = {}): DrawEventSourceRow {
  return {
    id: DRAW_EVENT_1,
    user_id: ACCOUNT_A,
    draw_id: DRAW_1,
    event_type: "opened_on_steam",
    created_at: "2026-03-04 05:07:00+00",
    ...overrides,
  };
}

function vaultEventRow(overrides: Partial<VaultEventSourceRow> = {}): VaultEventSourceRow {
  return {
    id: VAULT_EVENT_1,
    user_id: ACCOUNT_A,
    game_id: LIBRARY_ROW_A1,
    action: "pinned",
    context: "{}",
    created_at: "2026-03-04 05:08:00+00",
    ...overrides,
  };
}

function input(overrides: Partial<DrawTransformInput> = {}): DrawTransformInput {
  return {
    runIdentity: RUN,
    accountMap: ACCOUNT_MAP,
    gameMap: GAME_MAP,
    libraryRowMap: LIBRARY_ROW_MAP,
    collectionMap: COLLECTION_MAP,
    draws: [],
    drawEvents: [],
    vaultEvents: [],
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

function oneDraw(overrides: Partial<DrawSourceRow> = {}) {
  return transformDraws(input({ draws: [drawRow(overrides)] })).draws[0];
}

/* -------------------------------------------------------------------------
 * Draws: identity, ordering, and the machine-selection facts
 * ---------------------------------------------------------------------- */

test("retains the draw public UUID verbatim and mints a bigint identity", () => {
  const draw = oneDraw();
  assert.equal(draw.public_id, DRAW_1);
  assert.equal(draw.id, 1);
  assert.equal(draw.account_id, 7);
  assert.equal(draw.steam_app_id, "440");
  assert.equal(draw.game_id, 101);
  assert.equal(draw.session, "evening");
  assert.equal(draw.mood, "chill");
  assert.equal(draw.goal, "new");
  assert.equal(draw.eligible_pool_count, 12);
  assert.equal(draw.reroll_index, 0);
  assert.equal(draw.finalist_app_ids, null);
  assert.equal(draw.source_snapshot_hash, SNAPSHOT);
});

test("orders draws by account, then drawn_at, then UUID, and numbers from the caller's start", () => {
  const result = transformDraws(
    input({
      draws: [
        drawRow({ id: DRAW_2, drawn_at: "2026-03-04 05:06:08+00" }),
        drawRow({ id: DRAW_1, drawn_at: "2026-03-04 05:06:07+00" }),
      ],
    }),
    { startDrawId: 500 },
  );
  assert.deepEqual(
    result.draws.map((d) => d.public_id),
    [DRAW_1, DRAW_2],
  );
  assert.deepEqual(
    result.draws.map((d) => d.id),
    [500, 501],
  );
});

test("produces the same numbering under every input permutation", () => {
  const rows = [
    drawRow({ id: DRAW_1, user_id: ACCOUNT_A, drawn_at: "2026-03-04 05:06:07+00" }),
    drawRow({ id: DRAW_2, user_id: ACCOUNT_B, drawn_at: "2026-03-04 05:06:06+00" }),
  ];
  const forward = transformDraws(input({ draws: rows })).draws.map((d) => d.public_id);
  const reversed = transformDraws(input({ draws: [...rows].reverse() })).draws.map((d) => d.public_id);
  assert.deepEqual(forward, reversed);
});

test("keeps the drawn_at instant exactly, to the microsecond", () => {
  const draw = oneDraw({ drawn_at: "2026-03-04 05:06:07.000001+00" });
  assert.equal(draw.drawn_at.canonicalUtc, "2026-03-04T05:06:07.000001Z");
});

test("normalises an absent session/mood/goal to NULL", () => {
  const draw = oneDraw({ session: null, mood: null, goal: null });
  assert.equal(draw.session, null);
  assert.equal(draw.mood, null);
  assert.equal(draw.goal, null);
});

test("refuses an over-length session, mood or goal rather than truncating it", () => {
  const long = "x".repeat(81);
  assert.equal(code(() => oneDraw({ session: long })), "m3g_invalid_text");
  assert.equal(code(() => oneDraw({ mood: long })), "m3g_invalid_text");
  assert.equal(code(() => oneDraw({ goal: long })), "m3g_invalid_text");
});

/* -------------------------------------------------------------------------
 * Unmapped references never invent an identity or drop the row
 * ---------------------------------------------------------------------- */

test("a draw whose AppID has no catalogue mapping keeps the AppID and reports it", () => {
  const result = transformDraws(input({ draws: [drawRow({ steam_appid: "99999" })] }));
  const draw = result.draws[0];
  assert.equal(draw.game_id, null);
  assert.equal(draw.steam_app_id, "99999");
  assert.equal(result.unresolved_references.length, 1);
  const finding = result.unresolved_references[0];
  assert.equal(finding.code, "draw_game_unmapped");
  assert.equal(finding.source_column, "steam_appid");
  assert.equal(finding.source_identity, "99999");
  assert.equal(finding.disposition, "target_null_source_identity_retained");
});

test("a draw whose source collection has no mapping keeps the source UUID and reports it", () => {
  const foreignCollection = uuid("d9");
  const result = transformDraws(input({ draws: [drawRow({ collection_id: foreignCollection })] }));
  const draw = result.draws[0];
  assert.equal(draw.collection_id, null);
  assert.equal(draw.source_collection_id, foreignCollection);
  assert.equal(result.unresolved_references.length, 1);
  assert.equal(result.unresolved_references[0].code, "draw_collection_unmapped");
});

test("a resolvable collection is mapped and the source UUID is still retained", () => {
  const draw = oneDraw({ collection_id: COLLECTION_1 });
  assert.equal(draw.collection_id, 501);
  assert.equal(draw.source_collection_id, COLLECTION_1);
});

test("refuses a draw whose resolved collection belongs to another account", () => {
  assert.equal(
    code(() => oneDraw({ user_id: ACCOUNT_B, collection_id: COLLECTION_1 })),
    "m3g_cross_tenant_reference",
  );
});

/* -------------------------------------------------------------------------
 * Genre and finalist arrays: exact preservation, no shape coercion
 * ---------------------------------------------------------------------- */

test("preserves the selected-genres array exactly, in source order", () => {
  const draw = oneDraw({ selected_genres: "{Deckbuilder,Roguelike,Roguelike}" });
  assert.equal(draw.selected_genres, '["Deckbuilder","Roguelike","Roguelike"]');
});

test("refuses a selected-genres value that is not valid PostgreSQL array output text", () => {
  assert.equal(code(() => oneDraw({ selected_genres: "not an array" })), "m3g_invalid_array");
  assert.equal(code(() => oneDraw({ selected_genres: "{Action" })), "m3g_invalid_array");
  assert.equal(code(() => oneDraw({ selected_genres: "Action,Indie}" })), "m3g_invalid_array");
});

test("preserves exact finalist AppIDs and their source order", () => {
  const draw = oneDraw({ finalist_appids: "{440,570,620}" });
  assert.equal(draw.finalist_app_ids, "[440,570,620]");
});

test("refuses a finalist list containing a non-positive or malformed AppID", () => {
  assert.equal(code(() => oneDraw({ finalist_appids: "{440,0}" })), "m3g_invalid_array");
  assert.equal(code(() => oneDraw({ finalist_appids: "{440,-5}" })), "m3g_invalid_array");
  assert.equal(code(() => oneDraw({ finalist_appids: "{440.5}" })), "m3g_invalid_array");
});

test("reports an over-size selected_genres or finalist_app_ids array as a SQL-validation advisory, not a rejection", () => {
  const elements = Array.from({ length: 5000 }, (_, i) => `genre-${i}-${"x".repeat(10)}`);
  const hugeGenresSource = `{${elements.join(",")}}`;
  const hugeGenresJson = JSON.stringify(elements);
  const result = transformDraws(input({ draws: [drawRow({ selected_genres: hugeGenresSource })] }));
  assert.equal(result.draws.length, 1);
  assert.equal(result.draws[0].selected_genres, hugeGenresJson);
  assert.ok(result.size_advisories.some((a) => a.column === "selected_genres"));
  assert.ok(result.conflicts.some((c) => c.conflict_class === "draw_selected_genres_size_advisory"));
});

/* -------------------------------------------------------------------------
 * eligible_pool_count / reroll_index: nonnegative target integers
 * ---------------------------------------------------------------------- */

test("refuses a negative eligible_pool_count or reroll_index rather than clamping it", () => {
  assert.equal(code(() => oneDraw({ eligible_pool_count: "-1" })), "m3g_invalid_integer");
  assert.equal(code(() => oneDraw({ reroll_index: "-1" })), "m3g_invalid_integer");
});

test("accepts a zero eligible_pool_count and reroll_index", () => {
  const draw = oneDraw({ eligible_pool_count: "0", reroll_index: "0" });
  assert.equal(draw.eligible_pool_count, 0);
  assert.equal(draw.reroll_index, 0);
});

test("refuses a non-positive steam_appid", () => {
  assert.equal(code(() => oneDraw({ steam_appid: "0" })), "m3g_invalid_integer");
  assert.equal(code(() => oneDraw({ steam_appid: "-10" })), "m3g_invalid_integer");
});

/* -------------------------------------------------------------------------
 * Identity, run, and row-limit discipline
 * ---------------------------------------------------------------------- */

test("refuses a duplicate draw identity", () => {
  assert.equal(
    code(() => transformDraws(input({ draws: [drawRow(), drawRow()] }))),
    "m3g_duplicate_identity",
  );
});

test("refuses a draw row tagged with another run's identity", () => {
  const foreign = { ...drawRow(), runId: RUN.runId, snapshotHash: FOREIGN_SNAPSHOT } as unknown as DrawSourceRow;
  assert.equal(code(() => transformDraws(input({ draws: [foreign] }))), "m3g_mixed_run_identity");
});

test("refuses a game map from another snapshot", () => {
  const foreignGameMap = { run_identity: { run_id: RUN.runId, snapshot_hash: FOREIGN_SNAPSHOT }, entries: [] };
  assert.equal(
    code(() => transformDraws(input({ draws: [drawRow()], gameMap: foreignGameMap }))),
    "m3g_game_map_invalid",
  );
});

test("refuses a collection map from another snapshot", () => {
  const foreignMap = [{ legacy_id: COLLECTION_1, account_id: 7, collection_id: 501, source_snapshot_hash: FOREIGN_SNAPSHOT }];
  assert.equal(
    code(() => transformDraws(input({ draws: [drawRow({ collection_id: COLLECTION_1 })], collectionMap: foreignMap }))),
    "m3g_mixed_run_identity",
  );
});

test("enforces explicit row bounds per relation", () => {
  assert.equal(
    code(() => transformDraws(input({ draws: [drawRow(), drawRow({ id: DRAW_2 })] }), { maxDraws: 1 })),
    "m3g_row_limit",
  );
});

/* -------------------------------------------------------------------------
 * Draw events: served/impression history, kept separate from actions
 * ---------------------------------------------------------------------- */

test("resolves a draw event through the draw it belongs to, not by row position", () => {
  const result = transformDraws(input({ draws: [drawRow()], drawEvents: [drawEventRow()] }));
  assert.equal(result.draw_events.length, 1);
  const event = result.draw_events[0];
  assert.equal(event.public_id, DRAW_EVENT_1);
  assert.equal(event.account_id, 7);
  assert.equal(event.draw_id, result.draws[0].id);
  assert.equal(event.event_type, "opened_on_steam");
});

test("legacy slept draw events become undated blacklisted events", () => {
  const result = transformDraws(input({ draws: [drawRow()], drawEvents: [drawEventRow({ event_type: "slept" })] }));
  assert.equal(result.draw_events[0].event_type, "blacklisted");
});

test("refuses a draw event referencing a draw that was not in this run", () => {
  assert.equal(
    code(() => transformDraws(input({ draws: [], drawEvents: [drawEventRow()] }))),
    "m3g_draw_unmapped",
  );
});

test("refuses a draw event whose account does not match its draw's account", () => {
  assert.equal(
    code(() =>
      transformDraws(
        input({ draws: [drawRow()], drawEvents: [drawEventRow({ user_id: ACCOUNT_B })] }),
      ),
    ),
    "m3g_cross_tenant_reference",
  );
});

test("refuses a duplicate draw-event identity", () => {
  assert.equal(
    code(() =>
      transformDraws(input({ draws: [drawRow()], drawEvents: [drawEventRow(), drawEventRow()] })),
    ),
    "m3g_duplicate_identity",
  );
});

/* -------------------------------------------------------------------------
 * Vault events: user action history, distinct from selection and serving
 * ---------------------------------------------------------------------- */

test("resolves a vault event's game through the library-row map and keeps the legacy identity", () => {
  const result = transformDraws(input({ vaultEvents: [vaultEventRow()] }));
  assert.equal(result.vault_events.length, 1);
  const event = result.vault_events[0];
  assert.equal(event.game_id, 101);
  assert.equal(event.legacy_game_id, LIBRARY_ROW_A1);
  assert.equal(event.action, "pinned");
  assert.equal(event.context, "{}");
});

test("legacy slept vault actions become undated blacklisted actions", () => {
  const result = transformDraws(input({ vaultEvents: [vaultEventRow({ action: "slept" })] }));
  assert.equal(result.vault_events[0].action, "blacklisted");
});

test("a vault event whose library row is not mapped keeps the legacy identity with a NULL target and reports it", () => {
  const foreignRow = uuid("c9");
  const result = transformDraws(input({ vaultEvents: [vaultEventRow({ game_id: foreignRow })] }));
  const event = result.vault_events[0];
  assert.equal(event.game_id, null);
  assert.equal(event.legacy_game_id, foreignRow);
  assert.equal(result.unresolved_references.length, 1);
  assert.equal(result.unresolved_references[0].code, "vault_event_game_unmapped");
});

test("a vault event with no game reference at all keeps both identities NULL and raises no finding", () => {
  const result = transformDraws(input({ vaultEvents: [vaultEventRow({ game_id: null })] }));
  assert.equal(result.vault_events[0].game_id, null);
  assert.equal(result.vault_events[0].legacy_game_id, null);
  assert.equal(result.unresolved_references.length, 0);
});

test("refuses a vault event whose resolved game belongs to another account", () => {
  assert.equal(
    code(() =>
      transformDraws(input({ vaultEvents: [vaultEventRow({ user_id: ACCOUNT_B, game_id: LIBRARY_ROW_A1 })] })),
    ),
    "m3g_cross_tenant_reference",
  );
});

test("preserves the context document exactly and reports an over-size payload as an advisory", () => {
  const doc = JSON.stringify({ note: "x".repeat(70_000) });
  const result = transformDraws(input({ vaultEvents: [vaultEventRow({ context: doc })] }));
  assert.equal(result.vault_events[0].context, doc);
  assert.ok(result.size_advisories.some((a) => a.column === "context"));
});

test("refuses a context document that is not a JSON object", () => {
  assert.equal(code(() => transformDraws(input({ vaultEvents: [vaultEventRow({ context: "[1,2]" })] }))), "m3g_invalid_json");
  assert.equal(code(() => transformDraws(input({ vaultEvents: [vaultEventRow({ context: "not json" })] }))), "m3g_invalid_json");
});

test("refuses an over-length action or event_type rather than truncating it", () => {
  const long = "x".repeat(101);
  assert.equal(code(() => transformDraws(input({ vaultEvents: [vaultEventRow({ action: long })] }))), "m3g_invalid_text");
  assert.equal(
    code(() => transformDraws(input({ draws: [drawRow()], drawEvents: [drawEventRow({ event_type: long })] }))),
    "m3g_invalid_text",
  );
});

/* -------------------------------------------------------------------------
 * Failures never leak a private value
 * ---------------------------------------------------------------------- */

test("keeps every private value out of a rejection", () => {
  const secret = "a-very-secret-session-label-".repeat(4);
  const error = failure(() => oneDraw({ session: secret }));
  const serialised = JSON.stringify(error.toJSON()) + error.message;
  assert.ok(!serialised.includes(secret), "the secret session value leaked into the failure");
});

test("keeps the three families of history separate in one run", () => {
  const result = transformDraws(
    input({
      draws: [drawRow()],
      drawEvents: [drawEventRow()],
      vaultEvents: [vaultEventRow()],
    }),
  );
  assert.equal(result.draws.length, 1);
  assert.equal(result.draw_events.length, 1);
  assert.equal(result.vault_events.length, 1);
});

test("returns the run identity it was given", () => {
  const result = transformDraws(input({ draws: [drawRow()] }));
  assert.deepEqual(result.run_identity, { run_id: RUN.runId, snapshot_hash: SNAPSHOT });
});
