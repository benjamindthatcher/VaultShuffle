import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fitsNumeric, jsonbUpperBoundBytes } from "./library-shared.ts";
import { parsePgDecimal } from "./scalars.ts";
import { transformLibraryBatch, type LibraryTransformInput, type UserGamesSourceRow } from "./library.ts";
import { transformLegacyGameState, type LegacyGameStateSourceRow } from "./library-state.ts";
import { transformFamilyBatch, type FamilyMemberSourceRow } from "./family.ts";
import {
  transformHistoryBatch,
  type CompletionEventSourceRow,
  type PlaytimeSnapshotSourceRow,
  type PurgeReviewSourceRow,
} from "./history.ts";
import type { PgTimestamp } from "./scalars.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Physical acceptance for the M3-F library domain against a real PostgreSQL 17
 * cluster with M1, M2 and M3 replayed.
 *
 * This file is deliberately NOT named `*.test.ts`: it needs a disposable local
 * cluster, so it is invoked explicitly rather than by the default suite. It
 * contains only private synthetic rows — no real account, Steam identity, note
 * or export ever appears here — performs no remote call, and writes only to the
 * disposable database named by its environment.
 *
 * It proves two different things:
 *
 * 1. the typed records the pure transforms return satisfy the ACTUAL applied
 *    constraints, rather than the constraints this code believes exist; and
 * 2. the physical gaps the contract reports are real. Each one is asserted by
 *    letting PostgreSQL reject the row, so a gap cannot quietly disappear from
 *    the contract while the transform keeps claiming it.
 *
 * Run it against a cluster created only for this purpose:
 *
 *   VS_M3_LIB_PGHOST=/tmp/vs-m3-lib-20260911 \
 *   VS_M3_LIB_PGPORT=55481 \
 *   VS_M3_LIB_PGUSER=vslib \
 *   VS_M3_LIB_PGDATABASE=vaultshuffle_m3_library \
 *   VS_M3_LIB_PSQL=node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
 *   node --experimental-strip-types --test \
 *     lib/v2/migration/transform/library-constraints.integration.ts
 */

const PSQL = process.env.VS_M3_LIB_PSQL ?? "psql";
const PGHOST = process.env.VS_M3_LIB_PGHOST ?? "/tmp/vs-m3-lib-20260911";
const PGPORT = process.env.VS_M3_LIB_PGPORT ?? "55481";
const PGUSER = process.env.VS_M3_LIB_PGUSER ?? "vslib";
const PGDATABASE = process.env.VS_M3_LIB_PGDATABASE ?? "vaultshuffle_m3_library";

type SqlResult = Readonly<{ ok: boolean; stdout: string; stderr: string }>;

function runSql(sql: string): SqlResult {
  const result = spawnSync(
    PSQL,
    ["-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", PGDATABASE, "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", "-f", "-"],
    { input: sql, encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" } },
  );
  if (result.error !== undefined) throw result.error;
  return Object.freeze({
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  });
}

function query(sql: string): string {
  const result = runSql(sql);
  assert.equal(result.ok, true, `query failed: ${result.stderr}`);
  return result.stdout;
}

/** Assert that PostgreSQL refuses a statement, and with which SQLSTATE. */
function expectRejected(sql: string, sqlState: string): string {
  const result = runSql(`\\set VERBOSITY verbose\n${sql}`);
  assert.equal(result.ok, false, `expected PostgreSQL to refuse the statement, but it succeeded`);
  assert.ok(
    result.stderr.includes(`SQLSTATE: ${sqlState}`) || result.stderr.includes(sqlState),
    `expected SQLSTATE ${sqlState}, got: ${result.stderr}`,
  );
  return result.stderr;
}

// --- SQL literal rendering -------------------------------------------------
// Values come from the transforms, never from a template string, and every
// value is rendered through one of these so a literal is always quoted.

function text(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function num(value: number | null): string {
  if (value === null) return "NULL";
  assert.ok(Number.isFinite(value), "a non-finite number cannot be rendered");
  return String(value);
}

/** Exact integer/decimal text goes to PostgreSQL as text, never as a double. */
function exact(value: string | null): string {
  if (value === null) return "NULL";
  assert.match(value, /^[+-]?\d+(?:\.\d+)?$/, "an exact numeric literal must be plain digits");
  return value;
}

function instant(value: PgTimestamp | null): string {
  if (value === null) return "NULL";
  return `'${value.canonicalUtc}'::timestamptz`;
}

function day(value: { sourceText: string }): string {
  return `'${value.sourceText}'::date`;
}

function jsonb(value: Readonly<Record<string, string | number | boolean>>): string {
  return `${text(JSON.stringify(value))}::jsonb`;
}

function sha(value: string): string {
  assert.match(value, /^[0-9a-f]{64}$/);
  return `decode('${value}', 'hex')`;
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

// --- synthetic fixture -----------------------------------------------------

const SNAPSHOT = "a1".repeat(32);
const RUN = Object.freeze({ runId: "m3-library-constraints", snapshotHash: SNAPSHOT });

const ACCOUNT_A = "20000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "20000000-0000-4000-8000-00000000000b";
const ROW_OWNED = "30000000-0000-4000-8000-000000000001";
const ROW_FAMILY = "30000000-0000-4000-8000-000000000002";
const ROW_WISHLIST = "30000000-0000-4000-8000-000000000003";
const ROW_B_OWNED = "30000000-0000-4000-8000-000000000004";
const ROW_INVERTED_RECENCY = "30000000-0000-4000-8000-000000000007";
const MEMBER_ROW = "40000000-0000-4000-8000-000000000001";
const EVENT_RESOLVED = "50000000-0000-4000-8000-000000000001";
const EVENT_UNKNOWN = "50000000-0000-4000-8000-000000000002";
const EVENT_INVERTED = "50000000-0000-4000-8000-000000000003";
const REVIEW_ROW = "60000000-0000-4000-8000-000000000001";
const LENDER = "76561198000000042";
const ABSENT_LENDER = "76561198000000099";

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

const GAME_MAP: LibraryTransformInput["gameMap"] = Object.freeze({
  run_identity: { run_id: RUN.runId, snapshot_hash: SNAPSHOT },
  entries: [
    { legacy_app_id: "10", game_id: 7, source_kind: "catalog_games", source_snapshot_hash: SNAPSHOT },
    { legacy_app_id: "220", game_id: 8, source_kind: "catalog_games", source_snapshot_hash: SNAPSHOT },
    { legacy_app_id: "4294967295", game_id: 9, source_kind: "stub", source_snapshot_hash: SNAPSHOT },
    { legacy_app_id: "500", game_id: 10, source_kind: "catalog_games", source_snapshot_hash: SNAPSHOT },
    { legacy_app_id: "600", game_id: 11, source_kind: "catalog_games", source_snapshot_hash: SNAPSHOT },
  ],
});

function userGamesRow(overrides: Partial<UserGamesSourceRow>): UserGamesSourceRow {
  return {
    id: ROW_OWNED,
    user_id: ACCOUNT_A,
    ownership: "Owned",
    status: "In Progress",
    hours_played: "1.5",
    completion_percentage: "0",
    date_added: null,
    notes: "",
    created_at: "2026-01-02 03:04:05.000000+00",
    updated_at: "2026-01-02 03:04:06.000000+00",
    last_played_at: null,
    completed_at: null,
    slept_at: null,
    completion_suggestion_dismissed_at: null,
    completion_suggestion_dismissed_playtime: null,
    previous_active_status: null,
    catalog_steam_appid: "10",
    last_observed_played_at: null,
    recency_source: null,
    recency_evidence_at: null,
    observed_playtime_minutes: "90",
    review_requested_at: null,
    access_source: "owned",
    family_owner_steam_id: null,
    family_verified_at: null,
    ...overrides,
  };
}

/**
 * One population that reaches every destination this domain owns: an owned row
 * with authored state and activity, a family row with a resolvable lender, a
 * family row whose lender is gone, a wishlist tombstone, and a second account
 * holding the same AppID.
 */
const USER_GAMES: readonly UserGamesSourceRow[] = Object.freeze([
  userGamesRow({
    id: ROW_OWNED,
    catalog_steam_appid: "10",
    observed_playtime_minutes: "90",
    hours_played: "1.5",
    notes: "  a synthetic note  ",
    completed_at: "2026-02-01 10:00:00.000001+00",
    previous_active_status: "Sampled",
    review_requested_at: "2026-02-02 00:00:00+00",
    completion_suggestion_dismissed_at: "2026-02-03 00:00:00+00",
    completion_suggestion_dismissed_playtime: "60",
    last_played_at: "2026-01-31 23:00:00+00",
    last_observed_played_at: "2026-02-01 00:00:00+00",
    recency_source: "steam_exact",
    recency_evidence_at: "2026-02-01 00:00:00+00",
    date_added: "03/09/2026",
    completion_percentage: "55",
  }),
  userGamesRow({
    id: ROW_FAMILY,
    catalog_steam_appid: "220",
    access_source: "family",
    family_owner_steam_id: LENDER,
    family_verified_at: "2026-02-04 00:00:00+00",
    // A family row carrying a measurement. The source never records whose play
    // this reading describes, and no personal table accepts it, so it must
    // become a withheld exception rather than an app.game_activity row keyed by
    // the borrowing account. Math.round(((45/60)*10))/10 = 0.8.
    observed_playtime_minutes: "45",
    hours_played: "0.8",
  }),
  userGamesRow({
    id: ROW_WISHLIST,
    catalog_steam_appid: "4294967295",
    ownership: "Wishlist",
    status: "Not Started",
    // A minutes baseline with no recency evidence on a row that never enters
    // app.library_games: its durable home is
    // app.retired_library_games.last_personal_minutes, and the suppression
    // accounting has to name that table rather than the owned one.
    // Math.round(((15/60)*10))/10 = 0.3.
    observed_playtime_minutes: "15",
    hours_played: "0.3",
  }),
  userGamesRow({
    id: ROW_B_OWNED,
    user_id: ACCOUNT_B,
    catalog_steam_appid: "10",
    observed_playtime_minutes: "2147483647",
    // Math.round(((2147483647 / 60) * 10)) / 10
    hours_played: "35791394.1",
    // A stale window observation: apply_steam_recent_window
    // (20260825191500) can fire while last_observed_played_at is already
    // non-null but older than the 14-day window, leaving it untouched and
    // only advancing recency_source/recency_evidence_at.
    last_observed_played_at: "2026-01-01 00:00:00+00",
    recency_source: "steam_recent_window",
    recency_evidence_at: "2026-02-05 00:00:00+00",
  }),
  userGamesRow({
    id: ROW_INVERTED_RECENCY,
    user_id: ACCOUNT_B,
    catalog_steam_appid: "600",
    observed_playtime_minutes: "45",
    hours_played: "0.8",
    // Inverted against the reviewed writers' usual shape: the raw legacy
    // last_played_at is AFTER last_observed_played_at. No source CHECK forbids
    // it, so both readings must survive with neither replacing the other.
    last_played_at: "2026-02-06 00:00:00+00",
    last_observed_played_at: "2026-02-05 00:00:00+00",
    recency_source: "steam_exact",
    recency_evidence_at: "2026-02-07 00:00:00+00",
  }),
]);

const ROW_RECENCY_EXCEPTION = "30000000-0000-4000-8000-000000000005";

/**
 * A row whose fields do not fit any reviewed writer's pattern: recency
 * evidence (a last-played instant) with no receipt time at all. No source
 * CHECK forbids this, so it must block as an exception rather than silently
 * reusing last_observed_played_at as the receipt time.
 */
const RECENCY_EXCEPTION_ROWS: readonly UserGamesSourceRow[] = Object.freeze([
  userGamesRow({
    id: ROW_RECENCY_EXCEPTION,
    user_id: ACCOUNT_B,
    catalog_steam_appid: "4294967295",
    observed_playtime_minutes: "30",
    hours_played: "0.5",
    last_observed_played_at: "2026-02-05 00:00:00+00",
    recency_source: null,
    recency_evidence_at: null,
  }),
]);

const ROW_FAMILY_RETIRED = "30000000-0000-4000-8000-000000000006";

/**
 * The exact shape `remove_user_family_member_games`
 * (supabase/migrations/20260901193000_share_a_family_library.sql:237-280)
 * writes for an engaged row on family-member removal: ownership rewritten to
 * Wishlist, access_source/family_owner_steam_id left intact,
 * family_verified_at cleared. LENDER is still a resolvable app.family_members
 * row (only this one game's access ended), which is exactly what must NOT
 * become active app.family_game_access.
 */
const FAMILY_RETIRED_ROWS: readonly UserGamesSourceRow[] = Object.freeze([
  userGamesRow({
    id: ROW_FAMILY_RETIRED,
    user_id: ACCOUNT_A,
    catalog_steam_appid: "500",
    ownership: "Wishlist",
    access_source: "family",
    family_owner_steam_id: LENDER,
    family_verified_at: null,
    observed_playtime_minutes: null,
    hours_played: "0.0",
  }),
]);

const ORPHAN_ACCESS: readonly UserGamesSourceRow[] = Object.freeze([
  userGamesRow({
    id: "30000000-0000-4000-8000-00000000000f",
    user_id: ACCOUNT_B,
    catalog_steam_appid: "220",
    access_source: "family",
    family_owner_steam_id: ABSENT_LENDER,
    observed_playtime_minutes: null,
    hours_played: "0.0",
  }),
]);

const FAMILY_MEMBERS: readonly FamilyMemberSourceRow[] = Object.freeze([
  {
    id: MEMBER_ROW,
    user_id: ACCOUNT_A,
    steam_id: LENDER,
    display_name: "  synthetic lender  ",
    avatar_url: "https://cdn.example.test/a.png",
    profile_url: "https://example.test/profiles/synthetic",
    candidate_appids: "{10,220,4294967295}",
    library_seen: "3",
    games_imported: "1",
    last_synced_at: "2026-02-04 00:00:00+00",
    last_error: null,
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-02-04 00:00:00+00",
  },
]);

const STATE_ROWS: readonly LegacyGameStateSourceRow[] = Object.freeze([
  {
    user_id: ACCOUNT_A,
    appid: "10",
    // Disagrees with the authoritative row by one microsecond, and carries a
    // smallint code that is not decoded, so it must be promoted.
    completed_at: "2026-02-01 10:00:00.000002+00",
    slept_at: null,
    prev_active_status: "2",
    dismissed_at: null,
    dismissed_playtime: "60.5",
    review_requested_at: null,
    last_played_at: null,
    last_observed_played_at: null,
    recency_source: "3",
    recency_evidence_at: null,
    family_owner_steam_id: null,
    family_verified_at: null,
  },
  {
    user_id: ACCOUNT_B,
    appid: "220",
    completed_at: null,
    slept_at: null,
    prev_active_status: null,
    dismissed_at: null,
    dismissed_playtime: null,
    review_requested_at: null,
    last_played_at: null,
    last_observed_played_at: null,
    recency_source: null,
    recency_evidence_at: null,
    family_owner_steam_id: ABSENT_LENDER,
    family_verified_at: null,
  },
]);

const SNAPSHOTS: readonly PlaytimeSnapshotSourceRow[] = Object.freeze([
  { user_id: ACCOUNT_A, captured_on: "2026-02-01", total_minutes: "1000", games_with_playtime: "2", created_at: "2026-02-01 23:59:59.999999+00" },
  { user_id: ACCOUNT_A, captured_on: "2026-02-02", total_minutes: "900", games_with_playtime: "2", created_at: "2026-02-02 23:59:59.999999+00" },
  { user_id: ACCOUNT_B, captured_on: "2026-02-02", total_minutes: "9223372036854775807", games_with_playtime: "0", created_at: "2026-02-02 12:00:00+00" },
]);

const COMPLETIONS: readonly CompletionEventSourceRow[] = Object.freeze([
  {
    id: EVENT_RESOLVED,
    user_id: ACCOUNT_A,
    game_id: ROW_OWNED,
    steam_appid: "10",
    source: "sweep",
    claimed_at: "2026-02-01 10:00:00+00",
    undone_at: "2026-02-02 10:00:00+00",
    hours_played: "1.5",
    estimate_minutes: "600",
    price_cents: "1999",
  },
  {
    id: EVENT_UNKNOWN,
    user_id: ACCOUNT_B,
    game_id: null,
    steam_appid: null,
    source: "vault",
    claimed_at: "2026-02-03 10:00:00+00",
    undone_at: null,
    hours_played: "Infinity",
    estimate_minutes: null,
    price_cents: null,
  },
  {
    // decision 4: a valid-schema, zero-observed (source-conflicts-audit-
    // 20260909.json: 0 of 13,157) but not-impossible case. The source has no
    // ordering CHECK; this proves it is withheld rather than hard-failing the
    // load against the target's real CHECK.
    id: EVENT_INVERTED,
    user_id: ACCOUNT_A,
    game_id: ROW_FAMILY,
    steam_appid: "220",
    source: "library",
    claimed_at: "2026-02-05 00:00:00+00",
    undone_at: "2026-02-01 00:00:00+00",
    hours_played: null,
    estimate_minutes: null,
    price_cents: null,
  },
]);

const REVIEWS: readonly PurgeReviewSourceRow[] = Object.freeze([
  {
    id: REVIEW_ROW,
    user_id: ACCOUNT_A,
    game_id: ROW_OWNED,
    action: "complete",
    reviewed_at: "2026-02-06 00:00:00+00",
    playtime_minutes_at_review: "90",
    progress_at_review: null,
    last_played_at_review: "2026-01-31 23:00:00+00",
  },
]);

const library = transformLibraryBatch({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  gameMap: GAME_MAP,
  userGames: [...USER_GAMES, ...ORPHAN_ACCESS, ...RECENCY_EXCEPTION_ROWS, ...FAMILY_RETIRED_ROWS],
});

const family = transformFamilyBatch({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  familyMembers: FAMILY_MEMBERS,
  familyAccessCandidates: library.family_access_candidates,
});

const state = transformLegacyGameState({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  userGameState: STATE_ROWS,
  authoritativeFacts: library.authoritative_facts,
});

const history = transformHistoryBatch({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  gameMap: GAME_MAP,
  libraryRowMap: library.library_row_map,
  playtimeSnapshots: SNAPSHOTS,
  completionEvents: COMPLETIONS,
  purgeReviews: REVIEWS,
});

// --- seed the disposable database -----------------------------------------

test("the disposable cluster has M1, M2 and M3 applied", () => {
  const relations = query(
    `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('app','catalog','reco','ops','support','migration') and c.relkind in ('r','p');`,
  );
  assert.equal(relations, "92");
  // A destination this domain writes to that only M3 creates.
  assert.equal(query(`select to_regclass('app.library_legacy_measurements') is not null;`), "t");
});

test("the proposal's constraint replacement refuses to guess when the applied definition has drifted", () => {
  // The cluster already has the proposal applied, so app.family_access_orphans'
  // disposition CHECK is now the widened one rather than the frozen M3
  // definition the proposal was written against. Re-running the proposal's own
  // guard therefore has to raise rather than drop whatever it finds.
  const proposal = readFileSync(
    new URL("../../../../database/v2/proposals/m3_legacy_preservation_followup.sql", import.meta.url),
    "utf8",
  );
  const blocks = proposal.match(/do \$\$[\s\S]*?end \$\$;/g) ?? [];
  assert.equal(blocks.length, 2, "the proposal must guard both disposition constraints");
  for (const block of blocks) {
    const stderr = expectRejected(block, "P0001");
    assert.match(stderr, /drift: /);
  }
  // The widened definition itself is what is actually installed.
  assert.equal(
    query(
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'family_access_orphans_disposition_check';`,
    ),
    "CHECK ((disposition = ANY (ARRAY['quarantine'::text, 'manual_review'::text, 'resolved'::text, 'retired'::text])))",
  );
});

test("synthetic accounts and catalogue rows are seeded with the mapped identities", () => {
  const seed = [
    "begin;",
    "truncate app.accounts cascade;",
    "truncate catalog.games cascade;",
    `insert into app.accounts (id, account_kind) overriding system value values (1, 'steam'), (2, 'steam');`,
    `insert into catalog.games (id, steam_app_id, title, normalized_sort_title) overriding system value values
       (7, 10, 'Synthetic Seven', 'synthetic seven'),
       (8, 220, 'Synthetic Eight', 'synthetic eight'),
       (9, 4294967295, 'Synthetic Nine', 'synthetic nine'),
       (10, 500, 'Synthetic Ten', 'synthetic ten'),
       (11, 600, 'Synthetic Eleven', 'synthetic eleven');`,
    "commit;",
  ].join("\n");
  const result = runSql(seed);
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select count(*) from app.accounts;`), "2");
  assert.equal(query(`select count(*) from catalog.games;`), "5");
});

// --- library destinations --------------------------------------------------

test("migration.library_row_map accepts every row-map record", () => {
  const values = library.library_row_map
    .map(
      (entry) =>
        `(${text(entry.legacy_id)}, ${num(entry.account_id)}, ${num(entry.game_id)}, ${exact(entry.steam_appid)}, ${sha(entry.source_snapshot_hash)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into migration.library_row_map (legacy_id, account_id, game_id, steam_appid, source_snapshot_hash) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select count(*) from migration.library_row_map;`), String(library.library_row_map.length));
  // The unique (account_id, steam_appid) and (account_id, game_id) pairs hold.
  assert.equal(
    query(`select count(distinct (account_id, steam_appid)) from migration.library_row_map;`),
    String(library.library_row_map.length),
  );
});

test("app.library_games accepts owned rows and keeps unknown minutes NULL", () => {
  const values = library.library_games
    .map((entry) => `(${num(entry.account_id)}, ${num(entry.game_id)}, ${num(entry.playtime_minutes)})`)
    .join(",\n");
  const result = runSql(`insert into app.library_games (account_id, game_id, playtime_minutes) values\n${values};`);
  assert.equal(result.ok, true, result.stderr);
  // The int32 boundary survived the round trip as an exact integer.
  assert.equal(query(`select max(playtime_minutes)::text from app.library_games;`), "2147483647");
  assert.equal(query(`select count(*) from app.library_games where playtime_minutes = 0;`), "0");
});

test("app.game_state accepts the sparse authored row and holds manual_progress NULL", () => {
  const values = library.game_state
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${num(entry.game_id)}, ${instant(entry.completed_at)}, ${bool(entry.blacklisted)},` +
        ` ${text(entry.previous_active_status)}, ${num(entry.manual_progress)}, ${text(entry.notes)},` +
        ` ${instant(entry.review_requested_at)}, ${instant(entry.completion_dismissed_at)}, ${num(entry.completion_dismissed_playtime)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into app.game_state (account_id, game_id, completed_at, blacklisted, previous_active_status,
       manual_progress, notes, review_requested_at,
       completion_dismissed_at, completion_dismissed_playtime) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select count(*) from app.game_state where manual_progress is not null;`), "0");
  // The legacy completion percentage was 55 and must not have become progress.
  assert.equal(query(`select count(*) from app.game_state where notes = '  a synthetic note  ';`), "1");
  assert.equal(
    query(`select to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from app.game_state;`),
    "2026-02-01 10:00:00.000001",
  );
});

test("app.game_activity accepts every emitted row; recency exceptions never reach it", () => {
  // Root's 11 September follow-up: observed_at now sources from
  // recency_evidence_at, which is non-null on every row the transform
  // actually emits here, so every entry inserts cleanly -- no more
  // provable/unprovable split at this layer.
  assert.ok(library.game_activity.length > 0, "the fixture must include activity rows");
  const values = library.game_activity
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${num(entry.game_id)}, ${num(entry.last_observed_minutes)}, ${instant(entry.last_played_at)},` +
        ` ${instant(entry.legacy_last_played_at)}, ${instant(entry.observed_at)}, ${text(entry.evidence_source)},` +
        ` ${text(entry.recency_evidence_kind)}, ${instant(entry.interval_started_at)}, ${instant(entry.interval_ended_at)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into app.game_activity (account_id, game_id, last_observed_minutes, last_played_at, legacy_last_played_at,
       observed_at, evidence_source, recency_evidence_kind, interval_started_at, interval_ended_at) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(
    query(`select string_agg(recency_evidence_kind, ',' order by account_id, game_id) from app.game_activity;`),
    "steam_exact,steam_recent_window,steam_exact",
  );
  // ROW_B_OWNED's stale window observation: last_played_at (target) keeps the
  // pre-existing last_observed_played_at, not the newer receipt time.
  assert.equal(
    query(`select last_played_at from app.game_activity where recency_evidence_kind = 'steam_recent_window';`),
    "2026-01-01 00:00:00+00",
  );
  assert.equal(
    query(`select observed_at from app.game_activity where recency_evidence_kind = 'steam_recent_window';`),
    "2026-02-05 00:00:00+00",
  );

  // Both distinct raw play facts land durably, in the direction each was
  // found. ROW_OWNED: raw last_played_at (2026-01-31 23:00) is BEFORE the
  // observed reading that seeds last_played_at.
  assert.equal(
    query(`select legacy_last_played_at from app.game_activity where account_id = 1 and game_id = 7;`),
    "2026-01-31 23:00:00+00",
  );
  assert.equal(
    query(`select last_played_at from app.game_activity where account_id = 1 and game_id = 7;`),
    "2026-02-01 00:00:00+00",
  );
  // ROW_INVERTED_RECENCY: the raw reading is AFTER the observed one, and is
  // stored exactly as found -- no ordering CHECK rejects it, and neither
  // timestamp was substituted for the other.
  assert.equal(
    query(`select legacy_last_played_at from app.game_activity where account_id = 2 and game_id = 11;`),
    "2026-02-06 00:00:00+00",
  );
  assert.equal(
    query(`select last_played_at from app.game_activity where account_id = 2 and game_id = 11;`),
    "2026-02-05 00:00:00+00",
  );
  // ROW_B_OWNED has no raw reading to preserve, so the durable column stays
  // NULL rather than repeating the observed one.
  assert.equal(
    query(`select count(*) from app.game_activity where account_id = 2 and game_id = 7 and legacy_last_played_at is null;`),
    "1",
  );

  // Every withheld row stayed out: the no-receipt-time exception and the
  // family measurement that has no personal destination at all.
  assert.equal(query(`select count(*) from app.game_activity;`), String(library.game_activity.length));
  assert.equal(library.recency_exceptions.length, 2);
  assert.deepEqual(
    [...library.recency_exceptions].map((entry) => entry.reason).sort(),
    ["family_access_measurement_unassignable", "receipt_time_absent_with_recency_signal"],
  );
  // The family row's minutes are carried exactly by the exception, not dropped
  // and not written to any personal table.
  const familyException = library.recency_exceptions.find(
    (entry) => entry.reason === "family_access_measurement_unassignable",
  );
  assert.equal(familyException?.observed_playtime_minutes, "45");
  assert.equal(
    query(`select count(*) from app.game_activity where account_id = 1 and game_id = 8;`),
    "0",
  );
  assert.equal(query(`select count(*) from app.library_games where account_id = 1 and game_id = 8;`), "0");

  // Regression guard: the underlying invariant this domain now depends on
  // staying enforced is still real -- a raw NULL observed_at is refused.
  expectRejected(
    `insert into app.game_activity (account_id, game_id, last_observed_minutes, last_played_at, observed_at, evidence_source, recency_evidence_kind)
     values (1, 9, 5, NULL, NULL, 'unknown', 'unknown');`,
    "23502",
  );
  // The new column carries no ordering constraint: an inverted pair is
  // accepted deliberately, because the source has no CHECK that forbids one.
  const inverted = runSql(
    `insert into app.game_activity (account_id, game_id, last_observed_minutes, last_played_at, legacy_last_played_at,
       observed_at, evidence_source, recency_evidence_kind)
     values (1, 9, 5, '2026-01-01 00:00:00+00', '2026-06-01 00:00:00+00', now(), 'unknown', 'unknown');`,
  );
  assert.equal(inverted.ok, true, inverted.stderr);
  const removed = runSql(`delete from app.game_activity where account_id = 1 and game_id = 9;`);
  assert.equal(removed.ok, true, removed.stderr);
});

test("app.retired_library_games accepts the labelled legacy-Wishlist tombstone and its NULL-safe CHECK refuses an unlabelled null loss instant", () => {
  assert.equal(library.retired_library_games.length, 1);
  const entry = library.retired_library_games[0];
  assert.equal(entry.access_lost_at, null);
  assert.equal(entry.loss_reason, "unknown");
  assert.equal(entry.legacy_ownership, "Wishlist");

  // Explicit legacy acceptance: the proposal's relaxed NOT NULL plus the
  // labelled row the transform actually emits now inserts cleanly.
  const accepted = runSql(
    `insert into app.retired_library_games (account_id, game_id, last_personal_minutes, last_observed_at, access_lost_at, loss_reason, legacy_ownership)
     values (${num(entry.account_id)}, ${num(entry.game_id)}, ${num(entry.last_personal_minutes)},
       ${instant(entry.last_observed_at)}, ${instant(entry.access_lost_at)}, ${text(entry.loss_reason)}, ${text(entry.legacy_ownership)});`,
  );
  assert.equal(accepted.ok, true, accepted.stderr);
  assert.equal(query(`select count(*) from app.retired_library_games where access_lost_at is null;`), "1");
  assert.equal(query(`select legacy_ownership from app.retired_library_games;`), "Wishlist");
  // The suppressed baseline's real destination, proved physically: this row's
  // minutes never reached app.library_games and are durable here instead.
  assert.equal(query(`select last_personal_minutes from app.retired_library_games;`), "15");
  assert.equal(
    query(`select count(*) from app.library_games where account_id = ${num(entry.account_id)} and game_id = ${num(entry.game_id)};`),
    "0",
  );

  // NULL bypass guard: an unlabelled null loss instant (no legacy_ownership)
  // must still be refused -- the CHECK must not evaluate to SQL UNKNOWN and
  // silently pass a null access_lost_at through for any other account/game.
  expectRejected(
    `insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
     values (2, 8, NULL, 'unknown', NULL);`,
    "23514",
  );
  // Root's acceptance review: the authorized legacy case is exactly source
  // Wishlist. A legacy 'Owned' label is a real, valid value of this column
  // and still may not carry a null loss instant.
  expectRejected(
    `insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
     values (2, 8, NULL, 'unknown', 'Owned');`,
    "23514",
  );
  // An unrecognised label is refused by the column's own literal CHECK, so it
  // can never reach the null-loss-instant exception at all.
  expectRejected(
    `insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
     values (2, 8, NULL, 'unknown', 'wishlist');`,
    "23514",
  );
  expectRejected(
    `insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
     values (2, 8, now(), 'unknown', 'Borrowed');`,
    "23514",
  );
  // Normal runtime access loss still requires a real instant: 'unknown' with a
  // Wishlist label is the ONLY null-access_lost_at case; a complete_snapshot or
  // manual reason never bypasses it, even carrying that exact label.
  expectRejected(
    `insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
     values (2, 8, NULL, 'complete_snapshot', 'Wishlist');`,
    "23514",
  );
  expectRejected(
    `insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
     values (2, 8, NULL, 'manual', 'Wishlist');`,
    "23514",
  );
  // The runtime default is untouched: a write that names no access_lost_at at
  // all still gets a real now() instant rather than a null.
  const defaulted = runSql(
    `insert into app.retired_library_games (account_id, game_id, loss_reason) values (2, 8, 'manual');`,
  );
  assert.equal(defaulted.ok, true, defaulted.stderr);
  assert.equal(
    query(`select count(*) from app.retired_library_games where account_id = 2 and game_id = 8 and access_lost_at is not null;`),
    "1",
  );
  const clearedDefault = runSql(`delete from app.retired_library_games where account_id = 2 and game_id = 8;`);
  assert.equal(clearedDefault.ok, true, clearedDefault.stderr);
  // 'wishlist' is still not a loss_reason literal: origin and reason stay
  // separate columns by design.
  expectRejected(
    `insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason)
     values (2, 8, now(), 'wishlist');`,
    "23514",
  );
  // A future complete_snapshot-reason retirement is representable without a
  // legacy_ownership label at all, as long as it carries a real instant.
  const futureLoss = runSql(
    `insert into app.retired_library_games (account_id, game_id, access_lost_at, loss_reason, legacy_ownership)
     values (2, 8, '2026-03-01 00:00:00+00'::timestamptz, 'complete_snapshot', NULL);`,
  );
  assert.equal(futureLoss.ok, true, futureLoss.stderr);
});

test("app.library_legacy_measurements accepts the sparse exception rows", () => {
  assert.ok(library.library_legacy_measurements.length > 0);
  const values = library.library_legacy_measurements
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${num(entry.game_id)}, ${exact(entry.steam_app_id)}, ${text(entry.ownership_kind)},` +
        ` ${num(entry.observed_minutes_at_freeze)}, ${exact(entry.legacy_hours_played)}, ${text(entry.legacy_hours_played_raw)},` +
        ` ${exact(entry.legacy_completion_percentage)}, ${text(entry.legacy_completion_percentage_raw)},` +
        ` ${text(entry.legacy_date_added_raw)}, ${text(entry.discrepancy_kind)}, ${text(entry.conversion_formula)},` +
        ` ${text(entry.authorship)}, ${text(entry.authorship_evidence)}, ${sha(entry.source_snapshot_hash)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into app.library_legacy_measurements (account_id, game_id, steam_app_id, ownership_kind,
       observed_minutes_at_freeze, legacy_hours_played, legacy_hours_played_raw, legacy_completion_percentage,
       legacy_completion_percentage_raw, legacy_date_added_raw, discrepancy_kind, conversion_formula, authorship,
       authorship_evidence, source_snapshot_hash) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select count(*) from app.library_legacy_measurements where authorship <> 'unknown';`), "0");
  // The conversion formula fits the btrim(1..200) bound the column enforces.
  assert.equal(query(`select count(*) from app.library_legacy_measurements where conversion_formula is null;`), "0");
});

test("migration.legacy_library_evidence accepts every staged row and its JSONB payload", () => {
  const values = library.legacy_library_evidence
    .map(
      (entry) =>
        `(${text(entry.legacy_id)}, ${num(entry.account_id)}, ${exact(entry.steam_appid)}, ${exact(entry.legacy_hours_played)},` +
        ` ${text(entry.legacy_hours_played_raw)}, ${exact(entry.completion_percentage)}, ${text(entry.completion_percentage_raw)},` +
        ` ${text(entry.date_added_raw)}, ${instant(entry.created_at)}, ${instant(entry.source_updated_at)},` +
        ` ${bool(entry.reproducible_from_observed)}, ${text(entry.conversion_formula)}, ${sha(entry.source_snapshot_hash)},` +
        ` ${jsonb(entry.evidence)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into migration.legacy_library_evidence (legacy_id, account_id, steam_appid, legacy_hours_played,
       legacy_hours_played_raw, completion_percentage, completion_percentage_raw, date_added_raw, created_at,
       source_updated_at, reproducible_from_observed, conversion_formula, source_snapshot_hash, evidence)
     values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(
    query(`select count(*) from migration.legacy_library_evidence;`),
    String(library.legacy_library_evidence.length),
  );
  assert.equal(
    query(`select count(*) from migration.legacy_library_evidence where retention_class <> 'staging-30d-post-cutover';`),
    "0",
  );
  // The opaque date text stayed text and never became a date.
  assert.equal(query(`select count(*) from migration.legacy_library_evidence where date_added_raw = '03/09/2026';`), "1");
});

// --- stale state staging ---------------------------------------------------

test("migration.legacy_user_game_state_audit accepts the complete bounded copy", () => {
  const values = state.legacy_user_game_state_audit
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${text(entry.source_user_id)}, ${exact(entry.steam_appid)}, ${instant(entry.raw_completed_at)},` +
        ` ${num(entry.raw_prev_active_status)}, ${instant(entry.raw_dismissed_at)},` +
        ` ${exact(entry.raw_dismissed_playtime)}, ${instant(entry.raw_review_requested_at)}, ${instant(entry.raw_last_played_at)},` +
        ` ${instant(entry.raw_last_observed_at)}, ${num(entry.raw_recency_code)}, ${instant(entry.raw_recency_evidence_at)},` +
        ` ${text(entry.raw_family_owner_steam_id)}, ${instant(entry.raw_family_verified_at)}, ${sha(entry.source_snapshot_hash)},` +
        ` ${text(entry.retention_class)}, ${text(entry.evidence_disposition)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into migration.legacy_user_game_state_audit (account_id, source_user_id, steam_appid, raw_completed_at,
       raw_prev_active_status, raw_dismissed_at, raw_dismissed_playtime, raw_review_requested_at,
       raw_last_played_at, raw_last_observed_at, raw_recency_code, raw_recency_evidence_at, raw_family_owner_steam_id,
       raw_family_verified_at, source_snapshot_hash, retention_class, evidence_disposition) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  // The fractional baseline kept its source scale in an unconstrained numeric.
  assert.equal(
    query(`select raw_dismissed_playtime::text from migration.legacy_user_game_state_audit where raw_dismissed_playtime is not null;`),
    "60.5",
  );
});

test("app.game_state_legacy_measurements accepts only the promoted sparse rows", () => {
  assert.ok(state.game_state_legacy_measurements.length > 0);
  const values = state.game_state_legacy_measurements
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${exact(entry.steam_app_id)}, ${text(entry.source_user_id)}, ${instant(entry.raw_completed_at)},` +
        ` ${num(entry.raw_prev_active_status)}, ${instant(entry.raw_dismissed_at)},` +
        ` ${exact(entry.raw_dismissed_playtime)}, ${instant(entry.raw_review_requested_at)}, ${instant(entry.raw_last_played_at)},` +
        ` ${instant(entry.raw_last_observed_at)}, ${num(entry.raw_recency_code)}, ${instant(entry.raw_recency_evidence_at)},` +
        ` ${text(entry.raw_family_owner_steam_id)}, ${instant(entry.raw_family_verified_at)}, ${text(entry.evidence_reason)},` +
        ` ${sha(entry.source_snapshot_hash)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into app.game_state_legacy_measurements (account_id, steam_app_id, source_user_id, raw_completed_at,
       raw_prev_active_status, raw_dismissed_at, raw_dismissed_playtime, raw_review_requested_at,
       raw_last_played_at, raw_last_observed_at, raw_recency_code, raw_recency_evidence_at, raw_family_owner_steam_id,
       raw_family_verified_at, evidence_reason, source_snapshot_hash) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  // This relation has no catalogue foreign key at all, so it cannot become
  // runtime state authority by accident.
  assert.equal(
    query(`select count(*) from pg_constraint where conrelid = 'app.game_state_legacy_measurements'::regclass and contype = 'f' and confrelid = 'catalog.games'::regclass;`),
    "0",
  );
  // The stale microsecond disagreement is preserved next to the authoritative
  // value rather than overwriting it.
  assert.equal(
    query(`select to_char(raw_completed_at at time zone 'UTC', 'US') from app.game_state_legacy_measurements where raw_completed_at is not null;`),
    "000002",
  );
  assert.equal(
    query(`select to_char(completed_at at time zone 'UTC', 'US') from app.game_state where completed_at is not null;`),
    "000001",
  );
});

// --- family destinations ---------------------------------------------------

test("app.family_members accepts the lender row with every M3 column", () => {
  const values = family.family_members
    .map(
      (entry) =>
        `(${num(entry.id)}, ${num(entry.account_id)}, ${exact(entry.steam_id)}, ${jsonbArray(entry.candidate_app_ids)},` +
        ` ${num(entry.candidate_count)}, ${instant(entry.checked_at)}, ${text(entry.error_status)}, ${text(entry.legacy_member_id)},` +
        ` ${text(entry.display_name)}, ${text(entry.avatar_url)}, ${text(entry.profile_url)}, ${num(entry.legacy_library_seen)},` +
        ` ${num(entry.legacy_games_imported)}, ${instant(entry.last_synced_at)}, ${text(entry.last_error)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into app.family_members (id, account_id, steam_id, candidate_app_ids, candidate_count, checked_at,
       error_status, legacy_member_id, display_name, avatar_url, profile_url, legacy_library_seen,
       legacy_games_imported, last_synced_at, last_error) overriding system value values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select jsonb_array_length(candidate_app_ids)::text from app.family_members;`), "3");
  // Candidacy is not access: the candidate array holds three AppIDs while the
  // access relation holds only what a library row actually observed.
  assert.equal(query(`select candidate_app_ids::text from app.family_members;`), "[10, 220, 4294967295]");
  // The surrounding spaces are stored verbatim: only the target's btrim CHECK
  // is measured trimmed. `query` trims its own transport output, so the
  // comparison is made inside PostgreSQL.
  assert.equal(query(`select quote_literal(display_name) from app.family_members;`), "'  synthetic lender  '");
  assert.equal(query(`select length(display_name)::text from app.family_members;`), "20");
  assert.equal(query(`select length(btrim(display_name))::text from app.family_members;`), "16");
});

function jsonbArray(values: readonly number[]): string {
  return `${text(JSON.stringify(values))}::jsonb`;
}

test("app.family_game_access accepts resolved lender access and carries no playtime", () => {
  // Exactly one active grant: ROW_FAMILY. ROW_FAMILY_RETIRED's lender (the
  // same LENDER, still a resolvable app.family_members row) must not have
  // produced a second one despite resolving -- that is root's 11 September
  // fix for the bug the prior review's transform code still had.
  assert.equal(family.family_game_access.length, 1);
  assert.equal(family.family_game_access[0].game_id, 8);
  const values = family.family_game_access
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${num(entry.member_id)}, ${num(entry.game_id)}, ${instant(entry.observed_at)}, ${text(entry.provenance)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into app.family_game_access (account_id, member_id, game_id, observed_at, provenance) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  // There is no minutes column at all in this relation, which is why lender
  // playtime cannot become personal playtime through it.
  assert.equal(
    query(`select count(*) from information_schema.columns where table_schema='app' and table_name='family_game_access' and column_name like '%minute%';`),
    "0",
  );
  assert.equal(query(`select provenance from app.family_game_access;`), "verified");
});

test("app.family_access_orphans accepts both quarantine and retired evidence, neither confers access", () => {
  // Two distinct populations: ORPHAN_ACCESS's unresolvable lender
  // (disposition='quarantine') and ROW_FAMILY_RETIRED's resolvable-but-revoked
  // lender (disposition='retired', the proposal's new literal).
  assert.equal(family.family_access_orphans.length, 2);
  const byDisposition = new Map(family.family_access_orphans.map((entry) => [entry.disposition, entry]));
  assert.ok(byDisposition.has("quarantine"));
  assert.ok(byDisposition.has("retired"));
  const retired = byDisposition.get("retired")!;
  // The retired row's lender DOES resolve to LENDER -- proving this is not
  // the "lender unknown" case the pre-existing 'quarantine' disposition means.
  assert.equal(retired.lender_steam_id, LENDER);
  assert.equal(retired.game_id, 10);

  const values = family.family_access_orphans
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${num(entry.game_id)}, ${exact(entry.steam_app_id)}, ${exact(entry.lender_steam_id)},
       ${instant(entry.observed_at)}, ${text(entry.disposition)}, ${bool(entry.confers_access)}, ${sha(entry.source_snapshot_hash)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into app.family_access_orphans (account_id, game_id, steam_app_id, lender_steam_id, observed_at, disposition, confers_access, source_snapshot_hash) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select count(*) from app.family_access_orphans where confers_access;`), "0");
  assert.equal(query(`select count(*) from app.family_access_orphans where disposition = 'retired';`), "1");

  // Even with a resolvable lender identity, no app.family_game_access row
  // exists for the retired game -- the actual regression this domain needed.
  assert.equal(query(`select count(*) from app.family_game_access where game_id = 10;`), "0");

  // The quarantine orphan's lender has no member row at all, and the access
  // relation's composite foreign key is what makes fabricating one impossible.
  const quarantine = byDisposition.get("quarantine")!;
  expectRejected(
    `insert into app.family_game_access (account_id, member_id, game_id, observed_at, provenance)
     values (${num(quarantine.account_id)}, 999, ${num(quarantine.game_id)}, now(), 'inferred');`,
    "23503",
  );
  // `confers_access` cannot be flipped to true by any later writer, for
  // either disposition.
  expectRejected(`update app.family_access_orphans set confers_access = true;`, "23514");
  // An out-of-set disposition literal is still refused.
  expectRejected(
    `insert into app.family_access_orphans (account_id, game_id, steam_app_id, disposition, confers_access, source_snapshot_hash)
     values (1, 7, 10, 'not_a_real_disposition', false, ${sha(retired.source_snapshot_hash)});`,
    "23514",
  );
});

test("migration.legacy_family_* staging accepts both evidence payloads", () => {
  const memberValues = family.legacy_family_member_evidence
    .map(
      (entry) =>
        `(${text(entry.legacy_member_id)}, ${num(entry.account_id)}, ${exact(entry.steam_id)}, ${instant(entry.created_at)},` +
        ` ${text(entry.raw_last_error)}, ${num(entry.raw_library_seen)}, ${num(entry.raw_games_imported)},` +
        ` ${sha(entry.source_snapshot_hash)}, ${text(entry.retention_class)}, ${jsonb(entry.evidence)})`,
    )
    .join(",\n");
  const members = runSql(
    `insert into migration.legacy_family_member_evidence (legacy_member_id, account_id, steam_id, created_at,
       raw_last_error, raw_library_seen, raw_games_imported, source_snapshot_hash, retention_class, evidence)
     values\n${memberValues};`,
  );
  assert.equal(members.ok, true, members.stderr);

  const orphanValues = family.legacy_family_access_orphans
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${text(entry.source_user_id)}, ${text(entry.source_member_id)}, ${exact(entry.source_steam_id)},` +
        ` ${exact(entry.steam_appid)}, ${instant(entry.observed_at)}, ${num(entry.raw_games_imported)}, ${text(entry.disposition)},` +
        ` ${sha(entry.source_snapshot_hash)}, ${jsonb(entry.evidence)})`,
    )
    .join(",\n");
  const orphans = runSql(
    `insert into migration.legacy_family_access_orphans (account_id, source_user_id, source_member_id, source_steam_id,
       steam_appid, observed_at, raw_games_imported, disposition, source_snapshot_hash, evidence) values\n${orphanValues};`,
  );
  assert.equal(orphans.ok, true, orphans.stderr);
  assert.equal(
    query(`select count(*) from migration.legacy_family_access_orphans;`),
    String(family.legacy_family_access_orphans.length),
  );
});

// --- history destinations --------------------------------------------------

test("app.playtime_daily accepts cumulative totals including a decreasing series", () => {
  const values = history.playtime_daily
    .map(
      (entry) =>
        `(${num(entry.account_id)}, ${day(entry.activity_day)}, ${exact(entry.observed_minutes)}, ${text(entry.coverage)},` +
        ` ${instant(entry.recorded_at)}, ${text(entry.observed_minutes_semantic)}, ${num(entry.games_with_playtime)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into app.playtime_daily (account_id, activity_day, observed_minutes, coverage, recorded_at,
       observed_minutes_semantic, games_with_playtime) values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  // The bigint boundary survived without a double.
  assert.equal(query(`select max(observed_minutes)::text from app.playtime_daily;`), "9223372036854775807");
  // The decrease is preserved, not repaired: day 2 is lower than day 1.
  assert.equal(
    query(`select string_agg(observed_minutes::text, ',' order by activity_day) from app.playtime_daily where account_id = 1;`),
    "1000,900",
  );
  assert.equal(query(`select count(distinct observed_minutes_semantic) from app.playtime_daily;`), "1");
});

test("app.completion_events accepts the resolved event with its full legacy identity", () => {
  assert.equal(history.completion_events.length, 1);
  const entry = history.completion_events[0];
  const result = runSql(
    `insert into app.completion_events (account_id, game_id, occurred_at, undone_at, source, dedupe_key,
       legacy_event_id, origin_surface, legacy_game_id, legacy_steam_appid, legacy_hours_played,
       legacy_hours_played_raw, legacy_estimate_minutes, legacy_price_cents, metric_provenance)
     values (${num(entry.account_id)}, ${num(entry.game_id)}, ${instant(entry.occurred_at)}, ${instant(entry.undone_at)},
       ${text(entry.source)}, ${text(entry.dedupe_key)}, ${text(entry.legacy_event_id)}, ${text(entry.origin_surface)},
       ${text(entry.legacy_game_id)}, ${exact(entry.legacy_steam_appid)}, ${exact(entry.legacy_hours_played)},
       ${text(entry.legacy_hours_played_raw)}, ${num(entry.legacy_estimate_minutes)}, ${num(entry.legacy_price_cents)},
       ${jsonb(entry.metric_provenance)});`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select source from app.completion_events;`), "user");
  assert.equal(query(`select origin_surface from app.completion_events;`), "sweep");
  assert.equal(query(`select legacy_hours_played::text from app.completion_events;`), "1.500000000000");

  // PHYSICAL GAP: both completion destinations require undone_at >= occurred_at.
  expectRejected(
    `insert into app.completion_events (account_id, game_id, occurred_at, undone_at, source)
     values (1, 7, '2026-02-02 00:00:00+00'::timestamptz, '2026-02-01 00:00:00+00'::timestamptz, 'user');`,
    "23514",
  );
});

test("app.unknown_completion_history keeps an event with no catalogue identity", () => {
  assert.equal(history.unknown_completion_history.length, 1);
  const entry = history.unknown_completion_history[0];
  assert.equal(entry.source_game_id, null);
  assert.equal(entry.source_steam_appid, null);
  assert.equal(entry.legacy_hours_played, null);
  assert.equal(entry.legacy_hours_played_raw, "Infinity");
  const result = runSql(
    `insert into app.unknown_completion_history (legacy_event_id, account_id, source_game_id, source_steam_appid,
       actor, origin_surface, occurred_at, undone_at, state, legacy_hours_played, legacy_hours_played_raw,
       legacy_estimate_minutes, legacy_price_cents, metric_provenance, source_snapshot_hash)
     values (${text(entry.legacy_event_id)}, ${num(entry.account_id)}, ${text(entry.source_game_id)},
       ${exact(entry.source_steam_appid)}, ${text(entry.actor)}, ${text(entry.origin_surface)}, ${instant(entry.occurred_at)},
       ${instant(entry.undone_at)}, ${text(entry.state)}, ${exact(entry.legacy_hours_played)},
       ${text(entry.legacy_hours_played_raw)}, ${num(entry.legacy_estimate_minutes)}, ${num(entry.legacy_price_cents)},
       ${jsonb(entry.metric_provenance)}, ${sha(entry.source_snapshot_hash)});`,
  );
  assert.equal(result.ok, true, result.stderr);
  // The non-finite measurement stayed exact text and never became a number.
  assert.equal(query(`select legacy_hours_played_raw from app.unknown_completion_history;`), "Infinity");
  assert.equal(query(`select count(*) from app.unknown_completion_history where legacy_hours_played is not null;`), "0");
  // No catalogue row was invented for it.
  assert.equal(query(`select count(*) from catalog.games;`), "5");
});

test("app.completion_event_registry holds one row per event and no duplicate identity", () => {
  assert.equal(history.completion_event_registry.length, 2);
  const resolvedId = query(`select id::text from app.completion_events limit 1;`);
  const unknownId = query(`select id::text from app.unknown_completion_history limit 1;`);
  const statements = history.completion_event_registry.map((entry) => {
    const resolved = entry.record_kind === "resolved" ? resolvedId : "NULL";
    const unknown = entry.record_kind === "unknown" ? unknownId : "NULL";
    return `insert into app.completion_event_registry (legacy_event_id, account_id, record_kind, resolved_event_id, unknown_history_id, source_snapshot_hash)
       values (${text(entry.legacy_event_id)}, ${num(entry.account_id)}, ${text(entry.record_kind)}, ${resolved}, ${unknown}, ${sha(entry.source_snapshot_hash)});`;
  });
  const result = runSql(statements.join("\n"));
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select count(*) from app.completion_event_registry;`), "2");
  // The registry is the cross-relation identity gate: one legacy event cannot
  // appear in both histories.
  expectRejected(
    `insert into app.completion_event_registry (legacy_event_id, account_id, record_kind, unknown_history_id)
     values (${text(history.completion_event_registry[0].legacy_event_id)}, 1, 'unknown', ${unknownId});`,
    "23505",
  );
});

test("an inverted completion clock is withheld into a segregated exception, counted exactly once, never loaded or registered", () => {
  assert.equal(history.completion_ordering_exceptions.length, 1);
  const exception = history.completion_ordering_exceptions[0];
  assert.equal(exception.legacy_event_id, EVENT_INVERTED);
  assert.equal(exception.occurred_at.canonicalUtc, "2026-02-05T00:00:00.000000Z");
  assert.equal(exception.undone_at.canonicalUtc, "2026-02-01T00:00:00.000000Z");

  // Exactly once across loadable and exception paths: three source events in
  // COMPLETIONS, three total across completion_events + unknown_completion_history
  // + completion_ordering_exceptions, and it never touches the registry.
  const total =
    history.completion_events.length + history.unknown_completion_history.length + history.completion_ordering_exceptions.length;
  assert.equal(total, 3);
  assert.equal(
    history.completion_event_registry.every((entry) => entry.legacy_event_id !== EVENT_INVERTED),
    true,
  );

  // Regression guard: the real target CHECK this domain now depends on
  // staying enforced (never relaxed for a zero-observed case) still refuses
  // the row directly, on both destinations.
  expectRejected(
    `insert into app.completion_events (account_id, game_id, occurred_at, undone_at, source)
     values (1, 8, '2026-02-05 00:00:00+00'::timestamptz, '2026-02-01 00:00:00+00'::timestamptz, 'user');`,
    "23514",
  );
  expectRejected(
    `insert into app.unknown_completion_history (legacy_event_id, account_id, actor, origin_surface, occurred_at, undone_at, state)
     values (gen_random_uuid(), 1, 'user', 'library', '2026-02-05 00:00:00+00'::timestamptz, '2026-02-01 00:00:00+00'::timestamptz, 'undone');`,
    "23514",
  );
});

test("purge review history and its archive accept the authored decision", () => {
  assert.equal(history.purge_review_history.length, 1);
  const entry = history.purge_review_history[0];
  const durable = runSql(
    `insert into app.purge_review_history (account_id, game_id, steam_app_id, action, reviewed_at,
       playtime_minutes_at_review, progress_at_review, last_played_at_review, source_snapshot_hash)
     values (${num(entry.account_id)}, ${num(entry.game_id)}, ${exact(entry.steam_app_id)}, ${text(entry.action)},
       ${instant(entry.reviewed_at)}, ${num(entry.playtime_minutes_at_review)}, ${num(entry.progress_at_review)},
       ${instant(entry.last_played_at_review)}, ${sha(entry.source_snapshot_hash)});`,
  );
  assert.equal(durable.ok, true, durable.stderr);

  const archived = history.legacy_purge_review_archive[0];
  const archive = runSql(
    `insert into migration.legacy_purge_review_archive (legacy_id, account_id, source_game_id, action, reviewed_at,
       playtime_minutes_at_review, progress_at_review, last_played_at_review, source_snapshot_hash, retention_class)
     values (${text(archived.legacy_id)}, ${num(archived.account_id)}, ${text(archived.source_game_id)}, ${text(archived.action)},
       ${instant(archived.reviewed_at)}, ${num(archived.playtime_minutes_at_review)}, ${num(archived.progress_at_review)},
       ${instant(archived.last_played_at_review)}, ${sha(archived.source_snapshot_hash)}, ${text(archived.retention_class)});`,
  );
  assert.equal(archive.ok, true, archive.stderr);
  // An action='complete' review generated no completion event: the only
  // completion rows are the two source events.
  assert.equal(query(`select count(*) from app.completion_events;`), "1");
  assert.equal(query(`select count(*) from app.unknown_completion_history;`), "1");
  assert.equal(query(`select action from app.purge_review_history;`), "complete");
});

// --- conflict report and the JSONB bound ----------------------------------

test("every conflict record fits migration.conflict_report", () => {
  const conflicts = [...library.conflicts, ...state.conflicts, ...family.conflicts, ...history.conflicts];
  assert.ok(conflicts.length > 0);
  // migration.conflict_report is keyed on (run_id, conflict_class,
  // source_relation, source_column) ACROSS the whole run, while each transform
  // collects counts only within itself. The loader therefore has to aggregate
  // the four domains' reports before insert; this fixture proves that the four
  // sets are disjoint on that key today, so nothing is silently merged.
  const byKey = new Map<string, number>();
  for (const entry of conflicts) {
    const key = `${entry.conflict_class}::${entry.source_relation}::${entry.source_column}`;
    byKey.set(key, (byKey.get(key) ?? 0) + entry.conflict_count);
  }
  assert.equal(byKey.size, conflicts.length, "two domains share a conflict_report primary key");

  const runId = query(
    `insert into migration.runs (snapshot_key, started_at, source_snapshot_hash, status)
     values ('m3-library-constraints', now(), ${sha(SNAPSHOT)}, 'running') returning run_id::text;`,
  );
  const values = conflicts
    .map(
      (entry) =>
        `(${text(runId)}, ${text(entry.conflict_class)}, ${text(entry.source_relation)}, ${text(entry.source_column)},` +
        ` ${num(entry.conflict_count)}, ${text(entry.decision)}, ${jsonb(entry.details)})`,
    )
    .join(",\n");
  const result = runSql(
    `insert into migration.conflict_report (run_id, conflict_class, source_relation, source_column, conflict_count, decision, details)
     values\n${values};`,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(query(`select count(*) from migration.conflict_report;`), String(conflicts.length));
  // Exception accounting: every withheld row is visible to a pre-commit gate
  // reading only this durable, redacted table, and every one of them is
  // unresolved (blocking) rather than reported as settled.
  const withheld =
    library.recency_exceptions.length + history.completion_ordering_exceptions.length;
  assert.ok(withheld > 0, "the fixture must exercise both exception streams");
  assert.equal(
    query(
      `select coalesce(sum(conflict_count), 0)::text from migration.conflict_report
        where details->>'destination' in ('recency_exceptions', 'completion_ordering_exceptions');`,
    ),
    String(withheld),
  );
  assert.equal(
    query(
      `select count(*) from migration.conflict_report
        where details->>'destination' in ('recency_exceptions', 'completion_ordering_exceptions')
          and details->>'status' <> 'unresolved';`,
    ),
    "0",
  );
  // No conflict record carries a private value: the decision text is prose and
  // the counts are integers, with no UUID or Steam identity anywhere.
  assert.equal(
    query(`select count(*) from migration.conflict_report where decision ~ '[0-9a-f]{8}-[0-9a-f]{4}-' or decision ~ '\\m7656[0-9]{13}\\M';`),
    "0",
  );
});

test("fitsNumeric agrees with PostgreSQL numeric(30,12) on the boundary", () => {
  // The transform decides whether a legacy hours value reaches
  // numeric(30, 12) without rounding. That decision has to be the same one
  // PostgreSQL makes, so it is checked against the real type rather than
  // against this code's reading of the manual.
  const samples = [
    "0",
    "0.000000000001",
    "1.000000000001",
    "1.0000000000001",
    "35791394.1",
    "999999999999999999.999999999999",
    "1000000000000000000",
    "1000000000000000000.5",
    "0.0000000000001",
  ];
  for (const sample of samples) {
    const parsed = parsePgDecimalForSample(sample);
    const claimed = fitsNumeric(parsed, 30, 12);
    const rendered = runSql(`select ${sample}::numeric(30,12)::text;`);
    if (!claimed) {
      // PostgreSQL must either refuse the value or change it. Either way the
      // transform was right not to write it into that column.
      if (rendered.ok) {
        const stored = query(`select ${sample}::numeric(30,12)::text;`);
        assert.notEqual(
          Number(stored) === Number(sample) && stripTrailingZeros(stored) === stripTrailingZeros(sample),
          true,
          `${sample} was claimed unrepresentable but round-tripped unchanged`,
        );
      }
      continue;
    }
    assert.equal(rendered.ok, true, `${sample} was claimed representable but PostgreSQL refused it: ${rendered.stderr}`);
    const stored = query(`select ${sample}::numeric(30,12)::text;`);
    assert.equal(
      stripTrailingZeros(stored),
      stripTrailingZeros(sample),
      `${sample} was claimed representable but PostgreSQL changed it to ${stored}`,
    );
  }
});

function stripTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

function parsePgDecimalForSample(value: string): Parameters<typeof fitsNumeric>[0] {
  const parsed = parsePgDecimal(value, { field: "sample" });
  assert.ok(parsed !== null);
  return parsed;
}

test("jsonbUpperBoundBytes is a real upper bound for pg_column_size", () => {
  const payloads: readonly Readonly<Record<string, string | number | boolean>>[] = [
    {},
    { a: "" },
    { flag: true, other: false },
    { count: 0, big: 2147483647, huge: 9007199254740991 },
    { small: 1e-308, large: 1.7976931348623157e308, negative: -1234567890.123456 },
    { unicode: "あ".repeat(1_000), ascii: "n".repeat(1_000) },
    ...library.legacy_library_evidence.map((entry) => entry.evidence),
    ...family.legacy_family_member_evidence.map((entry) => entry.evidence),
    ...family.legacy_family_access_orphans.map((entry) => entry.evidence),
    ...history.completion_events.map((entry) => entry.metric_provenance),
    ...history.unknown_completion_history.map((entry) => entry.metric_provenance),
  ];
  const rows = payloads
    .map((payload, index) => `(${index}, ${jsonb(payload)}, ${num(jsonbUpperBoundBytes(payload))})`)
    .join(",\n");
  const violations = query(
    `with sample (id, payload, claimed) as (values\n${rows}\n)
     select count(*) from sample where pg_column_size(payload) > claimed;`,
  );
  assert.equal(violations, "0");
  // The bound is also not absurdly loose for a realistic payload.
  const worst = query(
    `with sample (id, payload, claimed) as (values\n${rows}\n)
     select max(claimed::numeric / greatest(pg_column_size(payload), 1))::numeric(10,2)::text from sample;`,
  );
  assert.ok(Number(worst) < 40, `bound ratio ${worst} is looser than expected`);
});

/**
 * Every relation this domain writes, with one non-generated column that a
 * no-op UPDATE can touch. A no-op UPDATE re-runs the row's CHECK constraints
 * and its triggers, so it re-validates loaded rows against constraints that no
 * INSERT above happened to exercise.
 */
const WRITTEN_RELATIONS: readonly (readonly [string, string])[] = Object.freeze([
  ["app.library_games", "account_id"],
  ["app.game_state", "account_id"],
  ["app.game_activity", "account_id"],
  ["app.retired_library_games", "account_id"],
  ["app.playtime_daily", "account_id"],
  ["app.family_members", "account_id"],
  ["app.family_game_access", "account_id"],
  ["app.family_access_orphans", "account_id"],
  ["app.completion_events", "account_id"],
  ["app.unknown_completion_history", "account_id"],
  ["app.completion_event_registry", "account_id"],
  ["app.library_legacy_measurements", "account_id"],
  ["app.game_state_legacy_measurements", "account_id"],
  ["app.purge_review_history", "account_id"],
  ["migration.library_row_map", "account_id"],
  ["migration.legacy_library_evidence", "account_id"],
  ["migration.legacy_user_game_state_audit", "account_id"],
  ["migration.legacy_family_member_evidence", "account_id"],
  ["migration.legacy_family_access_orphans", "account_id"],
  ["migration.legacy_purge_review_archive", "account_id"],
  ["migration.conflict_report", "conflict_count"],
]);

test("every relation this domain writes received rows and revalidates cleanly", () => {
  for (const [relation] of WRITTEN_RELATIONS) {
    const count = Number(query(`select count(*) from ${relation};`));
    assert.ok(count > 0, `${relation} received no synthetic row`);
  }
  // A no-op UPDATE re-fires row CHECK constraints and triggers on the loaded
  // data, so a constraint the INSERTs above did not exercise is still proved.
  const result = runSql(
    ["begin;", ...WRITTEN_RELATIONS.map(([relation, column]) => `update ${relation} set ${column} = ${column};`), "commit;"].join(
      "\n",
    ),
  );
  assert.equal(result.ok, true, result.stderr);
});

test("deleting the account removes every personal row and leaves no orphan evidence", () => {
  // The retention/deletion contract is that account-domain evidence dies with
  // the account while catalogue identity survives. This proves the rows this
  // transform produces are actually reachable by that cascade.
  const before = Number(query(`select count(*) from app.family_access_orphans;`));
  assert.ok(before > 0);
  // The two facts this proposal newly stores are personal data on already
  // registered relations, so they must be inside the same cascade rather than
  // needing a registry change. Prove they are actually present first.
  assert.ok(
    Number(query(`select count(*) from app.game_activity where legacy_last_played_at is not null;`)) > 0,
    "the fixture must store a divergent raw play fact before deletion",
  );
  assert.ok(
    Number(query(`select count(*) from app.retired_library_games where legacy_ownership is not null;`)) > 0,
    "the fixture must store a legacy ownership label before deletion",
  );
  const result = runSql(`delete from app.accounts where id in (1, 2);`);
  assert.equal(result.ok, true, result.stderr);
  for (const [relation] of WRITTEN_RELATIONS) {
    if (relation === "migration.conflict_report") continue;
    assert.equal(Number(query(`select count(*) from ${relation};`)), 0, `${relation} kept a row after account deletion`);
  }
  // Catalogue identity is shared and must not be deleted with an account.
  assert.equal(query(`select count(*) from catalog.games;`), "5");
  // The conflict report is run metadata, not personal data, and survives.
  assert.ok(Number(query(`select count(*) from migration.conflict_report;`)) > 0);
});
