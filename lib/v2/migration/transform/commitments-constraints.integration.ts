import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { transformCollections, type CollectionMembershipSourceRow, type CollectionSourceRow } from "./collections.ts";
import { transformCommitments, type PinSourceRow, type SnoozeSourceRow, type VaultStateSourceRow } from "./commitments.ts";
import { transformDraws, type DrawEventSourceRow, type DrawSourceRow, type VaultEventSourceRow } from "./draws.ts";
import type { PgTimestamp } from "./scalars.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Physical acceptance for the M3-G collections, commitments and draw-history
 * domain against a real PostgreSQL 17 cluster with M1, M2 and M3 replayed.
 *
 * This file is deliberately NOT named `*.test.ts`: it needs a disposable local
 * cluster, so it is invoked explicitly rather than by the default suite. It
 * contains only private synthetic rows, performs no remote call, and writes
 * only to the disposable database named by its environment.
 *
 * Run it against a cluster created only for this purpose:
 *
 *   VS_M3G_PSQL=node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
 *   VS_M3G_PGHOST=/tmp/vs-m3g-20260911 VS_M3G_PGPORT=55483 \
 *   VS_M3G_PGUSER=vsm3g VS_M3G_PGDATABASE=vaultshuffle_m3g \
 *   node --experimental-strip-types --test \
 *     lib/v2/migration/transform/commitments-constraints.integration.ts
 */

const PSQL = process.env.VS_M3G_PSQL ?? "psql";
const PGHOST = process.env.VS_M3G_PGHOST ?? "/tmp/vs-m3g-20260911";
const PGPORT = process.env.VS_M3G_PGPORT ?? "55483";
const PGUSER = process.env.VS_M3G_PGUSER ?? "vsm3g";
const PGDATABASE = process.env.VS_M3G_PGDATABASE ?? "vaultshuffle_m3g";

type SqlResult = Readonly<{ ok: boolean; stdout: string; stderr: string }>;

function runSql(sql: string): SqlResult {
  const result = spawnSync(
    PSQL,
    ["-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", PGDATABASE, "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", "-f", "-"],
    { input: sql, encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } },
  );
  if (result.error !== undefined) throw result.error;
  return Object.freeze({ ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() });
}

function query(sql: string): string {
  const result = runSql(sql);
  assert.equal(result.ok, true, `query failed: ${result.stderr}`);
  return result.stdout;
}

function expectRejected(sql: string, sqlState: string): string {
  const result = runSql(`\\set VERBOSITY verbose\n${sql}`);
  assert.equal(result.ok, false, "expected PostgreSQL to refuse the statement, but it succeeded");
  assert.ok(
    result.stderr.includes(`SQLSTATE: ${sqlState}`) || result.stderr.includes(sqlState),
    `expected SQLSTATE ${sqlState}, got: ${result.stderr}`,
  );
  return result.stderr;
}

// --- SQL literal rendering -------------------------------------------------

function text(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function num(value: number | null): string {
  if (value === null) return "NULL";
  assert.ok(Number.isFinite(value));
  return String(value);
}

function instant(value: PgTimestamp | null): string {
  if (value === null) return "NULL";
  return `'${value.canonicalUtc}'::timestamptz`;
}

function jsonb(value: string | null): string {
  if (value === null) return "NULL";
  return `${text(value)}::jsonb`;
}

function sha(value: string): string {
  assert.match(value, /^[0-9a-f]{64}$/);
  return `decode('${value}', 'hex')`;
}

// --- synthetic fixture -----------------------------------------------------

const SNAPSHOT = "b7".repeat(32);
const RUN = Object.freeze({ runId: "m3g-constraints", snapshotHash: SNAPSHOT });

function uuid(tag: string): string {
  return `00000000-0000-4000-8000-${tag.padStart(12, "0")}`;
}

const ACCOUNT_A = uuid("a1");
const LIBRARY_ROW_A1 = uuid("b1");
const LIBRARY_ROW_A2 = uuid("b2");
const COLLECTION_1 = uuid("c1");
const DRAW_1 = uuid("d1");
const DRAW_EVENT_1 = uuid("e1");
const VAULT_EVENT_1 = uuid("f1");

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

const GAME_MAP = Object.freeze({
  run_identity: { run_id: RUN.runId, snapshot_hash: SNAPSHOT },
  entries: [
    Object.freeze({ legacy_app_id: "440", game_id: 5, source_kind: "catalog_games", source_snapshot_hash: SNAPSHOT }),
    Object.freeze({ legacy_app_id: "620", game_id: 6, source_kind: "catalog_games", source_snapshot_hash: SNAPSHOT }),
  ],
});

// Two distinct library rows for one account: a pin target and a snooze target.
// A single account cannot own two library rows for the same game, so these map
// to two different games.
const LIBRARY_ROW_MAP = Object.freeze([
  Object.freeze({ legacy_id: LIBRARY_ROW_A1, account_id: 1, game_id: 5, steam_appid: "440", source_snapshot_hash: SNAPSHOT }),
  Object.freeze({ legacy_id: LIBRARY_ROW_A2, account_id: 1, game_id: 6, steam_appid: "620", source_snapshot_hash: SNAPSHOT }),
]);

// --- transforms --------------------------------------------------------

const collectionRow: CollectionSourceRow = {
  id: COLLECTION_1,
  user_id: ACCOUNT_A,
  name: "Weekend picks",
  description: "",
  created_at: "2026-01-01 00:00:00+00",
  updated_at: "2026-01-02 00:00:00+00",
  kind: "custom",
  rules: "{}",
};

const membershipRow: CollectionMembershipSourceRow = {
  collection_id: COLLECTION_1,
  game_id: LIBRARY_ROW_A1,
  notes: null,
  position: "0",
  created_at: "2026-01-01 00:00:00+00",
};

const collections = transformCollections({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  libraryRowMap: LIBRARY_ROW_MAP,
  collections: [collectionRow],
  collectionGames: [membershipRow],
});

// `transformCollections` already emits the map; this domain never rebuilds it.
const collectionMap = collections.collection_map;

const pinRow: PinSourceRow = {
  user_id: ACCOUNT_A,
  game_id: LIBRARY_ROW_A1,
  slot: "1",
  pinned_at: "2026-01-03 00:00:00+00",
  scope: "library",
  hours_at_pin: "12.5",
};

const snoozeRow: SnoozeSourceRow = {
  user_id: ACCOUNT_A,
  game_id: LIBRARY_ROW_A2,
  snoozed_at: "2026-01-04 00:00:00+00",
  snoozed_until: null,
};

const vaultStateRow: VaultStateSourceRow = {
  user_id: ACCOUNT_A,
  current_game_id: LIBRARY_ROW_A1,
  updated_at: "2026-01-05 00:00:00+00",
};

const commitments = transformCommitments({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  libraryRowMap: LIBRARY_ROW_MAP,
  pins: [pinRow],
  snoozes: [snoozeRow],
  vaultState: [vaultStateRow],
});

const drawRow: DrawSourceRow = {
  id: DRAW_1,
  user_id: ACCOUNT_A,
  steam_appid: "440",
  drawn_at: "2026-01-06 00:00:00+00",
  session: "evening",
  mood: "chill",
  goal: "new",
  collection_id: COLLECTION_1,
  selected_genres: "{Roguelike}",
  eligible_pool_count: "8",
  reroll_index: "0",
  finalist_appids: "{440}",
};

const drawEventRow: DrawEventSourceRow = {
  id: DRAW_EVENT_1,
  user_id: ACCOUNT_A,
  draw_id: DRAW_1,
  event_type: "opened_on_steam",
  created_at: "2026-01-06 00:01:00+00",
};

const vaultEventRow: VaultEventSourceRow = {
  id: VAULT_EVENT_1,
  user_id: ACCOUNT_A,
  game_id: LIBRARY_ROW_A1,
  action: "pinned",
  context: "{}",
  created_at: "2026-01-06 00:02:00+00",
};

const draws = transformDraws({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  gameMap: GAME_MAP,
  libraryRowMap: LIBRARY_ROW_MAP,
  collectionMap,
  draws: [drawRow],
  drawEvents: [drawEventRow],
  vaultEvents: [vaultEventRow],
});

// --- setup -----------------------------------------------------------------

test("the disposable cluster has M1, M2 and M3 applied", () => {
  const result = query(
    "select count(*) from information_schema.tables where table_schema in ('app','catalog','ops','migration','reco','support');",
  );
  assert.ok(Number(result) >= 92, `expected at least 92 private relations, found ${result}`);
});

test("synthetic account and catalogue rows are seeded", () => {
  let result = runSql(`insert into app.accounts (id, public_id, account_kind) overriding system value
    values (1, '${ACCOUNT_A}', 'manual');`);
  assert.equal(result.ok, true, result.stderr);
  result = runSql(`insert into catalog.games (id, title, normalized_sort_title, steam_app_id) overriding system value
    values (5, 'A Game', 'a game', 440), (6, 'Another Game', 'another game', 620);`);
  assert.equal(result.ok, true, result.stderr);
});

test("app.collections and app.collection_games accept the typed output", () => {
  assert.equal(collections.collections.length, 1);
  const c = collections.collections[0];
  const result = runSql(
    `insert into app.collections (id, public_id, account_id, collection_kind, name, description, rules) overriding system value
     values (${num(c.id)}, ${text(c.public_id)}, ${num(c.account_id)}, ${text(c.collection_kind)},
       ${text(c.name)}, ${text(c.description)}, ${jsonb(c.rules)});`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(collections.collection_games.length, 1);
  const m = collections.collection_games[0];
  const memberResult = runSql(
    `insert into app.collection_games (account_id, collection_id, game_id, position, note)
     values (${num(m.account_id)}, ${num(m.collection_id)}, ${num(m.game_id)}, ${num(m.position)}, ${text(m.note)});`,
  );
  assert.equal(memberResult.ok, true, memberResult.stderr);
});

test("migration.collection_map accepts the map record", () => {
  for (const record of collectionMap) {
    const result = runSql(
      `insert into migration.collection_map (legacy_id, account_id, collection_id, source_snapshot_hash)
       values (${text(record.legacy_id)}, ${num(record.account_id)}, ${num(record.collection_id)}, ${sha(record.source_snapshot_hash)});`,
    );
    assert.equal(result.ok, true, result.stderr);
  }
});

test("app.pins accepts the converted minute baseline", () => {
  const pin = commitments.pins[0];
  const result = runSql(
    `insert into app.pins (account_id, scope, slot, game_id, pinned_at, personal_minutes_baseline)
     values (${num(pin.account_id)}, ${text(pin.scope)}, ${num(pin.slot)}, ${num(pin.game_id)},
       ${instant(pin.pinned_at)}, ${num(pin.personal_minutes_baseline)});`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select personal_minutes_baseline::text from app.pins;`), "750");
});

test("app.snoozes accepts an indefinite snooze", () => {
  const snooze = commitments.snoozes[0];
  const result = runSql(
    `insert into app.snoozes (account_id, game_id, snoozed_at, until_at, reason, source)
     values (${num(snooze.account_id)}, ${num(snooze.game_id)}, ${instant(snooze.snoozed_at)}, ${instant(snooze.until_at)},
       ${text(snooze.reason)}, ${text(snooze.source)});`,
  );
  assert.equal(result.ok, true, result.stderr);
});

test("app.snoozes refuses an inverted expiry, proving the check is real", () => {
  // The synthetic-rows tests above only prove the transform's typed output; this
  // proves the physical CHECK itself, independent of what the transform emits.
  expectRejected(
    `insert into app.snoozes (account_id, game_id, snoozed_at, until_at)
     values (1, 5, '2026-02-01 00:00:00+00'::timestamptz, '2026-01-31 00:00:00+00'::timestamptz);`,
    "23514",
  );
});

test("app.vault_state accepts one row per account and resolves the current game", () => {
  const state = commitments.vault_state[0];
  const result = runSql(
    `insert into app.vault_state (account_id, current_game_id, current_draw_ref)
     values (${num(state.account_id)}, ${num(state.current_game_id)}, ${text(state.current_draw_ref)});`,
  );
  assert.equal(result.ok, true, result.stderr);
});

test("app.vault_draws, app.vault_draw_events and app.vault_events accept the typed output", () => {
  const draw = draws.draws[0];
  let result = runSql(
    `insert into app.vault_draws (id, public_id, account_id, game_id, steam_app_id, drawn_at, session, mood, goal,
       source_collection_id, collection_id, selected_genres, eligible_pool_count, reroll_index, finalist_app_ids, source_snapshot_hash)
     overriding system value values (${num(draw.id)}, ${text(draw.public_id)}, ${num(draw.account_id)}, ${num(draw.game_id)}, ${draw.steam_app_id},
       ${instant(draw.drawn_at)}, ${text(draw.session)}, ${text(draw.mood)}, ${text(draw.goal)},
       ${text(draw.source_collection_id)}, ${num(draw.collection_id)}, ${jsonb(draw.selected_genres)},
       ${num(draw.eligible_pool_count)}, ${num(draw.reroll_index)}, ${jsonb(draw.finalist_app_ids)}, ${sha(draw.source_snapshot_hash)});`,
  );
  assert.equal(result.ok, true, result.stderr);

  const event = draws.draw_events[0];
  result = runSql(
    `insert into app.vault_draw_events (id, public_id, account_id, draw_id, event_type, occurred_at, source_snapshot_hash)
     overriding system value values (${num(event.id)}, ${text(event.public_id)}, ${num(event.account_id)}, ${num(event.draw_id)},
       ${text(event.event_type)}, ${instant(event.occurred_at)}, ${sha(event.source_snapshot_hash)});`,
  );
  assert.equal(result.ok, true, result.stderr);

  const vaultEvent = draws.vault_events[0];
  result = runSql(
    `insert into app.vault_events (id, public_id, account_id, game_id, legacy_game_id, action, context, occurred_at, source_snapshot_hash)
     overriding system value values (${num(vaultEvent.id)}, ${text(vaultEvent.public_id)}, ${num(vaultEvent.account_id)}, ${num(vaultEvent.game_id)},
       ${text(vaultEvent.legacy_game_id)}, ${text(vaultEvent.action)}, ${jsonb(vaultEvent.context)},
       ${instant(vaultEvent.occurred_at)}, ${sha(vaultEvent.source_snapshot_hash)});`,
  );
  assert.equal(result.ok, true, result.stderr);
});

test("a draw's collection reference is column-specific SET NULL, not a cascading delete", () => {
  // M3:app.vault_draws has `on delete set null (collection_id)` on the composite
  // FK to app.collections, so deleting the collection must detach the draw
  // rather than remove it, while the required tenant key (account_id) survives.
  const before = query(`select count(*) from app.vault_draws;`);
  assert.equal(before, "1");
  const result = runSql(`delete from app.collections where id = ${collections.collections[0].id};`);
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select count(*) from app.vault_draws;`), "1");
  assert.equal(query(`select collection_id from app.vault_draws;`), "");
  assert.equal(query(`select account_id::text from app.vault_draws;`), "1");
  // The collection_games row is a true child and must be gone with its parent.
  assert.equal(query(`select count(*) from app.collection_games;`), "0");
  // migration.collection_map's FK to app.collections is a plain cascade too.
  assert.equal(query(`select count(*) from migration.collection_map;`), "0");
});

const WRITTEN_RELATIONS: readonly (readonly [string, string])[] = Object.freeze([
  ["app.pins", "account_id"],
  ["app.snoozes", "account_id"],
  ["app.vault_state", "account_id"],
  ["app.vault_draws", "account_id"],
  ["app.vault_draw_events", "account_id"],
  ["app.vault_events", "account_id"],
]);

test("every relation this domain writes revalidates cleanly on a no-op update", () => {
  for (const [relation] of WRITTEN_RELATIONS) {
    const count = Number(query(`select count(*) from ${relation};`));
    assert.ok(count > 0, `${relation} received no synthetic row`);
  }
  const result = runSql(
    ["begin;", ...WRITTEN_RELATIONS.map(([relation, column]) => `update ${relation} set ${column} = ${column};`), "commit;"].join(
      "\n",
    ),
  );
  assert.equal(result.ok, true, result.stderr);
});

test("deleting the account removes every personal row and leaves catalogue identity intact", () => {
  const result = runSql(`delete from app.accounts where id = 1;`);
  assert.equal(result.ok, true, result.stderr);
  for (const [relation] of WRITTEN_RELATIONS) {
    assert.equal(Number(query(`select count(*) from ${relation};`)), 0, `${relation} kept a row after account deletion`);
  }
  assert.equal(query(`select count(*) from catalog.games;`), "2");
});
