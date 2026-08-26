import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHltbWritebackDirectoryArtifacts,
  buildHltbWritebackSql,
  normalizeValidatorDocument,
} from "./build-hltb-writeback-sql.mjs";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "build-hltb-writeback-sql.mjs"
);
const temporaryDirectories = [];

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function resultRow(overrides = {}) {
  return {
    steam_appid: 100,
    steam_app_id: 100,
    provider: "hltb",
    provider_game_id: 200,
    status: "verified_matched",
    verification_status: "verified_matched",
    match_status: "matched",
    verification_method: "profile_steam_exact",
    verification_tier: "steam_appid",
    identity_tier: "steam_appid",
    identity_confidence: "high",
    duration_basis: "completion_times",
    duration_issues: [],
    hltb_modes: { single_player: true, co_op: false, multiplayer: false },
    main_story_minutes: 600,
    main_extra_minutes: 900,
    completionist_minutes: 1200,
    submission_count: 20,
    match_confidence: "high",
    provider_updated_at: null,
    checked_at: "2026-08-25T12:00:00.000Z",
    next_refresh_at: null,
    last_error_code: null,
    updated_at: "2026-08-25T12:00:00.000Z",
    source_titles: ["Fixture Game"],
    source_rows: 1,
    ...overrides,
  };
}

function noDurationRow(overrides = {}) {
  return resultRow({
    steam_appid: 101,
    steam_app_id: 101,
    provider_game_id: 201,
    status: "verified_no_duration",
    verification_status: "verified_no_duration",
    match_status: "no_duration",
    duration_basis: "no_duration",
    main_story_minutes: null,
    main_extra_minutes: null,
    completionist_minutes: null,
    match_confidence: "high",
    next_refresh_at: "2026-11-23T12:00:00.000Z",
    last_error_code: "known_title_no_provider_times",
    ...overrides,
  });
}

function validatorDocument({ results = [], rejections = [], errors = [], overrides = {} } = {}) {
  return {
    schema_version: 1,
    source: "HLTB candidates verified against detail-page identity evidence",
    state: "complete",
    started_at: "2026-08-25T11:00:00.000Z",
    updated_at: "2026-08-25T13:00:00.000Z",
    options: { include_matched: true, allow_safe_title: true },
    counts: {
      unique_detail_pages: results.length + rejections.length,
      completed_detail_pages: results.length + rejections.length,
      verified_matched: results.filter((row) => row.verification_status === "verified_matched").length,
      verified_no_duration: results.filter((row) => row.verification_status === "verified_no_duration").length,
      rejections: rejections.length,
      errors: errors.length,
    },
    results,
    rejections,
    errors,
    ...overrides,
  };
}

test("accepts only a completed schema-v1 validator document", () => {
  const running = validatorDocument({
    results: [resultRow()],
    overrides: { state: "running" },
  });
  assert.throws(
    () => buildHltbWritebackSql(running),
    /not a completed HLTB validator report/
  );

  const wrongSchema = validatorDocument({
    results: [resultRow()],
    overrides: { schema_version: 2 },
  });
  assert.throws(() => buildHltbWritebackSql(wrongSchema), /schema-v1/);
});

test("stages exact identity, duration-basis, and mode evidence", () => {
  const safe = resultRow({
    steam_appid: 99,
    steam_app_id: 99,
    provider_game_id: 199,
    verification_method: "safe_exact_title",
    verification_tier: "mixed_script_title",
    identity_tier: "mixed_script_title",
    identity_confidence: "medium",
    match_confidence: "medium",
    verified_source_title: "English Fixture",
    source_titles: ["English Fixture", "English Fixture 非英文"],
    hltb_modes: { single_player: false, co_op: true, multiplayer: true },
  });
  const sql = buildHltbWritebackSql(
    validatorDocument({ results: [noDurationRow(), safe, resultRow()] }),
    { sourceName: "fixture.json" }
  );

  assert.match(sql, /begin isolation level read committed;/);
  assert.match(sql, /set local lock_timeout = '5s';/);
  assert.match(sql, /set local statement_timeout = '60s';/);
  assert.equal((sql.match(/pg_try_advisory_lock/g) ?? []).length, 1);
  assert.match(sql, /"verification_method":"safe_exact_title"/);
  assert.match(sql, /"verification_tier":"mixed_script_title"/);
  assert.match(sql, /"duration_basis":"completion_times"/);
  assert.match(sql, /"mode_co_op":true/);
  assert.match(sql, /"evidence":\{"identity_validated":true/);
  assert.match(sql, /"verification_source":"detail_page_validator"/);
  assert.ok(sql.indexOf('"steam_app_id":99') < sql.indexOf('"steam_app_id":100'));
  assert.ok(sql.indexOf('"steam_app_id":100') < sql.indexOf('"steam_app_id":101'));
});

test("persists exact validator evidence in matched and no-duration upserts", () => {
  const document = validatorDocument({ results: [resultRow(), noDurationRow()] });
  const normalized = normalizeValidatorDocument(document);
  assert.deepEqual(normalized.stageRows[0].evidence, {
    identity_validated: true,
    identity_tier: "steam_appid",
    identity_confidence: "high",
    duration_basis: "completion_times",
    duration_issues: [],
    hltb_modes: { single_player: true, co_op: false, multiplayer: false },
    verification_method: "profile_steam_exact",
    verification_tier: "steam_appid",
    verification_source: "detail_page_validator",
  });

  const sql = buildHltbWritebackSql(document);
  const matchedUpsert = sql.slice(
    sql.indexOf("insert into public.game_duration_estimates as current ("),
    sql.indexOf("'matched_estimates_changed'")
  );
  const noDurationStart = sql.indexOf(
    "insert into public.game_duration_estimates as current (",
    sql.indexOf("'matched_estimates_changed'")
  );
  const noDurationUpsert = sql.slice(noDurationStart, sql.indexOf("'no_duration_estimates_changed'"));

  for (const upsert of [matchedUpsert, noDurationUpsert]) {
    assert.match(upsert, /last_error_code, evidence, updated_at/);
    assert.match(upsert, /evidence = excluded\.evidence/);
    assert.match(upsert, /current\.evidence/);
    assert.match(upsert, /excluded\.evidence/);
  }
  assert.match(sql, /evidence = jsonb_build_object\(/);
});

test("generated no-duration SQL cannot replace identity or erase raw values", () => {
  const sql = buildHltbWritebackSql(validatorDocument({ results: [noDurationRow()] }));
  const noDurationUpsert = sql.slice(
    sql.indexOf("'no_duration', stage.match_confidence"),
    sql.indexOf("with affected as (")
  );

  assert.doesNotMatch(noDurationUpsert, /set provider_game_id\s*=/);
  assert.match(noDurationUpsert, /current\.provider_game_id = excluded\.provider_game_id/);
  assert.match(noDurationUpsert, /current\.match_status <> 'matched'/);
  assert.match(noDurationUpsert, /current\.main_story_minutes is null/);
  assert.match(sql, /no_duration_conflicts_demoted/);
  assert.match(sql, /is distinct from row\(/g);
});

test("job completion requires a hardened post-trigger catalogue resolution", () => {
  const document = validatorDocument({ results: [resultRow()] });
  const sql = buildHltbWritebackSql(document);
  const jobSection = sql.slice(sql.lastIndexOf("with affected as ("));

  assert.match(jobSection, /hardened_finite_catalogue as \(/);
  assert.match(jobSection, /game\.duration_status = 'ready'/);
  assert.match(jobSection, /game\.duration_kind = 'finite'/);
  assert.match(jobSection, /estimate\.evidence @> '\{"identity_validated": true\}'::jsonb/);
  assert.match(jobSection, /estimate\.provider = 'hltb'/);
  assert.match(jobSection, /estimate\.provider = 'igdb'/);
  assert.match(jobSection, /estimate\.match_confidence = 'low'/);
  assert.match(jobSection, /estimate\.evidence ->> 'duration_basis' = 'completion_times'/);
  assert.match(jobSection, /estimate\.evidence -> 'duration_issues' = '\[\]'::jsonb/);
  assert.match(jobSection, /coalesce\(estimate\.submission_count, 0\) >= 2/);
  assert.match(jobSection, /estimate\.provider = 'igdb'[\s\S]*estimate\.match_confidence = 'low'/);
  assert.match(jobSection, /coalesce\(estimate\.submission_count, 0\) between 2 and 4/);
  assert.doesNotMatch(jobSection, /'igdb-parent'|'igdb-title'/);
  assert.match(jobSection, /game\.duration_manual_override/);
  assert.match(jobSection, /hardened\.steam_app_id is not null/);
  assert.doesNotMatch(jobSection, /acceptable_estimates/);

  const finalize = buildHltbWritebackDirectoryArtifacts(document).files.at(-1).content;
  assert.match(finalize, /hardened_finite_catalogue as \(/);
  assert.match(finalize, /unhardened_hltb_projected_ready/);
  assert.doesNotMatch(finalize, /'igdb-parent'|'igdb-title'|acceptable_estimates/);
});

test("rejections demote status while errors and input-only failures cause no action", () => {
  const document = validatorDocument({
    rejections: [
      {
        steam_appid: 300,
        provider_game_id: 400,
        status: "rejected",
        reason: "profile_steam_mismatch",
      },
      {
        steam_appid: 301,
        provider_game_id: 401,
        status: "rejected",
        reason: "no_authoritative_source_title",
      },
    ],
    errors: [{ type: "detail_page_error", provider_game_id: 999 }],
  });
  const normalized = normalizeValidatorDocument(document);
  assert.deepEqual(
    normalized.stageRows.map((row) => [row.steam_app_id, row.action, row.demotion_reason]),
    [[300, "demote", "profile_steam_mismatch"]]
  );
  assert.equal(normalized.errorCount, 1);
  assert.equal(normalized.inputOnlyRejectionCount, 1);

  const sql = buildHltbWritebackSql(document);
  assert.match(sql, /set match_status = 'ambiguous',/);
  assert.match(sql, /match_confidence = 'none'/);
  assert.match(sql, /estimate\.provider_game_id = stage\.provider_game_id/);
  assert.match(sql, /validator_errors_ignored', 1/);
  assert.doesNotMatch(sql, /"steam_app_id":301/);
  assert.doesNotMatch(sql, /999/);
});

test("batches by sorted Steam AppID and keeps conflicting IDs together", () => {
  const rejections = [
    {
      steam_appid: 30,
      status: "rejected",
      reason: "conflicting_hltb_ids",
      candidate_game_ids: [302, 301],
    },
  ];
  const results = [
    resultRow({ steam_appid: 20, steam_app_id: 20, provider_game_id: 220 }),
    resultRow({ steam_appid: 10, steam_app_id: 10, provider_game_id: 210 }),
  ];
  const sql = buildHltbWritebackSql(
    validatorDocument({ results, rejections }),
    { batchSize: 1 }
  );
  assert.equal((sql.match(/begin isolation level read committed;/g) ?? []).length, 3);
  assert.match(sql, /Batch 3: 1 Steam AppIDs \/ 2 staged actions/);
  assert.ok(sql.indexOf('"steam_app_id":10') < sql.indexOf('"steam_app_id":20'));
  assert.ok(sql.indexOf('"provider_game_id":301') < sql.indexOf('"provider_game_id":302'));
});

test("rejects forged safe-title evidence and incoherent durations", () => {
  const forged = resultRow({
    verification_method: "safe_exact_title",
    verification_tier: "exact_title",
    identity_tier: "exact_title",
    verified_source_title: "Missing From Sources",
  });
  assert.throws(
    () => buildHltbWritebackSql(validatorDocument({ results: [forged] })),
    /missing its verified authoritative source title/
  );

  const malformed = resultRow({ completionist_minutes: 20_000 });
  assert.throws(
    () => buildHltbWritebackSql(validatorDocument({ results: [malformed] })),
    /extreme completionist ratio/
  );
});

test("CLI writes SQL and reports ignored validator errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vaultshuffle-hltb-writeback-"));
  temporaryDirectories.push(directory);
  const inputPath = path.join(directory, "validator.json");
  const outputPath = path.join(directory, "writeback.sql");
  await writeFile(
    inputPath,
    `${JSON.stringify(validatorDocument({ results: [resultRow()], errors: [{ type: "input_error" }] }))}\n`,
    "utf8"
  );
  const run = spawnSync(
    process.execPath,
    [scriptPath, inputPath, "--output", outputPath, "--batch-size", "100"],
    { encoding: "utf8" }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(await readFile(outputPath, "utf8"), /matched_estimates_changed/);
  assert.equal(JSON.parse(run.stdout).validator_errors_ignored, 1);
});

test("directory artifacts are deterministic standalone batches with exact hashes", () => {
  const document = validatorDocument({
    results: [
      resultRow({ steam_appid: 20, steam_app_id: 20, provider_game_id: 220 }),
      resultRow({ steam_appid: 10, steam_app_id: 10, provider_game_id: 210 }),
      noDurationRow({ steam_appid: 30, steam_app_id: 30, provider_game_id: 230 }),
    ],
  });
  const first = buildHltbWritebackDirectoryArtifacts(document, {
    batchSize: 1,
    sourceName: "validator.json",
    sourceSha256: "a".repeat(64),
  });
  const second = buildHltbWritebackDirectoryArtifacts(document, {
    batchSize: 1,
    sourceName: "validator.json",
    sourceSha256: "a".repeat(64),
  });

  assert.deepEqual(first, second);
  assert.equal(first.manifest.batch_count, 3);
  assert.equal(first.manifest.staged_app_count, 3);
  assert.equal(first.manifest.staged_row_count, 3);
  assert.deepEqual(
    first.files.map((file) => file.name),
    ["setup.sql", "batch-0001.sql", "batch-0002.sql", "batch-0003.sql", "finalize.sql"]
  );
  for (const file of first.files) {
    assert.equal(
      file.sha256,
      createHash("sha256").update(file.content).digest("hex")
    );
  }
  for (const batch of first.files.filter((file) => file.kind === "batch")) {
    assert.match(batch.content, /begin isolation level read committed;/);
    assert.equal((batch.content.match(/pg_advisory_xact_lock/g) ?? []).length, 1);
    assert.doesNotMatch(batch.content, /pg_try_advisory_lock|pg_advisory_unlock/);
    assert.match(batch.content, /commit;\n\nselect coalesce\(/);
    assert.match(batch.content, /is distinct from row\(/);
  }
  assert.doesNotMatch(first.files[0].content, /advisory|create temporary table/i);
  assert.doesNotMatch(first.files.at(-1).content, /\b(insert|update|delete)\b/i);
  assert.match(first.files.at(-1).content, /\[10,20,30\]/);
});

test("directory CLI writes setup, numbered batches, finalize, and a verifiable manifest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vaultshuffle-hltb-writeback-dir-"));
  temporaryDirectories.push(directory);
  const inputPath = path.join(directory, "validator.json");
  const outputDirectory = path.join(directory, "sql");
  const document = validatorDocument({
    results: [resultRow(), noDurationRow()],
  });
  const inputContent = `${JSON.stringify(document)}\n`;
  await writeFile(inputPath, inputContent, "utf8");
  const run = spawnSync(
    process.execPath,
    [scriptPath, inputPath, "--output-directory", outputDirectory, "--batch-size", "1"],
    { encoding: "utf8" }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    (await readdir(outputDirectory)).sort(),
    ["batch-0001.sql", "batch-0002.sql", "finalize.sql", "manifest.json", "setup.sql"]
  );
  const manifest = JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.batch_count, 2);
  assert.equal(manifest.staged_app_count, 2);
  assert.equal(manifest.staged_row_count, 2);
  assert.equal(manifest.replay_safe, true);
  assert.equal(
    manifest.source_sha256,
    createHash("sha256").update(inputContent).digest("hex")
  );
  for (const file of manifest.files) {
    const content = await readFile(path.join(outputDirectory, file.name), "utf8");
    assert.equal(file.sha256, createHash("sha256").update(content).digest("hex"));
  }
  assert.equal(JSON.parse(run.stdout).mode, "standalone_batches");
});

test("directory CLI refuses a non-empty output directory", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vaultshuffle-hltb-writeback-nonempty-"));
  temporaryDirectories.push(directory);
  const inputPath = path.join(directory, "validator.json");
  const outputDirectory = path.join(directory, "sql");
  await writeFile(inputPath, `${JSON.stringify(validatorDocument({ results: [resultRow()] }))}\n`, "utf8");
  await mkdir(outputDirectory);
  await writeFile(path.join(outputDirectory, "old-batch.sql"), "select 1;\n", "utf8");
  const run = spawnSync(
    process.execPath,
    [scriptPath, inputPath, "--output-directory", outputDirectory],
    { encoding: "utf8" }
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /must be empty/);
});
