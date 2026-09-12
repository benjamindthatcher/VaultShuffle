import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildGameMap } from "./games.ts";
import { transformRecoConfigBatch } from "./reco-config.ts";
import { transformSupportOpsBatch } from "./support-ops.ts";
import { transformLegacyOperationsBatch } from "./legacy-operations.ts";
import type { PgTimestamp } from "./scalars.ts";
import type { AccountMapTargetRecord } from "./accounts.ts";

/**
 * Physical acceptance for the remaining M3 domains (reco/config, support,
 * legacy operations) against a real PostgreSQL 17 cluster with M1, M2 and M3
 * replayed.
 *
 * Deliberately NOT named `*.test.ts`: it needs a disposable local cluster and
 * is invoked explicitly. It contains only synthetic rows -- no real account,
 * email address, message or digest -- performs no remote call, and writes only
 * to the disposable database its own environment variables name.
 *
 * It proves three things the unit suite cannot:
 *
 * 1. the typed records these transforms return satisfy the ACTUAL applied
 *    constraints, including the identity/FK relationships between
 *    `reco.warm_start_snapshots` and its children and between the support
 *    relations and their retention policy;
 * 2. the exactness claims survive a real round trip -- decimal text into
 *    `numeric(30, 12)`, JSON into `jsonb`, microsecond instants into
 *    `timestamptz`;
 * 3. deletion and privacy behave as the contract says: an account delete
 *    reaches every personal row, catalogue/operational evidence without an
 *    account key survives, and nothing quarantined as secret-like is present
 *    in a durable runtime document.
 *
 *   VS_M3R_PGHOST=/tmp/vs-m3-batches-20260912 \
 *   VS_M3R_PGPORT=55496 \
 *   VS_M3R_PGUSER=vsm3 \
 *   VS_M3R_PGDATABASE=vs_remaining \
 *   VS_M3R_PSQL=node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
 *   node --experimental-strip-types --test \
 *     lib/v2/migration/transform/remaining-constraints.integration.ts
 */

const PSQL = process.env.VS_M3R_PSQL ?? "psql";
const PGHOST = process.env.VS_M3R_PGHOST ?? "/tmp/vs-m3-remaining-20260912";
const PGPORT = process.env.VS_M3R_PGPORT ?? "55496";
const PGUSER = process.env.VS_M3R_PGUSER ?? "vsm3";
const PGDATABASE = process.env.VS_M3R_PGDATABASE ?? "vs_remaining";

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

function expectRejected(sql: string, sqlState: string): string {
  const result = runSql(`\\set VERBOSITY verbose\n${sql}`);
  assert.equal(result.ok, false, "expected PostgreSQL to refuse the statement, but it succeeded");
  assert.ok(
    result.stderr.includes(`SQLSTATE: ${sqlState}`) || result.stderr.includes(sqlState),
    `expected SQLSTATE ${sqlState}, got: ${result.stderr}`,
  );
  return result.stderr;
}

function text(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function num(value: number | null): string {
  if (value === null) return "NULL";
  assert.ok(Number.isFinite(value));
  return String(value);
}

/** Exact decimal text goes to PostgreSQL as a numeric literal, never a float. */
function exact(value: string | null): string {
  if (value === null) return "NULL";
  assert.match(value, /^-?\d+(?:\.\d+)?$/);
  return value;
}

function instant(value: PgTimestamp | null): string {
  if (value === null) return "NULL";
  return `'${value.canonicalUtc}'::timestamptz`;
}

function jsonb(value: { text: string } | null): string {
  if (value === null) return "NULL";
  return `${text(value.text)}::jsonb`;
}

function sha(value: string): string {
  assert.match(value, /^[0-9a-f]{64}$/);
  return `decode('${value}', 'hex')`;
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

// --- fixture ---------------------------------------------------------------

const SNAPSHOT = "f1".repeat(32);
const RUN = Object.freeze({ runId: "m3-remaining-constraints", snapshotHash: SNAPSHOT });
const ACCOUNT_A = "a1000000-0000-4000-8000-00000000000a";
const ACCOUNT_B = "a1000000-0000-4000-8000-00000000000b";
const DIGEST = "9".repeat(64);
const STEAM_ID = "76561198000000042";

const ACCOUNT_MAP: readonly AccountMapTargetRecord[] = Object.freeze([
  { legacy_id: ACCOUNT_A, account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
  { legacy_id: ACCOUNT_B, account_id: 2, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT },
]);

const GAME_MAP = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }] }).map;

const reco = transformRecoConfigBatch({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  gameMap: GAME_MAP,
  warmStart: {
    snapshot_key: "legacy-reco-warm-start",
    snapshot_version: "1",
    frozen_at: "2026-09-11 00:00:00+00",
    source_project_ref: "synthetic-source",
    source_captured_at: "2026-09-09 00:29:20.000123+00",
  },
  operatorConfig: { config_version: "legacy-import", effective_at: "2026-09-11 00:00:00+00" },
  userGenrePreferences: [
    {
      user_id: ACCOUNT_A,
      genre: "Action",
      context_mood: "chill",
      positive: "3",
      total: "7.500000000001",
      updated_at: "2026-08-01 12:00:00.000123+00",
    },
  ],
  genrePreferenceGlobals: [
    { genre: "Action", context_mood: "any", positive: "10", total: "40", updated_at: "2026-08-01 00:00:00+00" },
  ],
  gamePreferenceGlobals: [
    { steam_appid: "440", positive: "5", total: "9", total_hours: "12.25", updated_at: "2026-08-01 00:00:00+00" },
    // An app the catalogue never held: the AppID survives with a NULL game_id.
    { steam_appid: "999999", positive: "1", total: "1", total_hours: "0", updated_at: "2026-08-01 00:00:00+00" },
  ],
  algorithmWeights: [
    { key: "genre_affinity", positive: "12", total: "20", note: "hand tuned", updated_at: "2026-07-01 00:00:00+00" },
  ],
  appSettings: [
    {
      id: "b1000000-0000-4000-8000-000000000001",
      user_id: ACCOUNT_A,
      key: "theme",
      value: "dark",
      created_at: "2026-01-01 00:00:00+00",
      updated_at: "2026-02-01 00:00:00+00",
    },
    {
      // Quarantined: a credential-shaped key must never reach the durable,
      // exported preference document.
      id: "b1000000-0000-4000-8000-000000000002",
      user_id: ACCOUNT_A,
      key: "steam_api_key",
      value: "SYNTHETIC-NOT-A-REAL-KEY",
      created_at: "2026-01-01 00:00:00+00",
      updated_at: "2026-02-01 00:00:00+00",
    },
  ],
});

const support = transformSupportOpsBatch({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  contactMessages: [
    {
      id: "c1000000-0000-4000-8000-000000000001",
      user_id: ACCOUNT_A,
      enquiry_type: "2",
      email: "synthetic@example.test",
      subject: "  A subject line  ",
      message: "  A synthetic support message long enough to pass the bound.  ",
      dedupe_hash: DIGEST,
      status: "0",
      created_at: "2026-05-01 10:00:00.000456+00",
      updated_at: "2026-05-02 10:00:00+00",
    },
  ],
  feedbackSubmissions: [
    {
      id: "c1000000-0000-4000-8000-000000000002",
      user_id: null,
      feedback_type: "1",
      message: "A synthetic anonymous feedback message, long enough.",
      contact_allowed: "f",
      contact_email: null,
      route: "/vault",
      app_area: "vault",
      client_context: '{"viewport":"390x844"}',
      dedupe_hash: null,
      status: "0",
      created_at: "2026-06-01 09:00:00+00",
    },
  ],
});

const operations = transformLegacyOperationsBatch({
  runIdentity: RUN,
  accountMap: ACCOUNT_MAP,
  workerRuns: [
    {
      id: "d1000000-0000-4000-8000-000000000001",
      worker_name: "nightly-metadata",
      status: "failed",
      started_at: "2026-09-01 02:00:00+00",
      finished_at: "2026-09-01 02:05:00+00",
      duration_ms: "300000",
      counts: '{"fetched":120}',
      summary: '{"note":"provider 500"}',
      error_message: "provider returned 500",
    },
  ],
  importJobs: [
    {
      user_id: ACCOUNT_B,
      status: "importing",
      total_games: "120",
      imported_games: "40",
      games: '[{"appid":440}]',
      play_history_missing: "t",
      last_error: null,
      started_at: "2026-09-01 00:00:00+00",
      updated_at: "2026-09-01 00:10:00+00",
      completed_at: null,
      processing_token: "e1000000-0000-4000-8000-000000000001",
      processing_started_at: "2026-09-01 00:09:00+00",
    },
  ],
  rateLimits: [
    {
      bucket: "contact_form",
      key_hash: DIGEST,
      window_started_at: "2026-09-10 12:00:00+00",
      request_count: "4",
      updated_at: "2026-09-10 12:30:00+00",
    },
  ],
  cutover: { observed_at: "2026-09-11 00:00:00+00", algorithm_version: "legacy-fixed-window", window_seconds: 3600 },
  accountMerges: [
    {
      id: "f1000000-0000-4000-8000-000000000001",
      source_account_id: ACCOUNT_A,
      target_account_id: ACCOUNT_B,
      verified_steam_id: STEAM_ID,
      merge_mode: "merged_existing",
      created_at: "2026-07-01 00:00:00+00",
      analytics_delivered_at: null,
    },
  ],
  mergeTombstones: [{ legacy_merge_id: "f1000000-0000-4000-8000-000000000001", source_tombstone_present: true }],
  securityIntents: [
    {
      id: "f1000000-0000-4000-8000-000000000002",
      source_account_id: ACCOUNT_A,
      source_manual_session_id: "f1000000-0000-4000-8000-000000000003",
      token_hash: DIGEST,
      created_at: "2026-08-01 00:00:00+00",
      expires_at: "2026-08-01 00:10:00+00",
      consumed_at: "2026-08-01 00:05:00+00",
      target_account_id: ACCOUNT_B,
      verified_steam_id: STEAM_ID,
      openid_response_nonce: "synthetic-nonce",
      outcome: "merged_existing",
    },
  ],
});

let snapshotId = 0;

test("cluster sanity: the remaining-domain relations exist", () => {
  const count = query(`
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('reco','support','ops','migration') and c.relname in (
      'warm_start_snapshots','user_genre_preferences','genre_preference_globals','game_preference_globals',
      'operator_weight_versions','contact_messages','feedback_submissions','retention_policy_decisions',
      'legacy_worker_runs','abuse_cooldowns','account_merges','account_aliases',
      'legacy_import_freeze_report','legacy_account_preferences_evidence','legacy_account_merge_audit',
      'legacy_auth_intent_audit'
    );
  `);
  assert.equal(Number(count), 16);

  // The gate owns this disposable database and starts from a known-empty
  // state, so a re-run after a failed run is not a false negative.
  query(
    [
      "begin;",
      "truncate app.accounts cascade;",
      "truncate catalog.games cascade;",
      "truncate reco.warm_start_snapshots cascade;",
      "truncate reco.genre_preference_globals cascade;",
      "truncate reco.operator_weight_versions cascade;",
      "truncate support.feedback_submissions cascade;",
      "truncate support.retention_policy_decisions cascade;",
      "truncate ops.legacy_worker_runs cascade;",
      "truncate ops.abuse_cooldowns cascade;",
      "commit;",
    ].join("\n"),
  );
  query(`insert into app.accounts (id, account_kind) overriding system value values (1, 'steam'), (2, 'steam');`);
  query(`insert into catalog.games (id, steam_app_id, title, normalized_sort_title)
    overriding system value values (1, 440, 'Synthetic', 'synthetic');`);
});

test("reco.warm_start_snapshots accepts the supplied frozen snapshot and stamps its own id", () => {
  const snapshot = reco.warm_start_snapshot;
  snapshotId = Number(
    query(`insert into reco.warm_start_snapshots
      (snapshot_key, source_project_ref, source_captured_at, snapshot_version, status, frozen_at)
      values (${text(snapshot.snapshot_key)}, ${text(snapshot.source_project_ref)},
        ${instant(snapshot.source_captured_at)}, ${snapshot.snapshot_version}, ${text(snapshot.status)},
        ${instant(snapshot.frozen_at)}) returning id;`),
  );
  assert.ok(snapshotId > 0);
  // The supplied capture instant kept its microseconds through the round trip.
  assert.equal(
    query(`select to_char(source_captured_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from reco.warm_start_snapshots;`),
    "2026-09-09 00:29:20.000123",
  );
});

test("reco preference rows load under the generated snapshot id with exact decimal text", () => {
  const user = reco.user_genre_preferences[0];
  query(`insert into reco.user_genre_preferences
    (snapshot_id, account_id, source_user_id, genre, mood, positive, total, source_updated_at, source_snapshot_hash)
    values (${snapshotId}, ${user.account_id}, ${text(user.source_user_id)}::uuid, ${text(user.genre)},
      ${text(user.mood)}, ${exact(user.positive)}, ${exact(user.total)}, ${instant(user.source_updated_at)},
      ${sha(user.source_snapshot_hash)});`);
  // numeric(30,12) keeps every digit the transform claimed it could.
  assert.equal(query(`select total::text from reco.user_genre_preferences;`), "7.500000000001");
  assert.equal(
    query(`select to_char(source_updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from reco.user_genre_preferences;`),
    "2026-08-01 12:00:00.000123",
  );

  const genre = reco.genre_preference_globals[0];
  query(`insert into reco.genre_preference_globals
    (snapshot_id, genre, mood, positive, total, source_updated_at, source_snapshot_hash)
    values (${snapshotId}, ${text(genre.genre)}, ${text(genre.mood)}, ${exact(genre.positive)},
      ${exact(genre.total)}, ${instant(genre.source_updated_at)}, ${sha(genre.source_snapshot_hash)});`);

  for (const game of reco.game_preference_globals) {
    query(`insert into reco.game_preference_globals
      (snapshot_id, steam_app_id, game_id, positive, total, total_hours, source_updated_at, source_snapshot_hash)
      values (${snapshotId}, ${game.steam_app_id}, ${num(game.game_id)}, ${exact(game.positive)},
        ${exact(game.total)}, ${exact(game.total_hours)}, ${instant(game.source_updated_at)},
        ${sha(game.source_snapshot_hash)});`);
  }
  // The uncatalogued app kept its AppID with a NULL game_id rather than being
  // dropped or attached to some other game.
  assert.equal(query(`select count(*) from reco.game_preference_globals where game_id is null;`), "1");
  assert.equal(query(`select steam_app_id::text from reco.game_preference_globals where game_id is null;`), "999999");

  const weight = reco.operator_weight_versions[0];
  query(`insert into reco.operator_weight_versions
    (config_version, weight_key, positive, total, note, source_updated_at, effective_at, source_snapshot_hash)
    values (${text(weight.config_version)}, ${text(weight.weight_key)}, ${exact(weight.positive)},
      ${exact(weight.total)}, ${text(weight.note)}, ${instant(weight.source_updated_at)},
      ${instant(weight.effective_at)}, ${sha(weight.source_snapshot_hash)});`);
  assert.equal(query(`select count(*) from reco.operator_weight_versions;`), "1");
});

test("the target's own reco CHECKs are real, independent of the transform", () => {
  expectRejected(
    `insert into reco.genre_preference_globals (snapshot_id, genre, mood, positive, total)
     values (${snapshotId}, 'Action', 'spicy', 1, 2);`,
    "23514",
  );
  expectRejected(
    `insert into reco.genre_preference_globals (snapshot_id, genre, mood, positive, total)
     values (${snapshotId}, 'Puzzle', 'any', 9, 2);`,
    "23514",
  );
  expectRejected(
    `insert into reco.warm_start_snapshots (snapshot_key, snapshot_version, status, frozen_at)
     values ('x', 0, 'frozen', now());`,
    "23514",
  );
});

test("app.account_preferences receives the collapsed document, and the quarantined key is absent from it", () => {
  const preference = reco.account_preferences[0];
  query(`insert into app.account_preferences (account_id, preferences, updated_at)
    values (${preference.account_id}, ${jsonb(preference.preferences)}, ${instant(preference.updated_at)});`);
  const stored = query(`select preferences::text from app.account_preferences where account_id = 1;`);
  assert.equal(stored, '{"theme": "dark"}');
  // The credential-shaped key never reached the durable, exported document.
  assert.equal(query(`select count(*) from app.account_preferences where preferences ? 'steam_api_key';`), "0");
  assert.equal(reco.counts.settings_quarantined, 1);

  for (const row of reco.legacy_account_preferences_evidence) {
    query(`insert into migration.legacy_account_preferences_evidence
      (account_id, source_account_id, preference_key, value, source_created_at, source_updated_at, source_snapshot_hash)
      values (${row.account_id}, ${text(row.source_account_id)}::uuid, ${text(row.preference_key)},
        ${jsonb(row.value)}, ${instant(row.source_created_at)}, ${instant(row.source_updated_at)},
        ${sha(row.source_snapshot_hash)});`);
  }
  // Nothing is destroyed: the quarantined value survives in bounded staging,
  // as a jsonb STRING rather than a retyped scalar.
  assert.equal(
    query(`select value::text from migration.legacy_account_preferences_evidence where preference_key = 'steam_api_key';`),
    '"SYNTHETIC-NOT-A-REAL-KEY"',
  );
  assert.equal(
    query(`select retention_class from migration.legacy_account_preferences_evidence where preference_key = 'theme';`),
    "staging-30d-post-cutover",
  );
});

test("support content loads under its pending retention policy and keeps every character", () => {
  const policy = support.retention_policy_decisions[0];
  query(`insert into support.retention_policy_decisions (policy_key, review_milestone, decision_status, rationale)
    values (${text(policy.policy_key)}, ${text(policy.review_milestone)}, ${text(policy.decision_status)},
      ${text(policy.rationale)});`);

  const message = support.contact_messages[0];
  query(`insert into support.contact_messages
    (source_record_id, source_account_public_id, account_id, enquiry_type, email, subject, message,
     dedupe_hash, status_code, created_at, updated_at, retention_policy_key, source_snapshot_hash)
    values (${text(message.source_record_id)}::uuid, ${text(message.source_account_public_id)}::uuid,
      ${num(message.account_id)}, ${message.enquiry_type}, ${text(message.email)}, ${text(message.subject)},
      ${text(message.message)}, ${text(message.dedupe_hash)}, ${message.status_code}, ${instant(message.created_at)},
      ${instant(message.updated_at)}, ${text(message.retention_policy_key)}, ${sha(message.source_snapshot_hash)});`);
  // The leading/trailing spaces the bound was measured without are still
  // there: measured in the database, since this harness trims its own stdout.
  assert.equal(query(`select length(subject)::text from support.contact_messages;`), "18");
  assert.equal(query(`select length(btrim(subject))::text from support.contact_messages;`), "14");
  assert.equal(
    query(`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') from support.contact_messages;`),
    "2026-05-01 10:00:00.000456",
  );

  const feedback = support.feedback_submissions[0];
  query(`insert into support.feedback_submissions
    (source_record_id, source_account_public_id, account_id, feedback_type, message, contact_allowed,
     contact_email, route, app_area, client_context, dedupe_hash, status_code, created_at, updated_at,
     retention_policy_key, source_snapshot_hash)
    values (${text(feedback.source_record_id)}::uuid, ${text(feedback.source_account_public_id)},
      ${num(feedback.account_id)}, ${feedback.feedback_type}, ${text(feedback.message)},
      ${bool(feedback.contact_allowed)}, ${text(feedback.contact_email)}, ${text(feedback.route)},
      ${text(feedback.app_area)}, ${jsonb(feedback.client_context)}, ${text(feedback.dedupe_hash)},
      ${feedback.status_code}, ${instant(feedback.created_at)}, ${instant(feedback.updated_at)},
      ${text(feedback.retention_policy_key)}, ${sha(feedback.source_snapshot_hash)});`);
  // The anonymous submission loaded with BOTH identity columns null, which is
  // the only shape the target's paired CHECK allows.
  assert.equal(query(`select count(*) from support.feedback_submissions where account_id is null and source_account_public_id is null;`), "1");
});

test("the support identity pairing and policy FK are real constraints", () => {
  expectRejected(
    `insert into support.contact_messages
      (source_record_id, source_account_public_id, account_id, enquiry_type, email, subject, message,
       status_code, created_at, updated_at)
      values (gen_random_uuid(), '${ACCOUNT_A}'::uuid, NULL, 1, 'x@example.test', 'subject', 'a message long enough', 0, now(), now());`,
    "23514",
  );
  expectRejected(
    `insert into support.feedback_submissions
      (source_record_id, feedback_type, message, contact_allowed, contact_email, status_code, created_at, updated_at)
      values (gen_random_uuid(), 1, 'a message long enough to pass', false, 'x@example.test', 0, now(), now());`,
    "23514",
  );
  expectRejected(
    `insert into support.contact_messages
      (source_record_id, enquiry_type, email, subject, message, status_code, created_at, updated_at, retention_policy_key)
      values (gen_random_uuid(), 1, 'x@example.test', 'subject', 'a message long enough', 0, now(), now(), 'invented-policy');`,
    "23503",
  );
});

test("ops.legacy_worker_runs accepts the bounded run with its derived retention window", () => {
  const run = operations.legacy_worker_runs[0];
  query(`insert into ops.legacy_worker_runs
    (legacy_id, worker_name, status, run_class, started_at, finished_at, duration_ms, counts, summary,
     error_message, retention_until, source_snapshot_hash)
    values (${text(run.legacy_id)}::uuid, ${text(run.worker_name)}, ${text(run.status)}, ${text(run.run_class)},
      ${instant(run.started_at)}, ${instant(run.finished_at)}, ${num(run.duration_ms)}, ${jsonb(run.counts)},
      ${jsonb(run.summary)}, ${text(run.error_message)}, '${run.retention_until.canonicalUtc}'::timestamptz,
      ${sha(run.source_snapshot_hash)});`);
  assert.equal(query(`select run_class from ops.legacy_worker_runs;`), "failure");
  // The 30-day failure window is what the target's own CHECK allows; a routine
  // row at the same window would be refused.
  expectRejected(
    `insert into ops.legacy_worker_runs
      (legacy_id, worker_name, status, run_class, started_at, counts, summary, retention_until)
      values (gen_random_uuid(), 'w', 'succeeded', 'routine', '2026-09-01 02:00:00+00',
        '{}'::jsonb, '{}'::jsonb, '2026-10-01 02:00:00+00');`,
    "23514",
  );
});

test("an in-flight import becomes a report row, and no lease or payload column exists to resume it", () => {
  const report = operations.import_freeze_report[0];
  query(`insert into migration.legacy_import_freeze_report
    (account_id, source_user_id, status, total_games, imported_games, play_history_missing, last_error,
     started_at, updated_at, completed_at, source_snapshot_hash)
    values (${report.account_id}, ${text(report.source_user_id)}::uuid, ${text(report.status)},
      ${report.total_games}, ${report.imported_games}, ${bool(report.play_history_missing)},
      ${text(report.last_error)}, ${instant(report.started_at)}, ${instant(report.updated_at)},
      ${instant(report.completed_at)}, ${sha(report.source_snapshot_hash)});`);
  assert.equal(query(`select status from migration.legacy_import_freeze_report;`), "importing");
  // The relation physically has no column that could hold a lease token or the
  // in-flight payload, so a v2 worker cannot resume the job from it.
  assert.equal(
    query(`select count(*) from information_schema.columns
      where table_schema = 'migration' and table_name = 'legacy_import_freeze_report'
        and column_name in ('processing_token', 'processing_started_at', 'games');`),
    "0",
  );
  assert.ok(operations.blockers.some((entry) => entry.code === "import_in_flight_at_snapshot"));
});

test("ops.abuse_cooldowns accepts the evidence row with no account attached", () => {
  const cooldown = operations.abuse_cooldowns[0];
  query(`insert into ops.abuse_cooldowns
    (bucket, key_digest, account_id, window_started_at, source_window_seconds, request_count,
     source_updated_at, observed_at, expires_at, algorithm_version, status, source_snapshot_hash)
    values (${text(cooldown.bucket)}, ${sha(cooldown.key_digest)}, ${num(cooldown.account_id)},
      ${instant(cooldown.window_started_at)}, ${num(cooldown.source_window_seconds)}, ${cooldown.request_count},
      ${instant(cooldown.source_updated_at)}, ${instant(cooldown.observed_at)}, ${instant(cooldown.expires_at)},
      ${text(cooldown.algorithm_version)}, ${text(cooldown.status)}, ${sha(cooldown.source_snapshot_hash)});`);
  assert.equal(query(`select status from ops.abuse_cooldowns;`), "expired");
  assert.equal(query(`select octet_length(key_digest)::text from ops.abuse_cooldowns;`), "32");
  assert.equal(query(`select count(*) from ops.abuse_cooldowns where account_id is not null;`), "0");
  // A zero request count is not a cooldown; the target refuses it.
  expectRejected(
    `insert into ops.abuse_cooldowns (bucket, key_digest, window_started_at, request_count, observed_at, algorithm_version, status)
     values ('contact_form', ${sha(DIGEST)}, now(), 0, now(), 'v', 'active');`,
    "23514",
  );
});

test("merge, alias and audit rows load together and agree with each other", () => {
  const merge = operations.account_merges[0];
  query(`insert into ops.account_merges
    (source_account_id, target_account_id, mode, verified_steam_id, reason, created_at,
     legacy_merge_id, legacy_merge_mode, source_public_id, target_public_id, analytics_delivered_at)
    values (${merge.source_account_id}, ${merge.target_account_id}, ${text(merge.mode)},
      ${merge.verified_steam_id}, ${text(merge.reason)}, ${instant(merge.created_at)},
      ${text(merge.legacy_merge_id)}::uuid, ${text(merge.legacy_merge_mode)}, ${text(merge.source_public_id)}::uuid,
      ${text(merge.target_public_id)}::uuid, ${instant(merge.analytics_delivered_at)});`);

  const alias = operations.account_aliases[0];
  query(`insert into ops.account_aliases (source_account_id, target_account_id, source_public_id, created_at, expires_at)
    values (${alias.source_account_id}, ${alias.target_account_id}, ${text(alias.source_public_id)}::uuid,
      ${instant(alias.created_at)}, ${instant(alias.expires_at)});`);

  const audit = operations.legacy_account_merge_audit[0];
  query(`insert into migration.legacy_account_merge_audit
    (legacy_merge_id, mapped_source_account_id, mapped_target_account_id, source_account_id, target_account_id,
     verified_steam_id, merge_mode, created_at, analytics_delivered_at, source_tombstone_present, source_snapshot_hash)
    values (${text(audit.legacy_merge_id)}::uuid, ${audit.mapped_source_account_id}, ${audit.mapped_target_account_id},
      ${text(audit.source_account_id)}::uuid, ${text(audit.target_account_id)}::uuid, ${text(audit.verified_steam_id)},
      ${text(audit.merge_mode)}, ${instant(audit.created_at)}, ${instant(audit.analytics_delivered_at)},
      ${bool(audit.source_tombstone_present)}, ${sha(audit.source_snapshot_hash)});`);

  assert.equal(query(`select mode from ops.account_merges;`), "merge");
  assert.equal(query(`select merge_mode from migration.legacy_account_merge_audit;`), "merged_existing");
  // A promotion pointing at a different account is exactly what the CHECK
  // forbids; the transform's mode derivation exists because of it.
  expectRejected(
    `insert into ops.account_merges (source_account_id, target_account_id, mode, reason)
     values (1, 2, 'promote', 'invalid');`,
    "23514",
  );
  expectRejected(`insert into ops.account_aliases (source_account_id, target_account_id, source_public_id)
     values (1, 1, gen_random_uuid());`, "23514");
});

test("the intent audit loads without a token digest or nonce column to carry", () => {
  const intent = operations.legacy_auth_intent_audit[0];
  query(`insert into migration.legacy_auth_intent_audit
    (legacy_intent_id, account_id, source_account_id, legacy_session_id, created_at, expires_at, consumed_at,
     target_account_id, target_mapped_account_id, verified_steam_id, outcome, source_snapshot_hash)
    values (${text(intent.legacy_intent_id)}::uuid, ${intent.account_id}, ${text(intent.source_account_id)}::uuid,
      ${text(intent.legacy_session_id)}::uuid, ${instant(intent.created_at)}, ${instant(intent.expires_at)},
      ${instant(intent.consumed_at)}, ${text(intent.target_account_id)}::uuid, ${num(intent.target_mapped_account_id)},
      ${text(intent.verified_steam_id)}, ${text(intent.outcome)}, ${sha(intent.source_snapshot_hash)});`);
  assert.equal(query(`select outcome from migration.legacy_auth_intent_audit;`), "merged_existing");
  assert.equal(
    query(`select count(*) from information_schema.columns
      where table_schema = 'migration' and table_name = 'legacy_auth_intent_audit'
        and column_name in ('token_hash', 'openid_response_nonce');`),
    "0",
  );
  // The paired target columns are a real CHECK.
  expectRejected(
    `insert into migration.legacy_auth_intent_audit
      (legacy_intent_id, account_id, source_account_id, created_at, expires_at, target_account_id)
      values (gen_random_uuid(), 1, '${ACCOUNT_A}'::uuid, now(), now() + interval '5 minutes', '${ACCOUNT_B}'::uuid);`,
    "23514",
  );
});

test("no synthetic secret text reached any durable runtime relation", () => {
  // The quarantined value exists only in bounded staging, and nowhere in the
  // runtime model the account export reads.
  assert.equal(
    query(`select count(*) from app.account_preferences where preferences::text like '%SYNTHETIC-NOT-A-REAL-KEY%';`),
    "0",
  );
  assert.equal(
    query(`select count(*) from migration.legacy_account_preferences_evidence
      where value::text like '%SYNTHETIC-NOT-A-REAL-KEY%';`),
    "1",
  );
});

test("deleting an account removes every personal row and leaves account-free evidence intact", () => {
  const before = Number(query(`select count(*) from support.contact_messages;`));
  assert.ok(before > 0);
  query(`delete from app.accounts where id in (1, 2);`);
  for (const relation of [
    "reco.user_genre_preferences",
    "app.account_preferences",
    "migration.legacy_account_preferences_evidence",
    "support.contact_messages",
    "migration.legacy_import_freeze_report",
    "ops.account_merges",
    "ops.account_aliases",
    "migration.legacy_account_merge_audit",
    "migration.legacy_auth_intent_audit",
  ]) {
    assert.equal(Number(query(`select count(*) from ${relation};`)), 0, `${relation} kept a row after account deletion`);
  }
  // Account-free evidence survives: an anonymous submission, the shared reco
  // globals, the bounded worker run and the pseudonymous cooldown.
  assert.equal(query(`select count(*) from support.feedback_submissions;`), "1");
  assert.equal(query(`select count(*) from reco.genre_preference_globals;`), "1");
  assert.equal(query(`select count(*) from reco.game_preference_globals;`), "2");
  assert.equal(query(`select count(*) from ops.legacy_worker_runs;`), "1");
  assert.equal(query(`select count(*) from ops.abuse_cooldowns;`), "1");
});
