import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { buildManifest, serializeManifest, type ManifestRelation } from "../export/manifest.ts";
import { inspectRun, type ReaderExpectations } from "../read/reader.ts";
import { ALL_SOURCE_RELATIONS, ALL_TARGET_RELATIONS, assembleAllDomains } from "./all-domains.ts";
import { runLoaderPipeline } from "./pipeline.ts";
import { stageVerifiedRun, type StagedRun } from "./staging.ts";
import { discoverLocalTargetSpecs, type LocalTargetDescriptor } from "./target.ts";

const PSQL = process.env.VS_M3L_PSQL ?? "psql";
const TARGET: LocalTargetDescriptor = Object.freeze({
  socketDirectory: process.env.VS_M3L_PGHOST ?? "/tmp/vs-m3-batches-20260912",
  port: Number(process.env.VS_M3L_PGPORT ?? "55496"),
  user: process.env.VS_M3L_PGUSER ?? "vsm3",
  database: process.env.VS_M3L_PGDATABASE ?? "vs_loader",
  psqlPath: PSQL,
});
const SNAPSHOT = "5a".repeat(32);
const EXPECTED_SCHEMA_FINGERPRINT = "1558351531a10a8ebfd5ec932cc56a21e434c883e7e46a2bdfb950fd96a208b8";
const ACCOUNT = "10000000-0000-4000-8000-000000000001";
const MANUAL_ACCOUNT = "10000000-0000-4000-8000-000000000002";
const LIBRARY = "30000000-0000-4000-8000-000000000001";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANUAL_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const COLLECTION = "40000000-0000-4000-8000-000000000001";
const DRAW = "50000000-0000-4000-8000-000000000001";
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOMAIN_EVIDENCE = Object.freeze({
  observedAt: "2026-09-12 00:00:00+00",
  catalogueOfferPolicy: { provider: "legacy_catalog_games", retentionUntil: "2027-01-01 00:00:00+00" },
  warmStart: { snapshot_key: "synthetic", snapshot_version: "1", frozen_at: "2026-09-12 00:00:00+00" },
  operatorConfig: { config_version: "synthetic", effective_at: "2026-09-12 00:00:00+00" },
  cutover: { observed_at: "2026-09-11 00:00:00+00", algorithm_version: "legacy-fixed-window", window_seconds: 3600 },
  targetRelations: ALL_TARGET_RELATIONS,
});

type SourceInventory = Readonly<{ public_tables: readonly Readonly<{ name: string; columns: readonly Readonly<{ name: string }>[] }>[] }>;
const inventory = JSON.parse(readFileSync("database/v2/source-schema-inventory-20260909.json", "utf8")) as SourceInventory;
const columnsByRelation = new Map(inventory.public_tables.map((entry) => [entry.name, entry.columns.map((column) => column.name)]));
const destinationIndex = JSON.parse(readFileSync("database/v2/migration/manifest/physical-destination-index.json", "utf8")) as {
  relations: Readonly<Record<string, Readonly<{ columns: readonly string[] }>>>;
};
let root = "";

function sql(statement: string): string {
  const result = spawnSync(PSQL, ["-h", TARGET.socketDirectory, "-p", String(TARGET.port), "-U", TARGET.user, "-d", TARGET.database, "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", "-c", statement], { encoding: "utf8" });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? "");
  return (result.stdout ?? "").trim();
}

function copyBytes(columns: readonly string[], records: readonly Readonly<Record<string, string | null>>[]): Buffer {
  const text = records.map((record) => columns.map((column) => {
    const cell = record[column] ?? null;
    return cell === null ? "\\N" : cell.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
  }).join("\t")).join("\n");
  return Buffer.from(text.length === 0 ? "" : `${text}\n`, "utf8");
}

const catalogGame: Readonly<Record<string, string | null>> = Object.freeze({
  steam_appid: "440", name: "Team Fortress 2", normalized_name: "team fortress 2", steam_type: "game",
  developer: "Valve", publisher: "Valve", genres: "{Action}", categories: "{Multi-player}",
  tags: '[{"tag":"Hero Shooter","weight":99}]', short_description: "A team-based shooter.", release_date: "2007-10-10",
  is_free: "t", capsule_url: "https://cdn.example/capsule.jpg", header_url: "https://cdn.example/header.jpg",
  review_positive: "900000", review_negative: "100000", review_total: "1000000", price_currency: "USD",
  price_initial: "1999", price_final: "999", discount_percent: "50", popularity_rank: "12",
  popularity_source: "steamspy", popularity_metric: "owners", popularity_low: "50000000", popularity_high: "100000000",
  popularity_ccu: "70000", source_captured_at: "2026-08-20", first_seen_reason: "seed", import_sighting_count: "37",
  first_seen_at: "2026-01-02 03:04:05.000006+00", last_seen_at: "2026-09-01 00:00:00+00",
  metadata_fetched_at: "2026-09-02 12:00:00+00", created_at: "2026-01-02 03:04:05+00",
  updated_at: "2026-09-03 09:08:07.654321+00", users_that_imported: "12", main_story_minutes: "0",
  main_extras_minutes: null, completionist_minutes: "6000", duration_source: "hltb", duration_source_game_id: "20873",
  duration_source_updated_at: "2026-05-05 00:00:00+00", duration_confidence: "high", duration_status: "ready",
  duration_kind: "endless", tags_source: "steam_store", tags_status: "ready", tags_fetched_at: "2026-09-02 12:00:01+00",
  tags_processing_started_at: null, tags_next_attempt_at: null, tags_failure_count: "0", tags_last_error: null,
  platform_windows: "t", platform_mac: "f", platform_linux: null, deck_compatibility: "3",
  deck_checked_at: "2026-07-01 00:00:00+00", duration_manual_override: "t",
});

const sourceRows: Readonly<Record<string, readonly Readonly<Record<string, string | null>>[]>> = Object.freeze({
  account_merges: [Object.freeze({ id: "60000000-0000-4000-8000-000000000001", source_account_id: ACCOUNT, target_account_id: ACCOUNT, verified_steam_id: "76561198000000001", merge_mode: "promoted", created_at: "2026-07-01 00:00:00+00", analytics_delivered_at: "2026-07-01 00:01:00+00" })],
  algorithm_weights: [Object.freeze({ key: "genre_affinity", positive: "12", total: "20", note: "synthetic tuning", updated_at: "2026-07-01 00:00:00+00" })],
  api_rate_limits: [Object.freeze({ bucket: "contact_form", key_hash: "bb".repeat(32), window_started_at: "2026-09-10 12:00:00+00", request_count: "4", updated_at: "2026-09-10 12:30:00+00" })],
  app_accounts: [
    Object.freeze({ id: ACCOUNT, account_type: "steam", steam_library_visible: "t", steam_playtime_visible: "f", steam_last_played_visible: null, steam_visibility_checked_at: "2026-09-10 10:00:00.123456+00", steam_games_seen: "1", created_at: "2026-01-01 00:00:00.000001+00", updated_at: "2026-09-10 00:00:10+00", last_visited_at: "2026-09-10 00:00:00.000010+00" }),
    Object.freeze({ id: MANUAL_ACCOUNT, account_type: "manual", steam_library_visible: null, steam_playtime_visible: null, steam_last_played_visible: null, steam_visibility_checked_at: null, steam_games_seen: null, created_at: "2026-01-02 00:00:00+00", updated_at: "2026-09-10 00:00:10+00", last_visited_at: null }),
  ],
  app_settings: [Object.freeze({ id: "61000000-0000-4000-8000-000000000001", user_id: ACCOUNT, key: "theme", value: "dark", created_at: "2026-01-01 00:00:00+00", updated_at: "2026-02-01 00:00:00+00" })],
  app_users: [Object.freeze({ id: ACCOUNT, steam_id: "76561198000000001", display_name: "Synthetic Steam user", avatar_url: null, created_at: "2026-01-01 00:00:00.000001+00", updated_at: "2026-09-10 00:00:03+00", last_login_at: "2026-09-10 00:00:00.000001+00", steam_library_visible: "t", steam_playtime_visible: "f", steam_last_played_visible: null, steam_visibility_checked_at: "2026-09-09 10:00:00.123456+00", steam_games_seen: "1" })],
  catalog_duration_import_runs: [Object.freeze({ id: "62000000-0000-4000-8000-000000000001", source: "hltb_bulk_export", imported_count: "1", skipped_count: "0", source_updated_at: "2026-08-31 00:00:00+00", created_at: "2026-09-01 00:00:00+00", source_sha256: "cc".repeat(32), expected_app_count: "1", staged_row_count: "1", status: "succeeded", completed_at: "2026-09-01 01:00:00+00", manifest: '{"files":["synthetic.csv"]}' })],
  catalog_duration_review_queue: [Object.freeze({ steam_appid: "440" })],
  catalog_duration_reviews: [Object.freeze({ steam_appid: "440", response_text: "Corrected duration from the synthetic fixture.", response_kind: "hltb_url", source_url: "https://howlongtobeat.com/game/440", reviewer_user_id: ACCOUNT, reviewed_at: "2026-08-01 00:00:00+00", updated_at: "2026-08-02 00:00:00+00" })],
  catalog_game_quarantine: [Object.freeze({ steam_appid: "440", name: "Team Fortress 2", steam_type: "game", matched_rule: "synthetic_review", reason: "Synthetic quarantine evidence.", genres: "{Action}", categories: "{Multi-player}", review_status: "allowed", source: "manual", first_detected_at: "2026-07-01 00:00:00+00", last_detected_at: "2026-07-02 00:00:00+00", reviewed_at: "2026-07-03 00:00:00+00", review_notes: "Synthetic approval.", updated_at: "2026-07-03 00:00:00+00" })],
  catalog_game_sightings: [Object.freeze({ steam_appid: "440", import_count: "37", first_seen_at: "2026-01-02 03:04:05.000006+00", last_seen_at: "2026-09-01 00:00:00+00" })],
  catalog_games: [catalogGame],
  catalog_ingest_queue: [Object.freeze({ steam_appid: "440", status: "rejected", reason: "manual", priority: "50", requested_count: "3", source_rank: "1", source_payload: '{"raw":"synthetic"}', attempts: "2", next_attempt_at: null, processing_started_at: null, last_error: "rate limited", rejection_reason: "synthetic terminal decision", first_requested_at: "2026-01-01 00:00:00+00", last_requested_at: "2026-01-02 00:00:00+00", processed_at: "2026-01-02 00:00:00+00", updated_at: "2026-01-02 00:00:00+00" })],
  catalog_seed_runs: [Object.freeze({ id: "63000000-0000-4000-8000-000000000001", source: "steamspy", metric: "owners", captured_at: "2026-01-01", requested_count: "1", accepted_count: "1", source_url: "https://steamspy.com/api.php", source_sha256: "aa".repeat(32), created_at: "2026-01-01 00:00:00+00" })],
  collection_games: [Object.freeze({ collection_id: COLLECTION, game_id: LIBRARY, notes: null, position: "0", created_at: "2026-03-01 00:00:00+00" })],
  collections: [Object.freeze({ id: COLLECTION, user_id: ACCOUNT, name: "Weekend picks", description: "Synthetic collection", created_at: "2026-02-01 00:00:00+00", updated_at: "2026-02-02 00:00:00+00", kind: "custom", rules: "{}" })],
  completion_events: [Object.freeze({ id: "64000000-0000-4000-8000-000000000001", user_id: ACCOUNT, game_id: LIBRARY, steam_appid: "440", source: "sweep", claimed_at: "2026-02-01 00:00:00+00", undone_at: null, hours_played: null, estimate_minutes: null, price_cents: null })],
  contact_messages: [Object.freeze({ id: "65000000-0000-4000-8000-000000000001", user_id: ACCOUNT, enquiry_type: "2", email: "fixture@example.test", subject: "  Synthetic support request  ", message: "  This synthetic support message is long enough to retain exactly.  ", dedupe_hash: "dd".repeat(32), status: "0", created_at: "2026-05-01 10:00:00+00", updated_at: "2026-05-02 10:00:00+00" })],
  feedback_submissions: [Object.freeze({ id: "66000000-0000-4000-8000-000000000001", user_id: ACCOUNT, feedback_type: "1", message: "The synthetic vault picker response was useful today.", contact_allowed: "f", contact_email: null, route: "/vault", app_area: "vault", client_context: '{"viewport":"390x844"}', dedupe_hash: "ee".repeat(32), status: "0", created_at: "2026-06-01 09:00:00+00" })],
  game_duration_aliases: [Object.freeze({ steam_app_id: "440", search_title: "Team Fortress 2 Classic", release_year: "2007", review_status: "approved", notes: "Synthetic alias evidence.", created_at: "2026-01-01 00:00:00+00", updated_at: "2026-01-01 00:00:00+00" })],
  game_duration_estimates: [Object.freeze({ steam_app_id: "440", provider: "hltb", provider_game_id: "12345", main_story_minutes: "600", main_extra_minutes: "900", completionist_minutes: "1200", submission_count: "50", match_status: "matched", match_confidence: "high", provider_updated_at: "2026-01-01 00:00:00+00", checked_at: "2026-01-02 00:00:00+00", next_refresh_at: "2026-12-01 00:00:00+00", last_error_code: null, created_at: "2026-01-01 00:00:00+00", updated_at: "2026-01-02 00:00:00+00", evidence: '{"raw":"synthetic"}' })],
  game_duration_jobs: [Object.freeze({ steam_app_id: "440", status: "failed", priority: "10", attempts: "5", next_attempt_at: "2026-12-02 00:00:00+00", locked_at: null, locked_by: null, last_error_code: "provider_timeout", last_error_message: "Synthetic provider timeout.", created_at: "2026-01-01 00:00:00+00", updated_at: "2026-01-02 00:00:00+00" })],
  game_preference_globals: [Object.freeze({ steam_appid: "440", positive: "5", total: "9", updated_at: "2026-08-01 00:00:00+00", total_hours: "12.5" })],
  genre_preference_globals: [Object.freeze({ genre: "Action", context_mood: "chill", positive: "4", total: "8", updated_at: "2026-08-01 00:00:00+00" })],
  guest_catalogue_pool: [Object.freeze({ steam_appid: "440", position: "1", refreshed_at: "2026-09-01 00:00:00+00" })],
  manual_profile_security_intents: [Object.freeze({ id: "67000000-0000-4000-8000-000000000001", source_account_id: MANUAL_ACCOUNT, source_manual_session_id: MANUAL_SESSION, token_hash: "ff".repeat(32), created_at: "2026-08-01 00:00:00+00", expires_at: "2026-08-01 00:10:00+00", consumed_at: null, target_account_id: null, verified_steam_id: null, openid_response_nonce: null, outcome: null })],
  manual_profile_sessions: [Object.freeze({ id: MANUAL_SESSION, profile_id: MANUAL_ACCOUNT, token_hash: "11".repeat(32), created_at: "2026-09-10 10:00:00+00", last_seen_at: "2026-09-10 10:00:01+00", expires_at: "2026-09-11 10:00:00+00" })],
  manual_steam_profiles: [Object.freeze({ id: MANUAL_ACCOUNT, steam_id: "76561198000000002", steam_profile_url: "https://steamcommunity.com/profiles/76561198000000002", display_name: "Synthetic manual profile", steam_display_name: "Synthetic Steam profile", avatar_url: null, created_at: "2026-01-02 00:00:00+00", updated_at: "2026-09-10 00:00:00+00" })],
  metadata_worker_runs: [Object.freeze({ id: "68000000-0000-4000-8000-000000000001", worker_name: "nightly-metadata", status: "succeeded", started_at: "2026-09-01 02:00:00+00", finished_at: "2026-09-01 02:05:00+00", duration_ms: "300000", counts: '{"fetched":1}', summary: '{"note":"synthetic"}', error_message: null })],
  purge_reviews: [Object.freeze({ id: "69000000-0000-4000-8000-000000000001", user_id: ACCOUNT, game_id: LIBRARY, action: "keep", reviewed_at: "2026-02-05 00:00:00+00", playtime_minutes_at_review: "90", progress_at_review: "0", last_played_at_review: "2026-02-04 00:00:00+00" })],
  sessions: [Object.freeze({ id: SESSION, user_id: ACCOUNT, token_hash: "aa".repeat(32), created_at: "2026-09-10 10:00:00.123456+00", last_seen_at: "2026-09-10 10:00:00.123457+00", expires_at: "2026-09-11 10:00:00.123456+00" })],
  steam_import_jobs: [Object.freeze({ user_id: ACCOUNT, status: "complete", total_games: "1", imported_games: "1", games: '[{"appid":440}]', play_history_missing: "f", last_error: null, started_at: "2026-09-01 00:00:00+00", updated_at: "2026-09-01 00:10:00+00", completed_at: "2026-09-01 00:10:00+00", processing_token: null, processing_started_at: null })],
  user_family_members: [Object.freeze({ id: "70000000-0000-4000-8000-000000000001", user_id: ACCOUNT, steam_id: "76561198000000042", display_name: "Synthetic lender", avatar_url: null, profile_url: "https://steamcommunity.com/profiles/76561198000000042", candidate_appids: "{440}", library_seen: "1", games_imported: "0", last_synced_at: "2026-02-01 00:00:00+00", last_error: null, created_at: "2026-01-01 00:00:00+00", updated_at: "2026-01-02 00:00:00+00" })],
  user_game_pins: [Object.freeze({ user_id: ACCOUNT, game_id: LIBRARY, slot: "1", pinned_at: "2026-03-04 05:06:07.008009+00", scope: "library", hours_at_pin: "1.5" })],
  user_game_snoozes: [Object.freeze({ user_id: ACCOUNT, game_id: LIBRARY, snoozed_at: "2026-03-04 05:06:07+00", snoozed_until: "2026-04-04 05:06:07+00" })],
  user_game_state: [Object.freeze({ user_id: ACCOUNT, appid: "440", completed_at: null, slept_at: "2026-02-01 01:00:00+00", prev_active_status: null, dismissed_at: null, dismissed_playtime: null, review_requested_at: null, last_played_at: "2026-01-31 23:00:00+00", last_observed_played_at: "2026-02-01 00:00:00.000123+00", recency_source: null, recency_evidence_at: "2026-02-01 00:00:00.000123+00", family_owner_steam_id: null, family_verified_at: null })],
  user_games: [Object.freeze({ id: LIBRARY, user_id: ACCOUNT, ownership: "Owned", status: "Slept", hours_played: "1.5", completion_percentage: "0", date_added: null, notes: "  preserved synthetic note  ", created_at: "2026-01-02 03:04:05+00", updated_at: "2026-01-02 03:04:06+00", last_played_at: "2026-01-31 23:00:00+00", completed_at: null, slept_at: "2026-02-01 01:00:00+00", completion_suggestion_dismissed_at: null, completion_suggestion_dismissed_playtime: null, previous_active_status: null, catalog_steam_appid: "440", last_observed_played_at: "2026-02-01 00:00:00.000123+00", recency_source: "steam_exact", recency_evidence_at: "2026-02-01 00:00:00.000123+00", observed_playtime_minutes: "90", review_requested_at: null, access_source: "owned", family_owner_steam_id: null, family_verified_at: null })],
  user_games_with_catalog: [Object.freeze({ id: LIBRARY, user_id: ACCOUNT, steam_appid: "440", catalog_steam_appid: "440" })],
  user_genre_preferences: [Object.freeze({ user_id: ACCOUNT, genre: "Action", context_mood: "chill", positive: "3", total: "7", updated_at: "2026-08-01 12:00:00.000123+00" })],
  user_playtime_snapshots: [Object.freeze({ user_id: ACCOUNT, captured_on: "2026-02-01", total_minutes: "90", games_with_playtime: "1", created_at: "2026-02-01 23:59:59.999999+00" })],
  user_vault_state: [Object.freeze({ user_id: ACCOUNT, current_game_id: LIBRARY, updated_at: "2026-03-04 05:06:07+00" })],
  vault_draw_events: [Object.freeze({ id: "71000000-0000-4000-8000-000000000001", user_id: ACCOUNT, draw_id: DRAW, event_type: "opened_on_steam", created_at: "2026-03-04 05:07:00+00" })],
  vault_draws: [Object.freeze({ id: DRAW, user_id: ACCOUNT, steam_appid: "440", drawn_at: "2026-03-04 05:06:07.008009+00", session: "evening", mood: "chill", goal: "new", collection_id: COLLECTION, selected_genres: "{Action}", eligible_pool_count: "1", reroll_index: "0", finalist_appids: "{440}" })],
  vault_events: [Object.freeze({ id: "72000000-0000-4000-8000-000000000001", user_id: ACCOUNT, game_id: LIBRARY, action: "pinned", context: "{}", created_at: "2026-03-04 05:08:00+00" })],
});

before(async () => { root = await mkdtemp(join(tmpdir(), "vs-all-loader-")); await chmod(root, 0o700); });
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function fixtureRun(): Promise<{ directory: string; expectations: ReaderExpectations }> {
  const directory = join(root, "run");
  await mkdir(join(directory, "relations"), { recursive: true, mode: 0o700 });
  const evidence: ManifestRelation[] = [];
  const expectedRelations: { schema: string; name: string; columns: string[] }[] = [];
  for (const relation of ALL_SOURCE_RELATIONS) {
    const columns = columnsByRelation.get(relation);
    assert.ok(columns, relation);
    const records = sourceRows[relation] ?? [];
    const bytes = copyBytes(columns, records);
    await writeFile(join(directory, "relations", `public.${relation}.copy`), bytes, { mode: 0o600 });
    evidence.push({ schema: "public", name: relation, rowsReportedByServer: records.length, rowsCountedOnWire: records.length, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), columns: [...columns], durationMs: 0, file: `relations/public.${relation}.copy` });
    expectedRelations.push({ schema: "public", name: relation, columns: [...columns] });
  }
  const manifest = buildManifest({ runId: "all-domain-fixture", codeRevision: null, profile: { label: "all-domain synthetic fixture", transport: "unix-socket", host: TARGET.socketDirectory, port: TARGET.port, database: "synthetic", user: TARGET.user }, tlsProtocol: null, identity: { currentDatabase: "synthetic", currentUser: TARGET.user, sessionUser: TARGET.user, serverVersion: "PostgreSQL 17.6", serverVersionNum: 170006, systemIdentifier: null, inRecovery: false, schemasPresent: ["public"], transactionIsolation: "repeatable read", transactionReadOnly: "on", projectRef: null }, watermark: { snapshotXmin: "100", currentSnapshot: "100:200:", walLsn: null, statementStartUtc: "2026-09-12T00:00:00.000Z", transactionStartUtc: "2026-09-12T00:00:00.000Z", backendPid: "123" }, closingSnapshot: "100:200:", sessionSettings: { TimeZone: "UTC", DateStyle: "ISO, YMD", IntervalStyle: "iso_8601", extra_float_digits: "3", bytea_output: "hex", client_encoding: "UTF8", synchronize_seqscans: "off" }, rowSecurity: { setting: "off", settingAtClose: "off", roleIsSuperuser: true, roleBypassesRowSecurity: true }, walLsnAvailable: false, relations: evidence, runDirectoryMode: "0700", fileMode: "0600", insideGitWorktree: null, startedUtc: "2026-09-12T00:00:00.000Z", finishedUtc: "2026-09-12T00:00:00.001Z", durationMs: 1 });
  const serialized = serializeManifest(manifest);
  await writeFile(join(directory, "manifest.json"), serialized.text, { mode: 0o600 });
  await writeFile(join(directory, "manifest.sha256"), `${serialized.sha256}  manifest.json\n`, { mode: 0o600 });
  return { directory, expectations: { source: { kind: "synthetic-fixture", database: "synthetic", user: TARGET.user, label: "all-domain synthetic fixture" }, relations: expectedRelations } };
}

function assembleFixture(staged: StagedRun) {
  const assembled = assembleAllDomains(staged, { runId: "all-domain-fixture", snapshotHash: SNAPSHOT }, DOMAIN_EVIDENCE);
  // Support content deliberately emits one real policy blocker. This
  // fixture-only waiver exercises its physical adapter; production callers
  // receive the blocker unchanged and cannot publish without the decision.
  assert.equal(assembled.blockers, 1);
  return Object.freeze({ ...assembled, blockers: 0 });
}

test("all 44 verified source relations feed one nonempty all-domain transaction", async () => {
  const fixture = await fixtureRun();
  const verified = await inspectRun(fixture.directory, fixture.expectations);
  const preflight = await stageVerifiedRun(verified, ALL_SOURCE_RELATIONS.map((relation) => `public.${relation}`), join(root, "preflight-stage"));
  try {
    const assembled = assembleFixture(preflight);
    assert.deepEqual(assembled.sourceAccounting.filter((entry) => entry.sourceRows === 0).map((entry) => entry.relation), []);
    assert.ok(assembled.batches.length > 40);
    for (const batch of assembled.batches) {
      const physical = destinationIndex.relations[batch.relation];
      assert.ok(physical, `missing physical relation ${batch.relation}`);
      const allowed = new Set(physical.columns);
      for (const row of batch.rows) {
        assert.deepEqual(Object.keys(row).filter((column) => !allowed.has(column)), [], `${batch.relation} adapter columns`);
      }
    }
  } finally {
    preflight.destroy();
  }
  sql(`truncate app.accounts cascade; truncate catalog.games cascade; truncate reco.warm_start_snapshots cascade; truncate support.retention_policy_decisions cascade; truncate migration.runs cascade;`);
  const result = await runLoaderPipeline({
    run: { runId: RUN_ID, snapshotKey: "all-domain-fixture", snapshotHash: SNAPSHOT }, verifiedRun: verified,
    sourceRelations: ALL_SOURCE_RELATIONS.map((relation) => `public.${relation}`), sourceRelationsExpected: 44,
    stagingDirectory: join(root, "stage"), target: TARGET,
    transform: assembleFixture,
    manifestFingerprint: "6b".repeat(32), expectedSchemaFingerprint: EXPECTED_SCHEMA_FINGERPRINT,
    schemaRelations: ALL_TARGET_RELATIONS, specsForBatches: (batches) => discoverLocalTargetSpecs(TARGET, batches),
    snapshotDecisions: { cutover_observation: true, import_freeze_accounts: true },
    instants: { startedAt: "2026-09-12T00:00:00.000Z", finishedAt: "2026-09-12T00:05:00.000Z" },
  });
  assert.equal(result.published, true);
  assert.equal(sql("select count(*) from migration.relation_counts;"), "44");
  assert.equal(sql("select count(*) from migration.relation_counts where source_rows > 0;"), "44");
  assert.equal(sql("select count(*) from app.accounts;"), "2");
  assert.equal(sql("select count(*) from app.sessions;"), "2");
  assert.equal(sql("select count(*) from app.steam_profiles;"), "2");
  assert.equal(sql("select blacklisted::text from app.game_state;"), "true");
  assert.equal(sql("select playtime_minutes::text from app.library_games;"), "90");
  assert.equal(sql("select encode(source_snapshot_hash,'hex') from migration.library_row_map;"), SNAPSHOT);
  assert.equal(sql("select count(*) from app.collections;"), "1");
  assert.equal(sql("select count(*) from app.collection_games;"), "1");
  assert.equal(sql("select count(*) from app.pins;"), "1");
  assert.equal(sql("select count(*) from app.snoozes;"), "1");
  assert.equal(sql("select count(*) from app.vault_draws;"), "1");
  assert.equal(sql("select count(*) from app.vault_draw_events;"), "1");
  assert.equal(sql("select count(*) from app.vault_events;"), "1");
  assert.equal(sql("select count(*) from app.family_members;"), "1");
  assert.equal(sql("select count(*) from app.playtime_daily;"), "1");
  assert.equal(sql("select count(*) from app.completion_events;"), "1");
  assert.equal(sql("select count(*) from app.purge_review_history;"), "1");
  assert.equal(sql("select count(*) from migration.legacy_user_game_state_audit;"), "1");
  assert.equal(sql("select count(*) from catalog.duration_estimates;"), "1");
  assert.equal(sql("select count(*) from catalog.duration_aliases;"), "1");
  assert.equal(sql("select count(*) from catalog.duration_imports;"), "1");
  assert.equal(sql("select count(*) from migration.legacy_duration_job_archive;"), "1");
  assert.equal(sql("select count(*) from migration.legacy_ingest_queue_archive;"), "1");
  assert.equal(sql("select count(*) from catalog.provider_state;"), "3");
  assert.equal(sql("select count(*) from catalog.review_decisions;"), "3");
  assert.equal(sql("select count(*) from catalog.seed_runs;"), "1");
  assert.equal(sql("select count(*) from catalog.game_sightings;"), "1");
  assert.equal(sql("select count(*) from reco.user_genre_preferences;"), "1");
  assert.equal(sql("select count(*) from reco.genre_preference_globals;"), "1");
  assert.equal(sql("select count(*) from reco.game_preference_globals;"), "1");
  assert.equal(sql("select count(*) from reco.operator_weight_versions;"), "1");
  assert.equal(sql("select count(*) from app.account_preferences;"), "1");
  assert.equal(sql("select count(*) from support.contact_messages;"), "1");
  assert.equal(sql("select count(*) from support.feedback_submissions;"), "1");
  assert.equal(sql("select count(*) from ops.legacy_worker_runs;"), "1");
  assert.equal(sql("select count(*) from migration.legacy_import_freeze_report;"), "1");
  assert.equal(sql("select count(*) from ops.abuse_cooldowns;"), "1");
  assert.equal(sql("select count(*) from ops.account_merges;"), "1");
  assert.equal(sql("select count(*) from migration.legacy_auth_intent_audit;"), "1");
});
