import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VALIDATOR_REPORT_SOURCE =
  "HLTB candidates verified against detail-page identity evidence";

const outputIndex = process.argv.indexOf("--output");
if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
  throw new Error(
    "Usage: node consolidate-hltb-reports.mjs <report...> --output <file.json> " +
    "[--expected-inputs <input...>]"
  );
}
const outputPath = path.resolve(process.argv[outputIndex + 1]);
const inputPaths = process.argv.slice(2, outputIndex).map((value) => path.resolve(value));
const expectedInputsIndex = process.argv.indexOf("--expected-inputs");
const expectedInputPaths = expectedInputsIndex === -1
  ? []
  : process.argv.slice(expectedInputsIndex + 1).map((value) => path.resolve(value));
if (!inputPaths.length) throw new Error("At least one HLTB report is required.");
if (expectedInputsIndex !== -1 && expectedInputsIndex < outputIndex) {
  throw new Error("--expected-inputs must appear after --output <file.json>.");
}

const candidatesByAppId = new Map();
const counts = {};
const sourceAppIds = new Set();
const heldUnvalidated = [];
let sourceRows = 0;
for (const inputPath of inputPaths) {
  const document = JSON.parse(await readFile(inputPath, "utf8"));
  const { rows, context: reportContext } = reportRows(document, inputPath);
  for (const [rowIndex, row] of rows.entries()) {
    sourceRows += 1;
    const status = reportStatus(row);
    counts[status] = (counts[status] ?? 0) + 1;
    const steamAppId = positiveInteger(row.steam_app_id ?? row.steam_appid);
    if (steamAppId) sourceAppIds.add(steamAppId);
    if (!steamAppId || row.provider !== "hltb") continue;
    const providerGameId = positiveInteger(row.provider_game_id);
    if (!providerGameId) continue;
    const kind = row.match_status === "matched"
      ? "matched"
      : status === "verified_no_duration"
        ? "no_duration"
        : null;
    if (!kind) continue;

    const verification = verifiedIdentity(row, reportContext, status);
    if (!verification.accepted) {
      heldUnvalidated.push({
        ...auditRow(row, steamAppId, inputPath, rowIndex),
        reason: verification.reason,
        report_kind: reportContext.kind,
      });
      continue;
    }

    const candidates = candidatesByAppId.get(steamAppId) ?? [];
    if (kind === "matched") {
      candidates.push({
        kind: "matched",
        result: importRow(row, steamAppId, verification),
        audit: auditRow(row, steamAppId, inputPath, rowIndex, verification),
      });
    } else {
      candidates.push({
        kind: "no_duration",
        result: importNoDurationRow(row, steamAppId, verification),
        audit: auditRow(row, steamAppId, inputPath, rowIndex, verification),
      });
    }
    candidatesByAppId.set(steamAppId, candidates);
  }
}

if (expectedInputPaths.length) {
  const expectedAppIds = await appIdsFromInputs(expectedInputPaths);
  const missing = [...expectedAppIds].filter((appid) => !sourceAppIds.has(appid));
  const unexpected = [...sourceAppIds].filter((appid) => !expectedAppIds.has(appid));
  if (missing.length || unexpected.length || sourceRows !== expectedAppIds.size) {
    throw new Error(
      `Report coverage mismatch: expected ${expectedAppIds.size} unique rows, received ` +
      `${sourceRows} rows / ${sourceAppIds.size} unique AppIDs; ` +
      `missing=${JSON.stringify(missing.slice(0, 10))}; ` +
      `unexpected=${JSON.stringify(unexpected.slice(0, 10))}.`
    );
  }
}

const selectedMatched = [];
const selectedNoDuration = [];
const suppressedNoDuration = [];
const conflicts = [];
for (const [steamAppId, candidates] of candidatesByAppId) {
  const providerGameIds = [...new Set(
    candidates.map((candidate) => candidate.result.provider_game_id).filter(Boolean)
  )].sort((left, right) => left - right);
  if (providerGameIds.length > 1) {
    conflicts.push({
      steam_app_id: steamAppId,
      reason: "conflicting_hltb_game_ids",
      provider_game_ids: providerGameIds,
      candidates: [...candidates]
        .sort((left, right) => stableCandidateKey(left).localeCompare(stableCandidateKey(right)))
        .map((candidate) => ({ kind: candidate.kind, ...candidate.audit })),
    });
    continue;
  }

  const matched = candidates.filter((candidate) => candidate.kind === "matched");
  const noDuration = candidates.filter((candidate) => candidate.kind === "no_duration");
  if (matched.length) {
    const strongest = [...matched].sort(compareCandidates)[0];
    selectedMatched.push({ ...strongest, duplicateRows: matched.length });
    suppressedNoDuration.push(...noDuration.map((candidate) => ({
      ...candidate.audit,
      reason: "shadowed_by_matched_row",
    })));
  } else if (noDuration.length) {
    const strongest = [...noDuration].sort(compareCandidates)[0];
    selectedNoDuration.push({ ...strongest, duplicateRows: noDuration.length });
  }
}

const orderedMatched = selectedMatched.sort(
  (left, right) => left.result.steam_app_id - right.result.steam_app_id
);
const orderedNoDuration = selectedNoDuration.sort(
  (left, right) => left.result.steam_app_id - right.result.steam_app_id
);
const results = orderedMatched.map((candidate) => candidate.result);
const noDurationResults = orderedNoDuration.map((candidate) => candidate.result);
const matchedAudit = orderedMatched.map((candidate) => ({
  ...candidate.audit,
  duplicate_rows: candidate.duplicateRows,
}));
const noDurationAudit = orderedNoDuration.map((candidate) => ({
  ...candidate.audit,
  duplicate_rows: candidate.duplicateRows,
}));
conflicts.sort((left, right) => left.steam_app_id - right.steam_app_id);
noDurationAudit.sort((left, right) =>
  left.steam_app_id - right.steam_app_id
  || compareNullableNumber(left.provider_game_id, right.provider_game_id)
  || left.source_file.localeCompare(right.source_file)
  || left.source_row - right.source_row
);
suppressedNoDuration.sort((left, right) =>
  left.steam_app_id - right.steam_app_id
  || compareNullableNumber(left.provider_game_id, right.provider_game_id)
  || left.source_file.localeCompare(right.source_file)
  || left.source_row - right.source_row
);
heldUnvalidated.sort((left, right) =>
  left.steam_app_id - right.steam_app_id
  || compareNullableNumber(left.provider_game_id, right.provider_game_id)
  || left.source_file.localeCompare(right.source_file)
  || left.source_row - right.source_row
);

await writeFile(outputPath, `${JSON.stringify({
  schema_version: 4,
  source: "HowLongToBeat local identity-validated fallback",
  consolidated_at: new Date().toISOString(),
  source_files: inputPaths,
  expected_input_files: expectedInputPaths,
  source_rows: sourceRows,
  source_unique_appids: sourceAppIds.size,
  counts,
  matched_rows: results.length,
  no_duration_rows: noDurationResults.length,
  held_unvalidated_rows: heldUnvalidated.length,
  rejected_conflicting_apps: conflicts.length,
  results,
  no_duration_results: noDurationResults,
  audit: {
    matched: matchedAudit,
    verified_no_duration: noDurationAudit,
    suppressed_no_duration: suppressedNoDuration,
    held_unvalidated: heldUnvalidated,
    conflicts,
  },
})}\n`, "utf8");
console.log(JSON.stringify({
  stage: "hltb_reports_consolidated",
  source_files: inputPaths.length,
  source_rows: sourceRows,
  counts,
  matched_rows: results.length,
  verified_no_duration_rows: noDurationResults.length,
  held_unvalidated_rows: heldUnvalidated.length,
  suppressed_no_duration_rows: suppressedNoDuration.length,
  rejected_conflicting_apps: conflicts.length,
  output_path: outputPath,
}));

function reportStatus(row) {
  if (row.match_status === "matched") return "matched";
  if (row.status === "verified_no_duration" || row.match_status === "no_duration") {
    return "verified_no_duration";
  }
  return String(row.status ?? row.match_status ?? "unknown");
}

function reportRows(document, inputPath) {
  if (Array.isArray(document)) {
    return {
      rows: document,
      context: { kind: "matcher_array", completedValidator: false },
    };
  }
  if (
    document
    && typeof document === "object"
    && document.source === VALIDATOR_REPORT_SOURCE
    && Array.isArray(document.results)
  ) {
    if (document.schema_version !== 1) {
      throw new Error(`${inputPath} has an unsupported HLTB validator schema version.`);
    }
    if (document.state !== "complete") {
      throw new Error(`${inputPath} is not a completed HLTB validator report.`);
    }
    return {
      rows: document.results,
      context: {
        kind: "completed_validator",
        completedValidator: true,
        allowSafeTitle: document.options?.allow_safe_title === true,
      },
    };
  }
  throw new Error(
    `${inputPath} must contain a matcher JSON array or a completed HLTB validator report.`
  );
}

function verifiedIdentity(row, reportContext, status) {
  const identityTier = cleanText(row.identity_tier);
  const identityConfidence = confidence(row.identity_confidence);
  const method = cleanText(row.verification_method);
  const verificationTier = cleanText(row.verification_tier);
  if (identityTier && verificationTier && identityTier !== verificationTier) {
    return rejectedIdentity("contradictory_identity_tiers");
  }

  const tier = verificationTier ?? identityTier;
  if (reportContext.completedValidator && !validatorStatusMatches(row, status)) {
    return rejectedIdentity("validator_status_mismatch");
  }

  const currentMatcherDirect = method === null
    && verificationTier === null
    && identityTier === "steam_appid"
    && identityConfidence === "high"
    && reportContext.kind === "matcher_array";
  const explicitDirect = method === "profile_steam_exact"
    && verificationTier === "steam_appid"
    && (identityTier === null || identityTier === "steam_appid")
    && identityConfidence === "high";
  if (currentMatcherDirect || explicitDirect) {
    return {
      accepted: true,
      method: "profile_steam_exact",
      tier: "steam_appid",
      source: currentMatcherDirect ? "matcher_identity_tier" : "detail_page_validator",
    };
  }

  const safePair = new Set(["safe_exact_title", "safe_exact_alias"]).has(method)
    && new Set(["exact_title", "mixed_script_title"]).has(tier);
  if (safePair) {
    if (!reportContext.completedValidator || !reportContext.allowSafeTitle) {
      return rejectedIdentity("safe_title_requires_completed_validator_report");
    }
    if (!safeTitleSourceEvidenceIsComplete(row)) {
      return rejectedIdentity("validator_safe_title_missing_source_evidence");
    }
    const expectedConfidence = tier === "mixed_script_title" ? "medium" : "high";
    if (identityConfidence !== expectedConfidence) {
      return rejectedIdentity("invalid_safe_title_identity_confidence");
    }
    return {
      accepted: true,
      method,
      tier,
      source: "detail_page_validator",
    };
  }

  if (method === null && tier === null) {
    return rejectedIdentity("missing_identity_verification");
  }
  if (
    method?.startsWith("safe_")
    || new Set(["exact_title", "mixed_script_title"]).has(tier)
  ) {
    return rejectedIdentity("unvalidated_safe_title_identity");
  }
  return rejectedIdentity("unrecognized_identity_verification");
}

function validatorStatusMatches(row, status) {
  const expected = status === "matched" ? "verified_matched" : "verified_no_duration";
  return row.status === expected
    && row.verification_status === expected
    && row.match_status === (status === "matched" ? "matched" : "no_duration");
}

function safeTitleSourceEvidenceIsComplete(row) {
  const verifiedSourceTitle = cleanText(row.verified_source_title);
  const sourceTitles = cleanStringArray(row.source_titles);
  return Boolean(
    verifiedSourceTitle
    && sourceTitles.includes(verifiedSourceTitle)
    && positiveInteger(row.source_rows)
  );
}

function rejectedIdentity(reason) {
  return { accepted: false, reason };
}

function importRow(row, steamAppId, verification) {
  return {
    steam_app_id: steamAppId,
    provider: "hltb",
    provider_game_id: positiveInteger(row.provider_game_id),
    main_story_minutes: positiveInteger(row.main_story_minutes),
    main_extra_minutes: positiveInteger(row.main_extra_minutes),
    completionist_minutes: positiveInteger(row.completionist_minutes),
    submission_count: nonNegativeInteger(row.submission_count),
    match_status: "matched",
    match_confidence: confidence(row.match_confidence) ?? confidence(row.identity_confidence) ?? "low",
    provider_updated_at: validDate(row.provider_updated_at),
    checked_at: validDate(row.checked_at),
    next_refresh_at: validDate(row.next_refresh_at),
    last_error_code: cleanText(row.last_error_code),
    updated_at: validDate(row.updated_at),
    evidence: providerEvidence(row, verification),
  };
}

function importNoDurationRow(row, steamAppId, verification) {
  return {
    steam_app_id: steamAppId,
    provider: "hltb",
    provider_game_id: positiveInteger(row.provider_game_id),
    main_story_minutes: null,
    main_extra_minutes: null,
    completionist_minutes: null,
    submission_count: nonNegativeInteger(row.submission_count),
    match_status: "no_duration",
    match_confidence: confidence(row.match_confidence) ?? confidence(row.identity_confidence) ?? "low",
    provider_updated_at: validDate(row.provider_updated_at),
    checked_at: validDate(row.checked_at),
    next_refresh_at: validDate(row.next_refresh_at),
    last_error_code: cleanText(row.last_error_code) ?? "known_title_no_provider_times",
    updated_at: validDate(row.updated_at),
    evidence: providerEvidence(row, verification),
  };
}

function providerEvidence(row, verification) {
  return {
    identity_validated: true,
    identity_tier: verification.tier,
    identity_confidence: confidence(row.identity_confidence),
    duration_basis: cleanText(row.duration_basis),
    duration_issues: cleanStringArray(row.duration_issues),
    hltb_modes: cleanModes(row.hltb_modes),
    verification_method: verification.method,
    verification_tier: verification.tier,
    verification_source: verification.source,
  };
}

function auditRow(row, steamAppId, inputPath, rowIndex, verification = null) {
  return {
    steam_app_id: steamAppId,
    provider_game_id: positiveInteger(row.provider_game_id ?? row.candidate_game_id),
    identity_tier: cleanText(row.identity_tier ?? row.candidate_metadata?.identity_tier),
    identity_confidence: confidence(row.identity_confidence ?? row.candidate_metadata?.identity_confidence),
    duration_basis: cleanText(row.duration_basis ?? row.candidate_metadata?.duration_basis),
    match_confidence: confidence(row.match_confidence ?? row.candidate_metadata?.match_confidence),
    submission_count: nonNegativeInteger(row.submission_count ?? row.candidate_metadata?.submission_count),
    duration_issues: cleanStringArray(row.duration_issues ?? row.candidate_metadata?.duration_issues),
    hltb_modes: cleanModes(row.hltb_modes ?? row.candidate_metadata?.hltb_modes),
    verification_method: verification?.method ?? cleanText(row.verification_method),
    verification_tier: verification?.tier ?? cleanText(row.verification_tier),
    verification_source: verification?.source ?? null,
    searched_as: cleanText(row.searched_as),
    matched_title: cleanText(row.matched_title ?? row.candidate_title),
    similarity: finiteNumber(row.similarity ?? row.candidate_similarity),
    checked_at: validDate(row.checked_at),
    next_refresh_at: validDate(row.next_refresh_at),
    last_error_code: cleanText(row.last_error_code),
    source_file: inputPath,
    source_row: rowIndex + 1,
  };
}

function compareCandidates(left, right) {
  const leftKey = candidateStrength(left);
  const rightKey = candidateStrength(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) return rightKey[index] - leftKey[index];
  }
  return stableCandidateKey(left).localeCompare(stableCandidateKey(right));
}

function candidateStrength(candidate) {
  const row = candidate.result;
  const audit = candidate.audit;
  return [
    identityTierScore(audit.identity_tier),
    confidenceScore(audit.identity_confidence),
    confidenceScore(row.match_confidence),
    durationBasisScore(audit.duration_basis),
    row.submission_count ?? -1,
    [row.main_story_minutes, row.main_extra_minutes, row.completionist_minutes]
      .filter((value) => value !== null).length,
    dateScore(row.checked_at),
  ];
}

function stableCandidateKey(candidate) {
  return JSON.stringify([candidate.result, candidate.audit]);
}

function confidenceScore(value) {
  return { low: 1, medium: 2, high: 3 }[value] ?? 0;
}

function identityTierScore(value) {
  return { mixed_script_title: 1, exact_title: 2, steam_appid: 3 }[value] ?? 0;
}

function durationBasisScore(value) {
  return { multiplayer_representative: 1, all_styles: 2, completion_times: 3 }[value] ?? 0;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function confidence(value) {
  return new Set(["low", "medium", "high"]).has(value) ? value : null;
}

function validDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function dateScore(value) {
  return value ? new Date(value).valueOf() : 0;
}

function cleanText(value) {
  const cleaned = String(value ?? "").trim();
  return cleaned || null;
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanText).filter(Boolean))];
}

function cleanModes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    single_player: Boolean(value.single_player),
    co_op: Boolean(value.co_op),
    multiplayer: Boolean(value.multiplayer),
  };
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareNullableNumber(left, right) {
  return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
}

async function appIdsFromInputs(paths) {
  const appIds = new Set();
  let rows = 0;
  for (const inputPath of paths) {
    const document = JSON.parse(await readFile(inputPath, "utf8"));
    const inputRows = Array.isArray(document)
      ? document
      : Array.isArray(document?.results)
        ? document.results
        : null;
    if (!inputRows) throw new Error(`${inputPath} must contain a JSON array or results array.`);
    for (const row of inputRows) {
      rows += 1;
      const appid = positiveInteger(row?.steam_app_id ?? row?.steam_appid);
      if (!appid) throw new Error(`${inputPath} contains an input row without a valid Steam AppID.`);
      if (appIds.has(appid)) throw new Error(`Expected inputs contain duplicate Steam AppID ${appid}.`);
      appIds.add(appid);
    }
  }
  if (rows !== appIds.size) throw new Error("Expected input rows are not unique by Steam AppID.");
  return appIds;
}
