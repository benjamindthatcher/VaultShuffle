#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALIDATOR_SOURCE =
  "HLTB candidates verified against detail-page identity evidence";

function key(appId, gameId) {
  return `${Number(appId)}:${Number(gameId)}`;
}

function appId(row) {
  return Number(row?.steam_appid ?? row?.steam_app_id);
}

function requireReport(document, label) {
  if (
    !document
    || document.schema_version !== 1
    || document.source !== VALIDATOR_SOURCE
    || document.state !== "complete"
    || !Array.isArray(document.results)
    || !Array.isArray(document.rejections)
    || !Array.isArray(document.errors)
  ) {
    throw new Error(`${label} is not a completed schema-v1 HLTB validator report.`);
  }
}

function coveredPairs(document) {
  const covered = new Set();
  for (const row of document.results) {
    covered.add(key(appId(row), row.provider_game_id));
  }
  for (const row of document.rejections) {
    const ids = row.candidate_game_ids ?? [row.provider_game_id];
    for (const gameId of ids) covered.add(key(appId(row), gameId));
  }
  return covered;
}

function assertUniqueOutcomePerApp(results, rejections) {
  const outcomes = new Map();
  for (const [kind, rows] of [["result", results], ["rejection", rejections]]) {
    for (const row of rows) {
      const id = appId(row);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Invalid ${kind} AppID.`);
      const prior = outcomes.get(id);
      if (prior) throw new Error(`AppID ${id} has both ${prior} and ${kind} outcomes.`);
      outcomes.set(id, kind);
    }
  }
}

function sortResults(rows) {
  return rows.sort((left, right) =>
    appId(left) - appId(right)
    || Number(left.provider_game_id) - Number(right.provider_game_id)
  );
}

function sortRejections(rows) {
  return rows.sort((left, right) =>
    appId(left) - appId(right)
    || String(left.reason ?? "").localeCompare(String(right.reason ?? ""))
  );
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function mergeValidationReports(main, retry, conflicts, provenance = {}) {
  requireReport(main, "main report");
  requireReport(retry, "retry report");
  requireReport(conflicts, "conflict report");
  if (retry.errors.length) throw new Error("Retry report still contains page errors.");
  if (conflicts.errors.length) throw new Error("Conflict report contains page errors.");
  if (conflicts.options?.resolve_conflicts !== true) {
    throw new Error("Conflict report was not produced with --resolve-conflicts.");
  }

  const failedPairs = new Set();
  for (const error of main.errors) {
    for (const id of error.steam_appids ?? []) {
      failedPairs.add(key(id, error.provider_game_id));
    }
  }
  const retryCoverage = coveredPairs(retry);
  for (const pair of failedPairs) {
    if (!retryCoverage.has(pair)) throw new Error(`Retry report did not cover ${pair}.`);
  }

  const conflictRows = main.rejections.filter(
    (row) => row.reason === "conflicting_hltb_ids"
  );
  const expectedConflictApps = new Set(conflictRows.map(appId));
  const resolvedConflictApps = new Set([
    ...conflicts.results.map(appId),
    ...conflicts.rejections.map(appId),
  ]);
  if (
    expectedConflictApps.size !== resolvedConflictApps.size
    || [...expectedConflictApps].some((id) => !resolvedConflictApps.has(id))
  ) {
    throw new Error("Conflict report does not exactly cover main-report conflicts.");
  }

  const results = sortResults([
    ...main.results,
    ...retry.results,
    ...conflicts.results,
  ]);
  const rejections = sortRejections([
    ...main.rejections.filter((row) => row.reason !== "conflicting_hltb_ids"),
    ...retry.rejections,
    ...conflicts.rejections,
  ]);
  assertUniqueOutcomePerApp(results, rejections);

  const verifiedMatched = results.filter(
    (row) => row.verification_status === "verified_matched"
  ).length;
  const verifiedNoDuration = results.filter(
    (row) => row.verification_status === "verified_no_duration"
  ).length;
  const conflictPages = Number(conflicts.counts?.unique_detail_pages ?? 0);
  const detailPages = Number(main.counts?.unique_detail_pages ?? 0) + conflictPages;

  return {
    ...main,
    state: "complete",
    updated_at: new Date().toISOString(),
    options: {
      ...main.options,
      resolve_conflicts: true,
      retry_errors: true,
    },
    counts: {
      ...main.counts,
      conflicting_appids: expectedConflictApps.size,
      conflicting_candidate_pairs:
        Number(main.counts?.conflicting_candidate_pairs ?? 0),
      processable_candidate_pairs:
        Number(main.counts?.unique_candidate_pairs ?? 0),
      unique_detail_pages: detailPages,
      completed_detail_pages: detailPages,
      verified_matched: verifiedMatched,
      verified_no_duration: verifiedNoDuration,
      rejections: rejections.length,
      errors: 0,
      retried_error_pairs: failedPairs.size,
      resolved_conflict_appids: conflicts.results.length,
      unresolved_conflict_appids: conflicts.rejections.length,
    },
    results,
    rejections,
    errors: [],
    merge_provenance: provenance,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  if (outputIndex !== 3 || !args[4] || args.length !== 5) {
    throw new Error(
      "Usage: node merge-hltb-validation-reports.mjs "
      + "<main.json> <retry.json> <conflicts.json> --output <merged.json>"
    );
  }
  const inputPaths = args.slice(0, 3).map((value) => path.resolve(value));
  const outputPath = path.resolve(args[4]);
  if (inputPaths.includes(outputPath)) throw new Error("Output cannot overwrite an input.");
  const texts = await Promise.all(inputPaths.map((value) => readFile(value, "utf8")));
  const documents = texts.map((value) => JSON.parse(value));
  const provenance = Object.fromEntries(
    inputPaths.map((value, index) => [
      ["main", "retry", "conflicts"][index],
      { path: value, sha256: digest(texts[index]) },
    ])
  );
  const merged = mergeValidationReports(...documents, provenance);
  await writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    stage: "hltb_validation_reports_merged",
    output_path: outputPath,
    output_sha256: digest(`${JSON.stringify(merged, null, 2)}\n`),
    ...merged.counts,
  }));
}

if (process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
