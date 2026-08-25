import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "consolidate-hltb-reports.mjs"
);
const temporaryDirectories = [];

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function runConsolidator(document) {
  const directory = await mkdtemp(path.join(tmpdir(), "vaultshuffle-hltb-consolidator-"));
  temporaryDirectories.push(directory);
  const inputPath = path.join(directory, "report.json");
  const outputPath = path.join(directory, "consolidated.json");
  await writeFile(inputPath, `${JSON.stringify(document)}\n`, "utf8");
  const run = spawnSync(
    process.execPath,
    [scriptPath, inputPath, "--output", outputPath],
    { encoding: "utf8" }
  );
  const output = run.status === 0
    ? JSON.parse(await readFile(outputPath, "utf8"))
    : null;
  return { ...run, output };
}

function matcherRow(overrides = {}) {
  return {
    steam_appid: 100,
    steam_app_id: 100,
    provider: "hltb",
    provider_game_id: 200,
    title: "Fixture Game",
    matched_title: "Fixture Game",
    main_story_minutes: 600,
    main_extra_minutes: 900,
    completionist_minutes: 1200,
    submission_count: 12,
    match_status: "matched",
    match_confidence: "high",
    identity_tier: "steam_appid",
    identity_confidence: "high",
    duration_basis: "completion_times",
    ...overrides,
  };
}

function validatorReport(rows, overrides = {}) {
  return {
    schema_version: 1,
    source: "HLTB candidates verified against detail-page identity evidence",
    state: "complete",
    options: { include_matched: true, allow_safe_title: true },
    results: rows,
    rejections: [],
    errors: [],
    ...overrides,
  };
}

function validatorSafeRow(method, tier, appid) {
  const title = `Fixture Game ${appid}`;
  return matcherRow({
    steam_appid: appid,
    steam_app_id: appid,
    provider_game_id: appid + 1000,
    title,
    matched_title: title,
    status: "verified_matched",
    verification_status: "verified_matched",
    verification_method: method,
    verification_tier: tier,
    identity_tier: tier,
    identity_confidence: tier === "mixed_script_title" ? "medium" : "high",
    verified_source_title: title,
    source_titles: [title],
    source_rows: 1,
  });
}

test("holds an unvalidated legacy matched row instead of manufacturing identity evidence", async () => {
  const legacy = matcherRow({
    identity_tier: undefined,
    identity_confidence: undefined,
    evidence: { identity_validated: true },
  });
  const run = await runConsolidator([legacy]);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.matched_rows, 0);
  assert.equal(run.output.no_duration_rows, 0);
  assert.equal(run.output.held_unvalidated_rows, 1);
  assert.equal(
    run.output.audit.held_unvalidated[0].reason,
    "missing_identity_verification"
  );
});

test("accepts current matcher direct-AppID matched and no-duration rows", async () => {
  const noDuration = matcherRow({
    steam_appid: 101,
    steam_app_id: 101,
    provider_game_id: 201,
    status: "verified_no_duration",
    match_status: "no_duration",
    main_story_minutes: null,
    main_extra_minutes: null,
    completionist_minutes: null,
    duration_basis: "no_duration",
  });
  const run = await runConsolidator([matcherRow(), noDuration]);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.matched_rows, 1);
  assert.equal(run.output.no_duration_rows, 1);
  assert.equal(run.output.held_unvalidated_rows, 0);
  for (const row of [...run.output.results, ...run.output.no_duration_results]) {
    assert.equal(row.evidence.identity_validated, true);
    assert.equal(row.evidence.verification_method, "profile_steam_exact");
    assert.equal(row.evidence.verification_tier, "steam_appid");
    assert.equal(row.evidence.verification_source, "matcher_identity_tier");
  }
});

test("holds matcher and forged safe-title claims until a validator approves them", async () => {
  const rawSafeTitle = matcherRow({
    identity_tier: "exact_title",
    identity_confidence: "high",
  });
  const forgedSafeTitle = matcherRow({
    steam_appid: 102,
    steam_app_id: 102,
    provider_game_id: 202,
    identity_tier: "exact_title",
    identity_confidence: "high",
    verification_method: "safe_exact_title",
    verification_tier: "exact_title",
    verified_source_title: "Fixture Game",
    source_titles: ["Fixture Game"],
    source_rows: 1,
  });
  const run = await runConsolidator([rawSafeTitle, forgedSafeTitle]);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.matched_rows, 0);
  assert.equal(run.output.held_unvalidated_rows, 2);
  assert.deepEqual(
    run.output.audit.held_unvalidated.map((row) => row.reason),
    [
      "unvalidated_safe_title_identity",
      "safe_title_requires_completed_validator_report",
    ]
  );
});

test("accepts only validator-approved safe-title method/tier pairs", async () => {
  const acceptedPairs = [
    ["safe_exact_title", "exact_title"],
    ["safe_exact_title", "mixed_script_title"],
    ["safe_exact_alias", "exact_title"],
    ["safe_exact_alias", "mixed_script_title"],
  ];
  const rows = acceptedPairs.map(([method, tier], index) =>
    validatorSafeRow(method, tier, 300 + index)
  );
  const run = await runConsolidator(validatorReport(rows));

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.matched_rows, acceptedPairs.length);
  assert.equal(run.output.held_unvalidated_rows, 0);
  assert.deepEqual(
    run.output.results.map((row) => [
      row.evidence.verification_method,
      row.evidence.verification_tier,
    ]),
    acceptedPairs
  );
});

test("holds safe-title rows with missing validator source evidence", async () => {
  const row = validatorSafeRow("safe_exact_title", "exact_title", 400);
  delete row.verified_source_title;
  const run = await runConsolidator(validatorReport([row]));

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output.matched_rows, 0);
  assert.equal(run.output.held_unvalidated_rows, 1);
  assert.equal(
    run.output.audit.held_unvalidated[0].reason,
    "validator_safe_title_missing_source_evidence"
  );
});

test("rejects an incomplete validator report", async () => {
  const run = await runConsolidator(
    validatorReport(
      [validatorSafeRow("safe_exact_title", "exact_title", 500)],
      { state: "running" }
    )
  );

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /not a completed HLTB validator report/);
});
