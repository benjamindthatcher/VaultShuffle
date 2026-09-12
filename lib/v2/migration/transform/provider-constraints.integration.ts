import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  transformGameQuarantine,
  transformIngestQueueArchive,
  transformSeedRuns,
} from "./catalogue-provenance.ts";
import {
  transformDurationAliases,
  transformDurationEstimates,
  transformDurationImportRuns,
  transformDurationJobArchive,
  transformDurationReviews,
} from "./duration-provider.ts";
import { buildGameMap } from "./games.ts";
import { transformCatalogue, type CatalogGamesSourceRow } from "./catalogue.ts";
import type { PgTimestamp } from "./scalars.ts";

/**
 * Physical acceptance for the M3-H provider/legacy-catalogue domain against a
 * real PostgreSQL 17 cluster with M1, M2 and M3 replayed.
 *
 * This file is deliberately NOT named `*.test.ts`: it needs a disposable local
 * cluster, so it is invoked explicitly rather than by the default suite. It
 * contains only private synthetic rows, performs no remote call, and writes
 * only to the disposable database its own environment variables name.
 *
 * It proves the typed output of every transform in this domain satisfies the
 * ACTUAL applied constraints on `catalog.duration_estimates`,
 * `catalog.duration_aliases`, `catalog.review_decisions`,
 * `catalog.duration_imports`, `catalog.seed_runs`,
 * `migration.legacy_duration_job_archive` and
 * `migration.legacy_ingest_queue_archive` — and that four of the target
 * CHECK constraints these transforms already enforce in TypeScript are also
 * real, by letting PostgreSQL reject a raw adversarial row independent of the
 * transform's own validation.
 *
 * `guest_catalogue_pool` has no destination relation at all (coverage
 * accounting only, per the M3-H handoff) and so has no row to gate here.
 *
 * Run it against a cluster created only for this purpose:
 *
 *   VS_M3H_PGHOST=/tmp/vs-m3h-20260911 \
 *   VS_M3H_PGPORT=55485 \
 *   VS_M3H_PGUSER=vsm3h \
 *   VS_M3H_PGDATABASE=vaultshuffle_m3h \
 *   VS_M3H_PSQL=node_modules/.cache/vaultshuffle-pg17-20260910/bin/psql \
 *   node --experimental-strip-types --test \
 *     lib/v2/migration/transform/provider-constraints.integration.ts
 */

const PSQL = process.env.VS_M3H_PSQL ?? "psql";
const PGHOST = process.env.VS_M3H_PGHOST ?? "/tmp/vs-m3h-20260911";
const PGPORT = process.env.VS_M3H_PGPORT ?? "55485";
const PGUSER = process.env.VS_M3H_PGUSER ?? "vsm3h";
const PGDATABASE = process.env.VS_M3H_PGDATABASE ?? "vaultshuffle_m3h";

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

function uuid(tag: string): string {
  return `00000000-0000-4000-8000-${tag.padStart(12, "0")}`;
}

// --- fixture -------------------------------------------------------------

const SNAPSHOT = "d3".repeat(32);
const RUN = Object.freeze({ runId: "m3h-constraints", snapshotHash: SNAPSHOT });

const GAME_MAP = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: "440" }] }).map;

/**
 * A complete 58-column `catalog_games` row whose tag lifecycle is mid-backoff:
 * three failures, an effective fence, and a recorded error. This is the shape
 * whose scheduling half used to be retired with a "rebuilt after cutover"
 * claim, so the gate proves it physically reaches `catalog.provider_state`.
 */
function catalogGamesRow(): CatalogGamesSourceRow {
  return {
    steam_appid: "440",
    name: "Team Fortress 2",
    normalized_name: "team fortress 2",
    steam_type: "game",
    developer: "Valve",
    publisher: "Valve",
    genres: "{Action}",
    categories: "{Multi-player}",
    tags: "[]",
    short_description: null,
    release_date: null,
    is_free: "t",
    capsule_url: null,
    header_url: null,
    review_positive: "10",
    review_negative: "1",
    review_total: "11",
    price_currency: null,
    price_initial: null,
    price_final: null,
    discount_percent: "0",
    popularity_rank: null,
    popularity_source: null,
    popularity_metric: null,
    popularity_low: null,
    popularity_high: null,
    popularity_ccu: null,
    source_captured_at: null,
    first_seen_reason: "seed",
    import_sighting_count: "1",
    first_seen_at: "2026-01-01 00:00:00+00",
    last_seen_at: "2026-01-02 00:00:00+00",
    metadata_fetched_at: "2026-01-02 00:00:00+00",
    created_at: "2026-01-01 00:00:00+00",
    updated_at: "2026-01-05 00:00:00+00",
    users_that_imported: "1",
    main_story_minutes: null,
    main_extras_minutes: null,
    completionist_minutes: null,
    duration_source: null,
    duration_source_game_id: null,
    duration_source_updated_at: null,
    duration_confidence: null,
    duration_status: "pending",
    duration_kind: "unknown",
    tags_source: "steamspy",
    tags_status: "failed",
    tags_fetched_at: "2026-01-03 00:00:00+00",
    tags_processing_started_at: null,
    tags_next_attempt_at: "2026-01-04 12:00:00+00",
    tags_failure_count: "3",
    tags_last_error: "SteamSpy returned 429.",
    platform_windows: "t",
    platform_mac: null,
    platform_linux: null,
    deck_compatibility: null,
    deck_checked_at: null,
    duration_manual_override: "f",
  };
}

test("cluster sanity: the M3 provider/legacy-catalogue relations exist", () => {
  const count = query(`
    select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('catalog','migration') and c.relname in (
      'duration_estimates','duration_aliases','review_decisions','duration_imports',
      'seed_runs','legacy_duration_job_archive','legacy_ingest_queue_archive','games'
    );
  `);
  assert.equal(Number(count), 8);

  query(`insert into catalog.games (id, steam_app_id, title, normalized_sort_title)
    overriding system value
    values (1, 440, 'Team Fortress 2', 'team fortress 2');`);
});

test("catalog.duration_estimates accepts typed transform output", () => {
  const result = transformDurationEstimates({
    runIdentity: RUN,
    gameMap: GAME_MAP,
    rows: [
      {
        steam_app_id: "440",
        provider: "hltb",
        provider_game_id: "9001",
        main_story_minutes: "600",
        main_extra_minutes: "900",
        completionist_minutes: "1200",
        submission_count: "42",
        match_status: "matched",
        match_confidence: "high",
        provider_updated_at: "2026-01-01 00:00:00+00",
        checked_at: "2026-01-02 00:00:00+00",
        next_refresh_at: "2026-02-01 00:00:00+00",
        last_error_code: null,
        created_at: "2026-01-01 00:00:00+00",
        updated_at: "2026-01-02 00:00:00+00",
        evidence: '{"raw":true}',
      },
    ],
  });
  const estimate = result.duration_estimates[0];
  query(`insert into catalog.duration_estimates
    (game_id, steam_app_id, provider, provider_game_id, main_story_minutes, main_extra_minutes,
     completionist_minutes, submission_count, match_status, match_confidence, provider_updated_at,
     checked_at, next_refresh_at, last_error_code, created_at, updated_at, evidence, source_snapshot_hash)
    values
    (${num(estimate.game_id)}, ${estimate.steam_app_id}, ${text(estimate.provider)},
     ${text(estimate.provider_game_id)}, ${num(estimate.main_story_minutes)}, ${num(estimate.main_extra_minutes)},
     ${num(estimate.completionist_minutes)}, ${num(estimate.submission_count)}, ${text(estimate.match_status)},
     ${text(estimate.match_confidence)}, ${instant(estimate.provider_updated_at)}, ${instant(estimate.checked_at)},
     ${instant(estimate.next_refresh_at)}, ${text(estimate.last_error_code)}, ${instant(estimate.created_at)},
     ${instant(estimate.updated_at)}, ${jsonb(estimate.evidence)}, ${sha(estimate.source_snapshot_hash)});`);

  const rowCount = query(`select count(*) from catalog.duration_estimates where steam_app_id = 440;`);
  assert.equal(Number(rowCount), 1);
});

test("a duplicate (steam_app_id, provider) pair violates the real unique constraint", () => {
  expectRejected(
    `insert into catalog.duration_estimates
      (steam_app_id, provider, match_status, checked_at, created_at, updated_at)
      values (440, 'hltb', 'matched', now(), now(), now());`,
    "23505",
  );
});

test("catalog.duration_aliases accepts typed transform output with a NULL game_id for an unmatched app", () => {
  const result = transformDurationAliases({
    runIdentity: RUN,
    gameMap: GAME_MAP,
    rows: [
      {
        steam_app_id: "620",
        search_title: "Portal 2 Classic",
        release_year: "2011",
        review_status: "approved",
        notes: "Rescue for a re-released SKU.",
        created_at: "2026-01-01 00:00:00+00",
        updated_at: "2026-01-01 00:00:00+00",
      },
    ],
  });
  const alias = result.duration_aliases[0];
  assert.equal(alias.game_id, null);
  query(`insert into catalog.duration_aliases
    (steam_app_id, game_id, search_title, release_year, review_status, notes, created_at, updated_at, source_snapshot_hash)
    values
    (${alias.steam_app_id}, ${num(alias.game_id)}, ${text(alias.search_title)}, ${num(alias.release_year)},
     ${text(alias.review_status)}, ${text(alias.notes)}, ${instant(alias.created_at)}, ${instant(alias.updated_at)},
     ${sha(alias.source_snapshot_hash)});`);
  const rowCount = query(`select count(*) from catalog.duration_aliases where steam_app_id = 620 and game_id is null;`);
  assert.equal(Number(rowCount), 1);
});

test("catalog.review_decisions accepts a quarantine-kind row from an app absent from the catalogue", () => {
  const result = transformGameQuarantine({
    runIdentity: RUN,
    gameMap: GAME_MAP,
    rows: [
      {
        steam_appid: "9999",
        name: "Not A Game",
        steam_type: "advertising",
        matched_rule: "advertising_keyword",
        reason: "Title matched the advertising-app keyword list.",
        genres: "{Utilities}",
        categories: "{}",
        review_status: "pending",
        source: "automatic",
        first_detected_at: "2026-01-01 00:00:00+00",
        last_detected_at: "2026-01-05 00:00:00+00",
        reviewed_at: null,
        review_notes: null,
        updated_at: "2026-01-05 00:00:00+00",
      },
    ],
  });
  const decision = result.review_decisions[0];
  assert.equal(decision.game_id, null);
  insertReviewDecision(decision);
  const rowCount = query(`
    select count(*) from catalog.review_decisions
    where source_relation = 'catalog_game_quarantine' and source_record_key = '9999';
  `);
  assert.equal(Number(rowCount), 1);
});

test("catalog.review_decisions accepts a duration-kind row with a resolved reviewer account", () => {
  const result = transformDurationReviews({
    runIdentity: RUN,
    gameMap: GAME_MAP,
    accountMap: [{ legacy_id: uuid("a1"), account_id: 1, source_kind: "app_accounts", source_snapshot_hash: SNAPSHOT }],
    rows: [
      {
        steam_appid: "440",
        response_text: "Corrected using a fresh HLTB submission batch.",
        response_kind: "hltb_url",
        source_url: "https://howlongtobeat.com/game/440",
        reviewer_user_id: uuid("a1"),
        reviewed_at: "2026-01-05 00:00:00+00",
        updated_at: "2026-01-06 00:00:00+00",
      },
    ],
  });
  query(`insert into app.accounts (id, public_id, account_kind) overriding system value
    values (1, gen_random_uuid(), 'manual');`);
  const decision = result.review_decisions[0];
  assert.equal(decision.reviewer_account_id, 1);
  insertReviewDecision(decision);
  const rowCount = query(`
    select count(*) from catalog.review_decisions
    where source_relation = 'catalog_duration_reviews' and reviewer_account_id = 1;
  `);
  assert.equal(Number(rowCount), 1);
});

function insertReviewDecision(decision: {
  game_id: number | null;
  steam_app_id: string;
  decision_kind: string;
  source_relation: string;
  source_record_key: string;
  source: string;
  precedence_rank: number;
  decision_status: string;
  name: string | null;
  steam_type: string | null;
  matched_rule: string | null;
  reason: string | null;
  genres: string | null;
  categories: string | null;
  response_text: string | null;
  response_kind: string | null;
  source_url: string | null;
  reviewer_account_id: number | null;
  reviewed_at: PgTimestamp | null;
  review_notes: string | null;
  duration_manual_override: boolean;
  source_payload: { text: string };
  created_at: PgTimestamp;
  updated_at: PgTimestamp;
  source_snapshot_hash: string;
}): void {
  query(`insert into catalog.review_decisions
    (game_id, steam_app_id, decision_kind, source_relation, source_record_key, source, precedence_rank,
     decision_status, name, steam_type, matched_rule, reason, genres, categories, response_text, response_kind,
     source_url, reviewer_account_id, reviewed_at, review_notes, duration_manual_override, source_payload,
     created_at, updated_at, source_snapshot_hash)
    values
    (${num(decision.game_id)}, ${decision.steam_app_id}, ${text(decision.decision_kind)}, ${text(decision.source_relation)},
     ${text(decision.source_record_key)}, ${text(decision.source)}, ${decision.precedence_rank},
     ${text(decision.decision_status)}, ${text(decision.name)}, ${text(decision.steam_type)}, ${text(decision.matched_rule)},
     ${text(decision.reason)}, ${jsonb(decision.genres === null ? null : { text: decision.genres })},
     ${jsonb(decision.categories === null ? null : { text: decision.categories })}, ${text(decision.response_text)},
     ${text(decision.response_kind)}, ${text(decision.source_url)}, ${num(decision.reviewer_account_id)},
     ${instant(decision.reviewed_at)}, ${text(decision.review_notes)}, ${decision.duration_manual_override},
     ${jsonb(decision.source_payload)}, ${instant(decision.created_at)}, ${instant(decision.updated_at)},
     ${sha(decision.source_snapshot_hash)});`);
}

test("a duration review's response_kind/source_url pairing check is real, independent of the transform", () => {
  expectRejected(
    `insert into catalog.review_decisions
      (steam_app_id, decision_kind, source_relation, source_record_key, source, precedence_rank,
       decision_status, response_kind, source_url, created_at, updated_at)
      values
      (440, 'duration', 'catalog_duration_reviews', '440-dup', 'legacy_catalog_duration_reviews', 90,
       'retained', 'note', 'https://example.com', now(), now());`,
    "23514",
  );
});

test("catalog.seed_runs accepts typed transform output", () => {
  const result = transformSeedRuns({
    runIdentity: RUN,
    rows: [
      {
        id: uuid("51"),
        source: "steamspy",
        metric: "owners",
        captured_at: "2026-01-01",
        requested_count: "1000",
        accepted_count: "900",
        source_url: "https://steamspy.com/api.php",
        source_sha256: "a".repeat(64),
        created_at: "2026-01-01 00:00:00+00",
      },
    ],
  });
  const run = result.seed_runs[0];
  query(`insert into catalog.seed_runs
    (legacy_id, source, metric, captured_on, requested_count, accepted_count, source_url, source_sha256,
     created_at, source_snapshot_hash)
    values
    ('${run.legacy_id}', ${text(run.source)}, ${text(run.metric)}, '${run.captured_on.toIsoString()}',
     ${run.requested_count}, ${run.accepted_count}, ${text(run.source_url)}, ${text(run.source_sha256)},
     ${instant(run.created_at)}, ${sha(run.source_snapshot_hash)});`);
  const rowCount = query(`select count(*) from catalog.seed_runs where legacy_id = '${uuid("51")}';`);
  assert.equal(Number(rowCount), 1);
});

test("a seed run's accepted-count-above-requested check is real, independent of the transform", () => {
  expectRejected(
    `insert into catalog.seed_runs (legacy_id, source, metric, captured_on, requested_count, accepted_count, created_at)
      values ('${uuid("52")}', 'steamspy', 'owners', '2026-01-01', 10, 11, now());`,
    "23514",
  );
});

test("catalog.duration_imports accepts typed transform output", () => {
  const result = transformDurationImportRuns({
    runIdentity: RUN,
    rows: [
      {
        id: uuid("71"),
        source: "hltb_bulk_export",
        imported_count: "900",
        skipped_count: "100",
        source_updated_at: "2025-12-31 00:00:00+00",
        created_at: "2026-01-01 00:00:00+00",
        source_sha256: "c".repeat(64),
        expected_app_count: "1000",
        staged_row_count: "1000",
        status: "succeeded",
        completed_at: "2026-01-01 01:00:00+00",
        manifest: '{"files":["a.csv"]}',
      },
    ],
  });
  const run = result.duration_imports[0];
  query(`insert into catalog.duration_imports
    (legacy_id, source, imported_count, skipped_count, expected_app_count, staged_row_count, status,
     source_sha256, source_updated_at, created_at, completed_at, manifest, source_snapshot_hash)
    values
    ('${run.legacy_id}', ${text(run.source)}, ${run.imported_count}, ${run.skipped_count},
     ${num(run.expected_app_count)}, ${num(run.staged_row_count)}, ${text(run.status)}, ${text(run.source_sha256)},
     ${instant(run.source_updated_at)}, ${instant(run.created_at)}, ${instant(run.completed_at)},
     ${jsonb(run.manifest)}, ${sha(run.source_snapshot_hash)});`);
  const rowCount = query(`select count(*) from catalog.duration_imports where legacy_id = '${uuid("71")}';`);
  assert.equal(Number(rowCount), 1);
});

test("a duration import's completed-before-created check is real, independent of the transform", () => {
  expectRejected(
    `insert into catalog.duration_imports
      (legacy_id, source, imported_count, skipped_count, status, created_at, completed_at)
      values ('${uuid("72")}', 'hltb_bulk_export', 0, 0, 'succeeded', now(), now() - interval '1 day');`,
    "23514",
  );
});

test("migration.legacy_duration_job_archive accepts typed transform output", () => {
  const result = transformDurationJobArchive({
    runIdentity: RUN,
    gameMap: GAME_MAP,
    rows: [
      {
        steam_app_id: "440",
        status: "failed",
        priority: "10",
        attempts: "5",
        next_attempt_at: "2026-01-02 00:00:00+00",
        locked_at: null,
        locked_by: null,
        last_error_code: "provider_timeout",
        last_error_message: "Request to provider timed out after 30s.",
        created_at: "2026-01-01 00:00:00+00",
        updated_at: "2026-01-02 00:00:00+00",
      },
    ],
  });
  const archived = result.archive[0];
  query(`insert into migration.legacy_duration_job_archive
    (steam_app_id, status, attempts, last_error_code, last_error_message, created_at, source_snapshot_hash)
    values
    (${archived.steam_app_id}, ${text(archived.status)}, ${archived.attempts}, ${text(archived.last_error_code)},
     ${text(archived.last_error_message)}, ${instant(archived.created_at)}, ${sha(archived.source_snapshot_hash)});`);
  const rowCount = query(`select count(*) from migration.legacy_duration_job_archive where steam_app_id = 440;`);
  assert.equal(Number(rowCount), 1);

  // The durable half: a catalogued app's exhausted duration attempt reaches
  // catalog.provider_state, so the fence and attempt count outlive the
  // 30-day archive above.
  assert.equal(result.provider_state.length, 1);
  const state = result.provider_state[0];
  query(`insert into catalog.provider_state
    (game_id, provider, evidence_kind, status, failure_count, next_attempt_at, processing_started_at,
     fetched_at, last_error_code, last_error, source_snapshot_hash, updated_at)
    values
    (${state.game_id}, ${text(state.provider)}, ${text(state.evidence_kind)}, ${text(state.status)},
     ${state.failure_count}, ${instant(state.next_attempt_at)}, ${instant(state.processing_started_at)},
     ${instant(state.fetched_at)}, ${text(state.last_error_code)}, ${text(state.last_error)},
     ${sha(state.source_snapshot_hash)}, ${instant(state.updated_at)});`);
  assert.equal(
    query(`select failure_count from catalog.provider_state where game_id = 1 and evidence_kind = 'duration';`),
    "5",
  );
  assert.equal(
    query(`select next_attempt_at from catalog.provider_state where game_id = 1 and evidence_kind = 'duration';`),
    "2026-01-02 00:00:00+00",
  );
});

test("catalog.provider_state's own CHECKs refuse a fence or lease the transform would never emit", () => {
  // A retry fence on a ready row: the transform drops it for exactly this
  // reason, and the constraint proves the reason is real.
  expectRejected(
    `insert into catalog.provider_state (game_id, provider, evidence_kind, status, next_attempt_at, updated_at)
     values (1, 'hltb', 'tags', 'ready', now(), now());`,
    "23514",
  );
  // A lease instant on a pending row.
  expectRejected(
    `insert into catalog.provider_state (game_id, provider, evidence_kind, status, processing_started_at, updated_at)
     values (1, 'hltb', 'tags', 'pending', now(), now());`,
    "23514",
  );
  expectRejected(
    `insert into catalog.provider_state (game_id, provider, evidence_kind, status, failure_count, updated_at)
     values (1, 'hltb', 'tags', 'retry', 0, now());`,
    "23514",
  );
});

test("a terminal verdict for an AppID with no catalogue row is durable and keyed by AppID", () => {
  // 9999 is deliberately absent from catalog.games: a rejected identity is
  // exactly one the catalogue refused to store, which is why this evidence
  // cannot live in catalog.provider_state.
  const result = transformIngestQueueArchive({
    runIdentity: RUN,
    gameMap: GAME_MAP,
    rows: [
      {
        steam_appid: "9999",
        status: "rejected",
        reason: "user_import",
        priority: "50",
        requested_count: "7",
        source_rank: null,
        source_payload: "{}",
        attempts: "2",
        next_attempt_at: null,
        processing_started_at: null,
        last_error: null,
        rejection_reason: "Steam reports this AppID as a demo, not a game.",
        first_requested_at: "2026-01-01 00:00:00+00",
        last_requested_at: "2026-01-02 00:00:00+00",
        processed_at: "2026-01-02 00:00:00+00",
        updated_at: "2026-01-02 00:00:00+00",
      },
    ],
  });
  assert.equal(result.provider_state.length, 0);
  const verdict = result.terminal_rejections[0];
  query(`insert into catalog.appid_terminal_rejections
    (steam_app_id, evidence_kind, provider, terminal_status, reason, attempts, last_error_code,
     first_requested_at, last_attempt_at, source_relation, retry_allowed_after, source_snapshot_hash)
    values
    (${verdict.steam_app_id}, ${text(verdict.evidence_kind)}, ${text(verdict.provider)},
     ${text(verdict.terminal_status)}, ${text(verdict.reason)}, ${verdict.attempts},
     ${text(verdict.last_error_code)}, ${instant(verdict.first_requested_at)}, ${instant(verdict.last_attempt_at)},
     ${text(verdict.source_relation)}, ${instant(verdict.retry_allowed_after)}, ${sha(verdict.source_snapshot_hash)});`);
  assert.equal(
    query(`select reason from catalog.appid_terminal_rejections where steam_app_id = 9999;`),
    "Steam reports this AppID as a demo, not a game.",
  );
  // No catalogue row exists for it, and none is invented to hold the verdict.
  assert.equal(query(`select count(*) from catalog.games where steam_app_id = 9999;`), "0");

  // The reverse ordering the transform refuses is refused here too.
  expectRejected(
    `insert into catalog.appid_terminal_rejections
      (steam_app_id, evidence_kind, terminal_status, reason, attempts, first_requested_at, last_attempt_at, source_relation)
      values (8888, 'ingest', 'rejected', 'x', 1, now(), now() - interval '1 day', 'catalog_ingest_queue');`,
    "23514",
  );
  // 'retry' is not a terminal verdict literal.
  expectRejected(
    `insert into catalog.appid_terminal_rejections
      (steam_app_id, evidence_kind, terminal_status, reason, attempts, last_attempt_at, source_relation)
      values (8888, 'ingest', 'retry', 'x', 1, now(), 'catalog_ingest_queue');`,
    "23514",
  );
});

test("migration.legacy_ingest_queue_archive accepts typed transform output", () => {
  const result = transformIngestQueueArchive({
    runIdentity: RUN,
    gameMap: GAME_MAP,
    rows: [
      {
        steam_appid: "440",
        status: "rejected",
        reason: "manual",
        priority: "50",
        requested_count: "3",
        source_rank: "1",
        source_payload: '{"raw":"payload"}',
        attempts: "2",
        next_attempt_at: null,
        processing_started_at: null,
        last_error: "rate limited",
        rejection_reason: "not a real game",
        first_requested_at: "2026-01-01 00:00:00+00",
        last_requested_at: "2026-01-02 00:00:00+00",
        processed_at: "2026-01-02 00:00:00+00",
        updated_at: "2026-01-02 00:00:00+00",
      },
    ],
  });
  const archived = result.archive[0];
  query(`insert into migration.legacy_ingest_queue_archive
    (steam_appid, status, reason, requested_count, source_rank, attempts, last_error, rejection_reason,
     first_requested_at, last_requested_at, processed_at, source_snapshot_hash)
    values
    (${archived.steam_appid}, ${text(archived.status)}, ${text(archived.reason)}, ${archived.requested_count},
     ${num(archived.source_rank)}, ${archived.attempts}, ${text(archived.last_error)}, ${text(archived.rejection_reason)},
     ${instant(archived.first_requested_at)}, ${instant(archived.last_requested_at)}, ${instant(archived.processed_at)},
     ${sha(archived.source_snapshot_hash)});`);
  const rowCount = query(`select count(*) from migration.legacy_ingest_queue_archive where steam_appid = 440;`);
  assert.equal(Number(rowCount), 1);

  // The same mapped source row also has a durable lifecycle copy. Keep this
  // row in the database for the tags test below: metadata, duration and tags
  // must coexist under provider_state's (game_id, provider, evidence_kind)
  // key instead of one source overwriting another.
  assert.equal(result.provider_state.length, 1);
  const state = result.provider_state[0];
  assert.equal(state.evidence_kind, "metadata");
  query(`insert into catalog.provider_state
    (game_id, provider, evidence_kind, status, failure_count, next_attempt_at, processing_started_at,
     fetched_at, last_error_code, last_error, source_snapshot_hash, updated_at)
    values
    (${state.game_id}, ${text(state.provider)}, ${text(state.evidence_kind)}, ${text(state.status)},
     ${state.failure_count}, ${instant(state.next_attempt_at)}, ${instant(state.processing_started_at)},
     ${instant(state.fetched_at)}, ${text(state.last_error_code)}, ${text(state.last_error)},
     ${sha(state.source_snapshot_hash)}, ${instant(state.updated_at)});`);
});

test("catalogue tag scheduling reaches catalog.provider_state with its real fence", () => {
  const row = catalogGamesRow();
  const map = buildGameMap({ runIdentity: RUN, catalogueGames: [{ steam_appid: row.steam_appid }] }).map;
  const result = transformCatalogue({
    runIdentity: RUN,
    gameMap: map,
    rows: [row],
    offerPolicy: { provider: "legacy_catalog_games", retentionUntil: "2027-01-01 00:00:00+00" },
  });
  assert.equal(result.provider_state.length, 1);
  const state = result.provider_state[0];
  assert.equal(state.evidence_kind, "tags");
  query(`insert into catalog.provider_state
    (game_id, provider, evidence_kind, status, failure_count, next_attempt_at, processing_started_at,
     fetched_at, last_error_code, last_error, source_snapshot_hash, updated_at)
    values
    (${state.game_id}, ${text(state.provider)}, ${text(state.evidence_kind)}, ${text(state.status)},
     ${state.failure_count}, ${instant(state.next_attempt_at)}, ${instant(state.processing_started_at)},
     ${instant(state.fetched_at)}, ${text(state.last_error_code)}, ${text(state.last_error)},
     ${sha(state.source_snapshot_hash)}, ${instant(state.updated_at)});`);
  assert.equal(
    query(`select next_attempt_at from catalog.provider_state where game_id = 1 and evidence_kind = 'tags';`),
    "2026-01-04 12:00:00+00",
  );
  assert.equal(
    query(`select failure_count from catalog.provider_state where game_id = 1 and evidence_kind = 'tags';`),
    "3",
  );
  // All three independently emitted evidence kinds coexist on one game.
  assert.equal(query(`select count(*) from catalog.provider_state where game_id = 1;`), "3");
  assert.equal(
    query(`select string_agg(evidence_kind, ',' order by evidence_kind) from catalog.provider_state where game_id = 1;`),
    "duration,metadata,tags",
  );
});

test("deleting a catalogue game applies each declared dependency action without losing AppID evidence", () => {
  const stateBefore = Number(query(`select count(*) from catalog.provider_state where game_id = 1;`));
  assert.ok(stateBefore > 0);
  query(`delete from catalog.games where id = 1;`);
  // provider_state is per-game evidence and dies with the game; the AppID
  // verdict has no catalogue row to die with and must survive, which is the
  // whole reason it is keyed by AppID.
  assert.equal(query(`select count(*) from catalog.provider_state where game_id = 1;`), "0");
  assert.equal(query(`select count(*) from catalog.appid_terminal_rejections where steam_app_id = 9999;`), "1");
  const estimateGameId = query(`select game_id from catalog.duration_estimates where steam_app_id = 440;`);
  assert.equal(estimateGameId, "");
  const decisionCount = query(`
    select count(*) from catalog.review_decisions where source_relation = 'catalog_duration_reviews';
  `);
  assert.equal(Number(decisionCount), 1);
  const decisionGameId = query(`
    select game_id from catalog.review_decisions where source_relation = 'catalog_duration_reviews';
  `);
  assert.equal(decisionGameId, "");
});
