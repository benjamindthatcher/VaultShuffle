#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALIDATOR_SOURCE =
  "HLTB candidates verified against detail-page identity evidence";
const IMPORT_LOCK_KEY_ONE = 1448236628;
const IMPORT_LOCK_KEY_TWO = 1213482818;
const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 250;
const CONFIDENCE = new Set(["low", "medium", "high"]);
const MATCHED_BASES = new Set([
  "completion_times",
  "all_styles",
  "multiplayer_representative",
]);
const SAFE_METHODS = new Set(["safe_exact_title", "safe_exact_alias"]);
const SAFE_TIERS = new Set(["exact_title", "mixed_script_title"]);
const INPUT_ONLY_REJECTION_REASONS = new Set(["no_authoritative_source_title"]);

export function buildHltbWritebackSql(document, options = {}) {
  const batchSize = parseBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);
  const sourceName = cleanComment(options.sourceName ?? "validator-report.json");
  const normalized = normalizeValidatorDocument(document, sourceName);
  const batches = batchByAppId(normalized.stageRows, batchSize);
  const lines = [
    "-- VaultShuffle HLTB validator writeback.",
    `-- Source: ${sourceName}`,
    "-- Generated only from a completed schema-v1 detail-page validator report.",
    "-- Validated identity, duration-basis, and mode evidence is persisted with each accepted row.",
    "-- This script intentionally never changes catalogue quarantine decisions.",
    "",
    "do $vaultshuffle_hltb_lock$",
    "begin",
    `  if not pg_catalog.pg_try_advisory_lock(${IMPORT_LOCK_KEY_ONE}, ${IMPORT_LOCK_KEY_TWO}) then`,
    "    raise exception 'Another VaultShuffle HLTB writeback is active.';",
    "  end if;",
    "end",
    "$vaultshuffle_hltb_lock$;",
    "",
    "drop table if exists pg_temp._vaultshuffle_hltb_import_summary;",
    "create temporary table _vaultshuffle_hltb_import_summary (",
    "  batch_number integer not null,",
    "  metric text not null,",
    "  changed integer not null,",
    "  details jsonb not null default '{}'::jsonb",
    ") on commit preserve rows;",
    "",
    `insert into _vaultshuffle_hltb_import_summary values (0, 'validator_errors_ignored', ${normalized.errorCount}, '{}'::jsonb);`,
    `insert into _vaultshuffle_hltb_import_summary values (0, 'input_only_rejections_ignored', ${normalized.inputOnlyRejectionCount}, '{}'::jsonb);`,
    "",
  ];

  for (const [index, rows] of batches.entries()) {
    lines.push(buildBatchSql(rows, index + 1));
  }

  lines.push(
    "select",
    "  pg_catalog.pg_advisory_unlock(" + IMPORT_LOCK_KEY_ONE + ", " + IMPORT_LOCK_KEY_TWO + ") as import_lock_released,",
    "  coalesce(",
    "    jsonb_agg(",
    "      jsonb_build_object(",
    "        'batch', batch_number,",
    "        'metric', metric,",
    "        'changed', changed,",
    "        'details', details",
    "      ) order by batch_number, metric, details::text",
    "    ),",
    "    '[]'::jsonb",
    "  ) as writeback_summary",
    "from _vaultshuffle_hltb_import_summary;",
    ""
  );
  return `${lines.join("\n")}\n`;
}

export function buildHltbWritebackDirectoryArtifacts(document, options = {}) {
  const batchSize = parseBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);
  const sourceName = cleanComment(options.sourceName ?? "validator-report.json");
  const normalized = normalizeValidatorDocument(document, sourceName);
  const batches = batchByAppId(normalized.stageRows, batchSize);
  const appIds = [...new Set(normalized.stageRows.map((row) => row.steam_app_id))]
    .sort((left, right) => left - right);
  const width = Math.max(4, String(Math.max(1, batches.length)).length);
  const files = [];

  files.push(artifactFile("setup.sql", "setup", buildStandaloneSetupSql(), 0, 0));
  for (const [index, rows] of batches.entries()) {
    const batchNumber = index + 1;
    const name = `batch-${String(batchNumber).padStart(width, "0")}.sql`;
    files.push(artifactFile(
      name,
      "batch",
      buildBatchSql(rows, batchNumber, { standalone: true }),
      new Set(rows.map((row) => row.steam_app_id)).size,
      rows.length,
      actionCounts(rows)
    ));
  }
  files.push(artifactFile(
    "finalize.sql",
    "finalize",
    buildStandaloneFinalizeSql(appIds),
    appIds.length,
    normalized.stageRows.length
  ));

  const manifest = {
    schema_version: 1,
    kind: "vaultshuffle_hltb_validator_writeback",
    source: sourceName,
    source_sha256: cleanSha256(options.sourceSha256)
      ?? sha256(JSON.stringify(document)),
    validator_schema_version: document.schema_version,
    validator_state: document.state,
    batch_size: batchSize,
    batch_count: batches.length,
    staged_app_count: appIds.length,
    staged_row_count: normalized.stageRows.length,
    staged_action_counts: actionCounts(normalized.stageRows),
    validator_errors_ignored: normalized.errorCount,
    input_only_rejections_ignored: normalized.inputOnlyRejectionCount,
    replay_safe: true,
    execution_model: "standalone_read_committed_batches_with_transaction_advisory_lock",
    files: files.map(({ content: _content, ...entry }) => entry),
  };
  return {
    files,
    manifest,
    manifestContent: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

export function normalizeValidatorDocument(document, sourceName = "validator-report.json") {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${sourceName} must contain a validator report object.`);
  }
  if (document.schema_version !== 1) {
    throw new Error(`${sourceName} is not a supported schema-v1 HLTB validator report.`);
  }
  if (document.source !== VALIDATOR_SOURCE || document.state !== "complete") {
    throw new Error(`${sourceName} is not a completed HLTB validator report.`);
  }
  if (!Array.isArray(document.results) || !Array.isArray(document.rejections) || !Array.isArray(document.errors)) {
    throw new Error(`${sourceName} is missing validator results, rejections, or errors.`);
  }
  const reportCheckedAt = requiredDate(document.updated_at, "report.updated_at");
  validateCompletionCounts(document);

  const allowSafeTitle = document.options?.allow_safe_title === true;
  const resultsByAppId = new Map();
  for (const [index, rawRow] of document.results.entries()) {
    const row = normalizeResult(rawRow, index, allowSafeTitle);
    const rows = resultsByAppId.get(row.steam_app_id) ?? [];
    rows.push(row);
    resultsByAppId.set(row.steam_app_id, rows);
  }

  const rejectionsByAppId = new Map();
  let inputOnlyRejectionCount = 0;
  for (const [index, rawRow] of document.rejections.entries()) {
    const rejection = normalizeRejection(rawRow, index, reportCheckedAt);
    if (rejection.inputOnly) {
      inputOnlyRejectionCount += 1;
      continue;
    }
    for (const row of rejection.rows) {
      const rows = rejectionsByAppId.get(row.steam_app_id) ?? [];
      rows.push(row);
      rejectionsByAppId.set(row.steam_app_id, rows);
    }
  }

  const allAppIds = new Set([...resultsByAppId.keys(), ...rejectionsByAppId.keys()]);
  const stageRows = [];
  for (const appId of [...allAppIds].sort((left, right) => left - right)) {
    const rejectionRows = rejectionsByAppId.get(appId) ?? [];
    if (rejectionRows.length) {
      stageRows.push(...dedupeStageRows(rejectionRows));
      continue;
    }

    const resultRows = resultsByAppId.get(appId) ?? [];
    if (resultRows.length === 1) {
      stageRows.push(resultRows[0]);
      continue;
    }
    if (resultRows.length > 1) {
      const ids = [...new Set(resultRows.map((row) => row.provider_game_id))];
      const statuses = [...new Set(resultRows.map((row) => row.action))];
      const reason = ids.length > 1
        ? "validator_result_id_conflict"
        : statuses.length > 1
          ? "validator_result_status_conflict"
          : "validator_duplicate_result";
      for (const providerGameId of ids) {
        stageRows.push(demotionRow(appId, providerGameId, reason, reportCheckedAt));
      }
    }
  }

  stageRows.sort(stageRowSort);
  return {
    stageRows,
    errorCount: document.errors.length,
    inputOnlyRejectionCount,
  };
}

function normalizeResult(row, index, allowSafeTitle) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`results[${index}] must be an object.`);
  }
  const prefix = `results[${index}]`;
  const steamAppId = requiredPositiveInteger(row.steam_app_id ?? row.steam_appid, `${prefix}.steam_app_id`);
  const providerGameId = requiredPositiveInteger(row.provider_game_id, `${prefix}.provider_game_id`);
  if (row.provider !== "hltb") throw new Error(`${prefix}.provider must be hltb.`);

  const verificationStatus = cleanText(row.verification_status);
  const action = verificationStatus === "verified_matched"
    ? "matched"
    : verificationStatus === "verified_no_duration"
      ? "no_duration"
      : null;
  if (!action) throw new Error(`${prefix} has an unsupported verification status.`);
  const expectedStatus = action === "matched" ? "verified_matched" : "verified_no_duration";
  const expectedMatchStatus = action === "matched" ? "matched" : "no_duration";
  if (row.status !== expectedStatus || row.match_status !== expectedMatchStatus) {
    throw new Error(`${prefix} has contradictory validator status fields.`);
  }

  const verificationMethod = cleanText(row.verification_method);
  const verificationTier = cleanText(row.verification_tier);
  const identityTier = cleanText(row.identity_tier);
  const identityConfidence = requiredConfidence(row.identity_confidence, `${prefix}.identity_confidence`);
  validateIdentityEvidence({
    row,
    prefix,
    verificationMethod,
    verificationTier,
    identityTier,
    identityConfidence,
    allowSafeTitle,
  });

  const matchConfidence = requiredConfidence(row.match_confidence, `${prefix}.match_confidence`);
  const durationBasis = cleanText(row.duration_basis);
  const mainStory = optionalPositiveInteger(row.main_story_minutes, `${prefix}.main_story_minutes`);
  const mainExtra = optionalPositiveInteger(row.main_extra_minutes, `${prefix}.main_extra_minutes`);
  const completionist = optionalPositiveInteger(row.completionist_minutes, `${prefix}.completionist_minutes`);
  if (action === "matched") {
    if (!MATCHED_BASES.has(durationBasis)) throw new Error(`${prefix} has an invalid matched duration basis.`);
    validateDurationValues(mainStory, mainExtra, completionist, prefix);
  } else {
    if (durationBasis !== "no_duration" || mainStory || mainExtra || completionist) {
      throw new Error(`${prefix} is not a coherent verified no-duration result.`);
    }
    if (matchConfidence !== identityConfidence) {
      throw new Error(`${prefix} no-duration confidence must equal its identity confidence.`);
    }
  }

  const durationIssues = normalizeStringArray(row.duration_issues, `${prefix}.duration_issues`);
  const modes = normalizeModes(row.hltb_modes, `${prefix}.hltb_modes`);
  const checkedAt = requiredDate(row.checked_at, `${prefix}.checked_at`);
  const evidence = {
    identity_validated: true,
    identity_tier: verificationTier,
    identity_confidence: identityConfidence,
    duration_basis: durationBasis,
    duration_issues: durationIssues,
    hltb_modes: modes,
    verification_method: verificationMethod,
    verification_tier: verificationTier,
    verification_source: "detail_page_validator",
  };
  return {
    action,
    steam_app_id: steamAppId,
    provider_game_id: providerGameId,
    main_story_minutes: mainStory,
    main_extra_minutes: mainExtra,
    completionist_minutes: completionist,
    submission_count: optionalNonNegativeInteger(row.submission_count, `${prefix}.submission_count`),
    match_confidence: matchConfidence,
    provider_updated_at: optionalDate(row.provider_updated_at, `${prefix}.provider_updated_at`),
    checked_at: checkedAt,
    next_refresh_at: optionalDate(row.next_refresh_at, `${prefix}.next_refresh_at`),
    last_error_code: action === "no_duration"
      ? "known_title_no_provider_times"
      : null,
    verification_method: verificationMethod,
    verification_tier: verificationTier,
    identity_confidence: identityConfidence,
    duration_basis: durationBasis,
    duration_issues: durationIssues,
    mode_single_player: modes.single_player,
    mode_co_op: modes.co_op,
    mode_multiplayer: modes.multiplayer,
    evidence,
    demotion_reason: null,
  };
}

function validateIdentityEvidence({
  row,
  prefix,
  verificationMethod,
  verificationTier,
  identityTier,
  identityConfidence,
  allowSafeTitle,
}) {
  if (identityTier !== verificationTier) {
    throw new Error(`${prefix} has contradictory identity and verification tiers.`);
  }
  if (verificationMethod === "profile_steam_exact") {
    if (verificationTier !== "steam_appid" || identityConfidence !== "high") {
      throw new Error(`${prefix} has invalid direct-AppID identity evidence.`);
    }
    return;
  }
  if (!SAFE_METHODS.has(verificationMethod) || !SAFE_TIERS.has(verificationTier)) {
    throw new Error(`${prefix} has unsupported identity evidence.`);
  }
  if (!allowSafeTitle) throw new Error(`${prefix} uses safe-title evidence without validator approval.`);
  const expectedConfidence = verificationTier === "mixed_script_title" ? "medium" : "high";
  if (identityConfidence !== expectedConfidence) {
    throw new Error(`${prefix} has invalid safe-title identity confidence.`);
  }
  const verifiedSourceTitle = cleanText(row.verified_source_title);
  const sourceTitles = normalizeStringArray(row.source_titles, `${prefix}.source_titles`);
  if (!verifiedSourceTitle || !sourceTitles.includes(verifiedSourceTitle)) {
    throw new Error(`${prefix} is missing its verified authoritative source title.`);
  }
  requiredPositiveInteger(row.source_rows, `${prefix}.source_rows`);
}

function normalizeRejection(row, index, checkedAt) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(`rejections[${index}] must be an object.`);
  }
  const prefix = `rejections[${index}]`;
  const steamAppId = requiredPositiveInteger(row.steam_appid ?? row.steam_app_id, `${prefix}.steam_appid`);
  const reason = normalizeReason(row.reason, `${prefix}.reason`);
  if (INPUT_ONLY_REJECTION_REASONS.has(reason)) return { inputOnly: true, rows: [] };
  const candidateIds = [row.provider_game_id, ...(Array.isArray(row.candidate_game_ids) ? row.candidate_game_ids : [])]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => requiredPositiveInteger(value, `${prefix}.provider_game_id`));
  const providerGameIds = [...new Set(candidateIds)].sort((left, right) => left - right);
  if (!providerGameIds.length) return { inputOnly: true, rows: [] };
  return {
    inputOnly: false,
    rows: providerGameIds.map((providerGameId) =>
      demotionRow(steamAppId, providerGameId, reason, checkedAt)
    ),
  };
}

function demotionRow(steamAppId, providerGameId, reason, checkedAt) {
  return {
    action: "demote",
    steam_app_id: steamAppId,
    provider_game_id: providerGameId,
    main_story_minutes: null,
    main_extra_minutes: null,
    completionist_minutes: null,
    submission_count: null,
    match_confidence: "none",
    provider_updated_at: null,
    checked_at: checkedAt,
    next_refresh_at: null,
    last_error_code: `hltb_identity_${reason}`.slice(0, 80),
    verification_method: null,
    verification_tier: null,
    identity_confidence: null,
    duration_basis: null,
    duration_issues: [],
    mode_single_player: null,
    mode_co_op: null,
    mode_multiplayer: null,
    evidence: null,
    demotion_reason: reason,
  };
}

function validateCompletionCounts(document) {
  const counts = document.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("report.counts is required.");
  }
  const uniquePages = requiredNonNegativeInteger(counts.unique_detail_pages, "counts.unique_detail_pages");
  const completedPages = requiredNonNegativeInteger(counts.completed_detail_pages, "counts.completed_detail_pages");
  if (uniquePages !== completedPages) throw new Error("The validator report has incomplete detail pages.");
  const matched = document.results.filter((row) => row?.verification_status === "verified_matched").length;
  const noDuration = document.results.filter((row) => row?.verification_status === "verified_no_duration").length;
  if (requiredNonNegativeInteger(counts.verified_matched, "counts.verified_matched") !== matched
      || requiredNonNegativeInteger(counts.verified_no_duration, "counts.verified_no_duration") !== noDuration
      || requiredNonNegativeInteger(counts.rejections, "counts.rejections") !== document.rejections.length
      || requiredNonNegativeInteger(counts.errors, "counts.errors") !== document.errors.length) {
    throw new Error("The validator report counts do not match its result arrays.");
  }
}

function buildStandaloneSetupSql() {
  return `-- VaultShuffle HLTB standalone writeback setup check.
-- This file creates no persistent or session state. Every batch is self-contained.
select jsonb_build_object(
  'catalog_games', to_regclass('public.catalog_games') is not null,
  'game_duration_estimates', to_regclass('public.game_duration_estimates') is not null,
  'game_duration_jobs', to_regclass('public.game_duration_jobs') is not null,
  'catalog_game_quarantine', to_regclass('public.catalog_game_quarantine') is not null,
  'duration_manual_override', exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'catalog_games'
      and column_name = 'duration_manual_override'
  ),
  'duration_evidence', exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'game_duration_estimates'
      and column_name = 'evidence'
      and data_type = 'jsonb'
  ),
  'reconciliation_trigger', exists (
    select 1
    from pg_catalog.pg_trigger as trigger
    join pg_catalog.pg_class as relation on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'game_duration_estimates'
      and trigger.tgname = 'sync_duration_estimate_trigger'
      and not trigger.tgisinternal
      and trigger.tgenabled <> 'D'
  )
) as setup_check;
`;
}

function hardenedFiniteCatalogueCte() {
  return `hardened_finite_catalogue as (
  select distinct game.steam_appid as steam_app_id
  from affected
  join public.catalog_games as game
    on game.steam_appid = affected.steam_app_id
  join public.game_duration_estimates as estimate
    on estimate.steam_app_id = game.steam_appid
   and estimate.provider = game.duration_source
   and estimate.provider_game_id::text is not distinct from game.duration_source_game_id
  where game.duration_status = 'ready'
    and game.duration_kind = 'finite'
    and row(
      game.main_story_minutes,
      game.main_extras_minutes,
      game.completionist_minutes
    ) is not distinct from row(
      estimate.main_story_minutes,
      estimate.main_extra_minutes,
      estimate.completionist_minutes
    )
    and estimate.match_status = 'matched'
    and (
      estimate.match_confidence in ('medium', 'high')
      or (
        estimate.provider = 'hltb'
        and estimate.match_confidence = 'low'
        and estimate.evidence @> '{"identity_validated": true}'::jsonb
        and estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
        and estimate.evidence ->> 'verification_tier' = 'steam_appid'
        and estimate.evidence ->> 'duration_basis' = 'completion_times'
        and estimate.evidence -> 'duration_issues' = '[]'::jsonb
        and (
          coalesce(estimate.submission_count, 0) >= 2
          or (
            (estimate.main_story_minutes is not null)::int
            + (estimate.main_extra_minutes is not null)::int
            + (estimate.completionist_minutes is not null)::int
          ) >= 2
        )
      )
      or (
        estimate.provider = 'igdb'
        and estimate.match_confidence = 'low'
        and coalesce(estimate.submission_count, 0) between 2 and 4
        and (
          (estimate.main_story_minutes is not null)::int
          + (estimate.main_extra_minutes is not null)::int
          + (estimate.completionist_minutes is not null)::int
        ) >= 2
        and (
          estimate.main_story_minutes is null
          or estimate.main_extra_minutes is null
          or estimate.main_extra_minutes::bigint
            < estimate.main_story_minutes::bigint * 12
        )
        and (
          coalesce(
            estimate.main_story_minutes,
            estimate.main_extra_minutes
          ) is null
          or estimate.completionist_minutes is null
          or estimate.completionist_minutes::bigint < coalesce(
            estimate.main_story_minutes,
            estimate.main_extra_minutes
          )::bigint * 12
        )
      )
    )
    and estimate.provider_game_id is not null
    and (estimate.main_story_minutes > 0 or estimate.main_extra_minutes > 0 or estimate.completionist_minutes > 0)
    and (estimate.main_story_minutes is null or estimate.main_story_minutes between 1 and 120000)
    and (estimate.main_extra_minutes is null or estimate.main_extra_minutes between 1 and 120000)
    and (estimate.completionist_minutes is null or estimate.completionist_minutes between 1 and 120000)
    and (estimate.main_story_minutes is null or estimate.main_extra_minutes is null
      or estimate.main_extra_minutes >= estimate.main_story_minutes)
    and (estimate.completionist_minutes is null
      or coalesce(estimate.main_extra_minutes, estimate.main_story_minutes) is null
      or estimate.completionist_minutes >= coalesce(estimate.main_extra_minutes, estimate.main_story_minutes))
    and (estimate.main_story_minutes is null or estimate.completionist_minutes is null
      or estimate.completionist_minutes::bigint < estimate.main_story_minutes::bigint * 12)
    and (
      (
        estimate.provider = 'hltb'
        and estimate.evidence @> '{"identity_validated": true}'::jsonb
        and (
          (
            estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
            and estimate.evidence ->> 'verification_tier' = 'steam_appid'
          )
          or (
            estimate.evidence ->> 'verification_method' in ('safe_exact_title', 'safe_exact_alias')
            and estimate.evidence ->> 'verification_tier' in ('exact_title', 'mixed_script_title')
          )
        )
      )
      or (
        estimate.provider = 'igdb'
        and (
          coalesce(estimate.submission_count, 0) >= 5
          or estimate.match_confidence = 'low'
        )
        and (
          (estimate.main_story_minutes is not null)::int
          + (estimate.main_extra_minutes is not null)::int
          + (estimate.completionist_minutes is not null)::int
        ) >= 2
        and lower(game.name) !~
          '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
        and (
          estimate.evidence @> '{"duplicate_provider_id_validated": true}'::jsonb
          or not exists (
            select 1
            from public.game_duration_estimates as sibling_estimate
            where sibling_estimate.provider = 'igdb'
              and sibling_estimate.match_status = 'matched'
              and sibling_estimate.provider_game_id = estimate.provider_game_id
              and sibling_estimate.steam_app_id <> estimate.steam_app_id
          )
        )
      )
    )
)`;
}

function buildStandaloneFinalizeSql(appIds) {
  const appIdJson = sqlStringLiteral(JSON.stringify(appIds));
  return `-- VaultShuffle HLTB standalone writeback final verification.
-- Read-only: no lock or session state is shared with the standalone batch files.
with affected as (
  select value::bigint as steam_app_id
  from jsonb_array_elements_text(${appIdJson}::jsonb)
), ${hardenedFiniteCatalogueCte()}, eligible as (
  select
    affected.steam_app_id,
    game.duration_kind,
    game.duration_status,
    game.duration_manual_override,
    hardened.steam_app_id is not null as has_hardened_finite
  from affected
  join public.catalog_games as game on game.steam_appid = affected.steam_app_id
  left join hardened_finite_catalogue as hardened
    on hardened.steam_app_id = affected.steam_app_id
  left join public.catalog_game_quarantine as quarantine
    on quarantine.steam_appid = affected.steam_app_id
  left join public.game_duration_jobs as job
    on job.steam_app_id = affected.steam_app_id
  where coalesce(quarantine.review_status, '') <> 'excluded'
    and not game.duration_manual_override
    and coalesce(job.status, '') <> 'processing'
), expected_jobs as (
  select
    eligible.steam_app_id,
    case
      when eligible.duration_manual_override
        or eligible.has_hardened_finite
        or (eligible.duration_status = 'ready' and eligible.duration_kind in ('endless', 'not-applicable'))
      then 'completed'
      else 'needs_review'
    end as expected_status
  from eligible
), affected_hltb_ids as (
  select distinct estimate.provider_game_id
  from public.game_duration_estimates as estimate
  join affected on affected.steam_app_id = estimate.steam_app_id
  where estimate.provider = 'hltb' and estimate.provider_game_id is not null
), reused_hltb_ids as (
  select estimate.provider_game_id
  from public.game_duration_estimates as estimate
  join affected_hltb_ids as affected_id
    on affected_id.provider_game_id = estimate.provider_game_id
  where estimate.provider = 'hltb'
  group by estimate.provider_game_id
  having count(distinct estimate.steam_app_id) > 1
)
select jsonb_build_object(
  'affected_appids', (select count(*) from affected),
  'missing_catalogue', (
    select count(*) from affected
    left join public.catalog_games as game on game.steam_appid = affected.steam_app_id
    where game.steam_appid is null
  ),
  'excluded_quarantine_skipped', (
    select count(*) from affected
    join public.catalog_game_quarantine as quarantine on quarantine.steam_appid = affected.steam_app_id
    where quarantine.review_status = 'excluded'
  ),
  'manual_overrides_skipped', (
    select count(*) from affected
    join public.catalog_games as game on game.steam_appid = affected.steam_app_id
    where game.duration_manual_override
  ),
  'processing_jobs_skipped', (
    select count(*) from affected
    join public.game_duration_jobs as job on job.steam_app_id = affected.steam_app_id
    where job.status = 'processing'
  ),
  'job_state_mismatches', (
    select count(*)
    from expected_jobs as expected
    left join public.game_duration_jobs as job on job.steam_app_id = expected.steam_app_id
    where job.status is distinct from expected.expected_status
  ),
  'unhardened_hltb_projected_ready', (
    select count(*)
    from affected
    join public.catalog_games as game on game.steam_appid = affected.steam_app_id
    left join hardened_finite_catalogue as hardened
      on hardened.steam_app_id = affected.steam_app_id
    where game.duration_source = 'hltb'
      and game.duration_status = 'ready'
      and game.duration_kind = 'finite'
      and hardened.steam_app_id is null
  ),
  'no_duration_rows_with_raw_values', (
    select count(*)
    from affected
    join public.game_duration_estimates as estimate
      on estimate.steam_app_id = affected.steam_app_id and estimate.provider = 'hltb'
    where estimate.match_status = 'no_duration'
      and (estimate.main_story_minutes is not null
        or estimate.main_extra_minutes is not null
        or estimate.completionist_minutes is not null)
  ),
  'reused_hltb_provider_ids', (select count(*) from reused_hltb_ids)
) as finalize_summary;
`;
}

function buildBatchSql(rows, batchNumber, options = {}) {
  const standalone = options.standalone === true;
  const stageJson = sqlStringLiteral(JSON.stringify(rows));
  const standalonePrefix = standalone
    ? `drop table if exists pg_temp._vaultshuffle_hltb_import_summary;
create temporary table _vaultshuffle_hltb_import_summary (
  batch_number integer not null,
  metric text not null,
  changed integer not null,
  details jsonb not null default '{}'::jsonb
) on commit preserve rows;

`
    : "";
  const transactionLock = standalone
    ? `select pg_catalog.pg_advisory_xact_lock(${IMPORT_LOCK_KEY_ONE}, ${IMPORT_LOCK_KEY_TWO});\n`
    : "";
  const standaloneSummary = standalone
    ? `
select coalesce(
  jsonb_agg(
    jsonb_build_object(
      'batch', batch_number,
      'metric', metric,
      'changed', changed,
      'details', details
    ) order by metric, details::text
  ),
  '[]'::jsonb
) as batch_summary
from _vaultshuffle_hltb_import_summary;
`
    : "";
  return `-- Batch ${batchNumber}: ${new Set(rows.map((row) => row.steam_app_id)).size} Steam AppIDs / ${rows.length} staged actions.
${standalonePrefix}begin isolation level read committed;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
${transactionLock}

create temporary table _vaultshuffle_hltb_stage (
  action text not null check (action in ('matched', 'no_duration', 'demote')),
  steam_app_id bigint not null check (steam_app_id > 0),
  provider_game_id bigint not null check (provider_game_id > 0),
  main_story_minutes integer,
  main_extra_minutes integer,
  completionist_minutes integer,
  submission_count integer,
  match_confidence text check (match_confidence in ('none', 'low', 'medium', 'high')),
  provider_updated_at timestamptz,
  checked_at timestamptz not null,
  next_refresh_at timestamptz,
  last_error_code text,
  verification_method text,
  verification_tier text,
  identity_confidence text,
  duration_basis text,
  duration_issues jsonb not null,
  mode_single_player boolean,
  mode_co_op boolean,
  mode_multiplayer boolean,
  evidence jsonb,
  demotion_reason text,
  check (
    (action = 'matched'
      and verification_method in ('profile_steam_exact', 'safe_exact_title', 'safe_exact_alias')
      and verification_tier in ('steam_appid', 'exact_title', 'mixed_script_title')
      and duration_basis in ('completion_times', 'all_styles', 'multiplayer_representative')
      and (main_story_minutes > 0 or main_extra_minutes > 0 or completionist_minutes > 0))
    or (action = 'no_duration'
      and verification_method in ('profile_steam_exact', 'safe_exact_title', 'safe_exact_alias')
      and verification_tier in ('steam_appid', 'exact_title', 'mixed_script_title')
      and duration_basis = 'no_duration'
      and main_story_minutes is null and main_extra_minutes is null and completionist_minutes is null)
    or (action = 'demote' and demotion_reason is not null)
  ),
  check (
    (
      action in ('matched', 'no_duration')
      and evidence is not null
      and jsonb_typeof(evidence) = 'object'
      and evidence = jsonb_build_object(
        'identity_validated', true,
        'identity_tier', verification_tier,
        'identity_confidence', identity_confidence,
        'duration_basis', duration_basis,
        'duration_issues', duration_issues,
        'hltb_modes', jsonb_build_object(
          'single_player', mode_single_player,
          'co_op', mode_co_op,
          'multiplayer', mode_multiplayer
        ),
        'verification_method', verification_method,
        'verification_tier', verification_tier,
        'verification_source', 'detail_page_validator'
      )
    )
    or (action = 'demote' and evidence is null)
  )
) on commit drop;

insert into _vaultshuffle_hltb_stage
select *
from jsonb_to_recordset(${stageJson}::jsonb) as input (
  action text,
  steam_app_id bigint,
  provider_game_id bigint,
  main_story_minutes integer,
  main_extra_minutes integer,
  completionist_minutes integer,
  submission_count integer,
  match_confidence text,
  provider_updated_at timestamptz,
  checked_at timestamptz,
  next_refresh_at timestamptz,
  last_error_code text,
  verification_method text,
  verification_tier text,
  identity_confidence text,
  duration_basis text,
  duration_issues jsonb,
  mode_single_player boolean,
  mode_co_op boolean,
  mode_multiplayer boolean,
  evidence jsonb,
  demotion_reason text
)
order by steam_app_id, action, provider_game_id;

create temporary table _vaultshuffle_hltb_eligibility on commit drop as
select
  stage.*,
  case
    when game.steam_appid is null then 'missing_catalogue'
    when quarantine.review_status = 'excluded' then 'excluded_quarantine'
    when game.duration_manual_override then 'manual_override'
    when job.status = 'processing' then 'processing_job'
    else 'eligible'
  end as decision
from _vaultshuffle_hltb_stage as stage
left join public.catalog_games as game
  on game.steam_appid = stage.steam_app_id
left join public.catalog_game_quarantine as quarantine
  on quarantine.steam_appid = stage.steam_app_id
left join public.game_duration_jobs as job
  on job.steam_app_id = stage.steam_app_id;

insert into _vaultshuffle_hltb_import_summary (batch_number, metric, changed, details)
select ${batchNumber}, 'skipped_' || decision, count(*), '{}'::jsonb
from _vaultshuffle_hltb_eligibility
where decision <> 'eligible'
group by decision;

insert into _vaultshuffle_hltb_import_summary (batch_number, metric, changed, details)
select
  ${batchNumber},
  'accepted_evidence',
  count(*),
  jsonb_build_object(
    'action', action,
    'verification_method', verification_method,
    'verification_tier', verification_tier,
    'identity_confidence', identity_confidence,
    'duration_basis', duration_basis,
    'single_player', mode_single_player,
    'co_op', mode_co_op,
    'multiplayer', mode_multiplayer
  )
from _vaultshuffle_hltb_eligibility
where decision = 'eligible' and action in ('matched', 'no_duration')
group by action, verification_method, verification_tier, identity_confidence,
  duration_basis, mode_single_player, mode_co_op, mode_multiplayer;

with targets as (
  select distinct on (estimate.steam_app_id)
    estimate.steam_app_id,
    stage.checked_at,
    stage.demotion_reason
  from _vaultshuffle_hltb_eligibility as stage
  join public.game_duration_estimates as estimate
    on estimate.steam_app_id = stage.steam_app_id
   and estimate.provider = 'hltb'
   and estimate.provider_game_id = stage.provider_game_id
  where stage.decision = 'eligible'
    and stage.action = 'demote'
  order by estimate.steam_app_id, stage.checked_at desc, stage.demotion_reason
), changed as (
  update public.game_duration_estimates as estimate
  set match_status = 'ambiguous',
      match_confidence = 'none',
      checked_at = target.checked_at,
      next_refresh_at = null,
      last_error_code = left('hltb_identity_' || target.demotion_reason, 80),
      updated_at = greatest(estimate.updated_at, target.checked_at)
  from targets as target
  where estimate.steam_app_id = target.steam_app_id
    and estimate.provider = 'hltb'
    and target.checked_at >= estimate.checked_at
    and row(
      estimate.match_status,
      estimate.match_confidence,
      estimate.checked_at,
      estimate.next_refresh_at,
      estimate.last_error_code,
      estimate.updated_at
    ) is distinct from row(
      'ambiguous'::text,
      'none'::text,
      target.checked_at,
      null::timestamptz,
      left('hltb_identity_' || target.demotion_reason, 80),
      greatest(estimate.updated_at, target.checked_at)
    )
  returning 1
)
insert into _vaultshuffle_hltb_import_summary
select ${batchNumber}, 'validator_rejections_demoted', count(*), '{}'::jsonb from changed;

with targets as (
  select stage.*
  from _vaultshuffle_hltb_eligibility as stage
  join public.game_duration_estimates as estimate
    on estimate.steam_app_id = stage.steam_app_id
   and estimate.provider = 'hltb'
  where stage.decision = 'eligible'
    and stage.action = 'matched'
    and estimate.provider_game_id is not null
    and estimate.provider_game_id is distinct from stage.provider_game_id
    and stage.checked_at >= estimate.checked_at
), changed as (
  update public.game_duration_estimates as estimate
  set match_status = 'ambiguous',
      match_confidence = 'none',
      checked_at = target.checked_at,
      next_refresh_at = null,
      last_error_code = 'hltb_provider_id_conflict',
      updated_at = greatest(estimate.updated_at, target.checked_at)
  from targets as target
  where estimate.steam_app_id = target.steam_app_id
    and estimate.provider = 'hltb'
    and row(
      estimate.match_status,
      estimate.match_confidence,
      estimate.checked_at,
      estimate.next_refresh_at,
      estimate.last_error_code,
      estimate.updated_at
    ) is distinct from row(
      'ambiguous'::text,
      'none'::text,
      target.checked_at,
      null::timestamptz,
      'hltb_provider_id_conflict'::text,
      greatest(estimate.updated_at, target.checked_at)
    )
  returning 1
)
insert into _vaultshuffle_hltb_import_summary
select ${batchNumber}, 'matched_id_conflicts_demoted', count(*), '{}'::jsonb from changed;

with targets as (
  select stage.*
  from _vaultshuffle_hltb_eligibility as stage
  join public.game_duration_estimates as estimate
    on estimate.steam_app_id = stage.steam_app_id
   and estimate.provider = 'hltb'
  where stage.decision = 'eligible'
    and stage.action = 'no_duration'
    and (
      estimate.provider_game_id is distinct from stage.provider_game_id
      or estimate.match_status = 'matched'
      or estimate.main_story_minutes is not null
      or estimate.main_extra_minutes is not null
      or estimate.completionist_minutes is not null
    )
    and stage.checked_at >= estimate.checked_at
), changed as (
  update public.game_duration_estimates as estimate
  set match_status = case
        when estimate.provider_game_id is distinct from target.provider_game_id then 'ambiguous'
        else 'needs_review'
      end,
      match_confidence = 'none',
      checked_at = target.checked_at,
      next_refresh_at = null,
      last_error_code = case
        when estimate.provider_game_id is distinct from target.provider_game_id
          then 'hltb_provider_id_conflict'
        else 'hltb_no_duration_conflict'
      end,
      updated_at = greatest(estimate.updated_at, target.checked_at)
  from targets as target
  where estimate.steam_app_id = target.steam_app_id
    and estimate.provider = 'hltb'
    and row(
      estimate.match_status,
      estimate.match_confidence,
      estimate.checked_at,
      estimate.next_refresh_at,
      estimate.last_error_code,
      estimate.updated_at
    ) is distinct from row(
      case when estimate.provider_game_id is distinct from target.provider_game_id
        then 'ambiguous'::text else 'needs_review'::text end,
      'none'::text,
      target.checked_at,
      null::timestamptz,
      case when estimate.provider_game_id is distinct from target.provider_game_id
        then 'hltb_provider_id_conflict'::text else 'hltb_no_duration_conflict'::text end,
      greatest(estimate.updated_at, target.checked_at)
    )
  returning 1
)
insert into _vaultshuffle_hltb_import_summary
select ${batchNumber}, 'no_duration_conflicts_demoted', count(*), '{}'::jsonb from changed;

with changed as (
  insert into public.game_duration_estimates as current (
    steam_app_id, provider, provider_game_id,
    main_story_minutes, main_extra_minutes, completionist_minutes,
    submission_count, match_status, match_confidence,
    provider_updated_at, checked_at, next_refresh_at,
    last_error_code, evidence, updated_at
  )
  select
    stage.steam_app_id, 'hltb', stage.provider_game_id,
    stage.main_story_minutes, stage.main_extra_minutes, stage.completionist_minutes,
    stage.submission_count, 'matched', stage.match_confidence,
    stage.provider_updated_at, stage.checked_at,
    coalesce(stage.next_refresh_at, stage.checked_at + interval '365 days'),
    null, stage.evidence, stage.checked_at
  from _vaultshuffle_hltb_eligibility as stage
  where stage.decision = 'eligible' and stage.action = 'matched'
  order by stage.steam_app_id
  on conflict (steam_app_id, provider) do update
  set provider_game_id = excluded.provider_game_id,
      main_story_minutes = excluded.main_story_minutes,
      main_extra_minutes = excluded.main_extra_minutes,
      completionist_minutes = excluded.completionist_minutes,
      submission_count = excluded.submission_count,
      match_status = 'matched',
      match_confidence = excluded.match_confidence,
      provider_updated_at = coalesce(excluded.provider_updated_at, current.provider_updated_at),
      checked_at = excluded.checked_at,
      next_refresh_at = excluded.next_refresh_at,
      last_error_code = null,
      evidence = excluded.evidence,
      updated_at = greatest(current.updated_at, excluded.checked_at)
  where excluded.checked_at >= current.checked_at
    and (current.provider_game_id is null or current.provider_game_id = excluded.provider_game_id)
    and row(
      current.provider_game_id,
      current.main_story_minutes,
      current.main_extra_minutes,
      current.completionist_minutes,
      current.submission_count,
      current.match_status,
      current.match_confidence,
      current.provider_updated_at,
      current.checked_at,
      current.next_refresh_at,
      current.last_error_code,
      current.evidence,
      current.updated_at
    ) is distinct from row(
      excluded.provider_game_id,
      excluded.main_story_minutes,
      excluded.main_extra_minutes,
      excluded.completionist_minutes,
      excluded.submission_count,
      'matched'::text,
      excluded.match_confidence,
      coalesce(excluded.provider_updated_at, current.provider_updated_at),
      excluded.checked_at,
      excluded.next_refresh_at,
      null::text,
      excluded.evidence,
      greatest(current.updated_at, excluded.checked_at)
    )
  returning 1
)
insert into _vaultshuffle_hltb_import_summary
select ${batchNumber}, 'matched_estimates_changed', count(*), '{}'::jsonb from changed;

with changed as (
  insert into public.game_duration_estimates as current (
    steam_app_id, provider, provider_game_id,
    main_story_minutes, main_extra_minutes, completionist_minutes,
    submission_count, match_status, match_confidence,
    provider_updated_at, checked_at, next_refresh_at,
    last_error_code, evidence, updated_at
  )
  select
    stage.steam_app_id, 'hltb', stage.provider_game_id,
    null, null, null,
    stage.submission_count, 'no_duration', stage.match_confidence,
    stage.provider_updated_at, stage.checked_at,
    coalesce(stage.next_refresh_at, stage.checked_at + interval '90 days'),
    'known_title_no_provider_times', stage.evidence, stage.checked_at
  from _vaultshuffle_hltb_eligibility as stage
  where stage.decision = 'eligible' and stage.action = 'no_duration'
  order by stage.steam_app_id
  on conflict (steam_app_id, provider) do update
  set submission_count = excluded.submission_count,
      match_status = 'no_duration',
      match_confidence = excluded.match_confidence,
      provider_updated_at = coalesce(excluded.provider_updated_at, current.provider_updated_at),
      checked_at = excluded.checked_at,
      next_refresh_at = excluded.next_refresh_at,
      last_error_code = 'known_title_no_provider_times',
      evidence = excluded.evidence,
      updated_at = greatest(current.updated_at, excluded.checked_at)
  where current.provider_game_id = excluded.provider_game_id
    and current.match_status <> 'matched'
    and current.main_story_minutes is null
    and current.main_extra_minutes is null
    and current.completionist_minutes is null
    and excluded.checked_at >= current.checked_at
    and row(
      current.submission_count,
      current.match_status,
      current.match_confidence,
      current.provider_updated_at,
      current.checked_at,
      current.next_refresh_at,
      current.last_error_code,
      current.evidence,
      current.updated_at
    ) is distinct from row(
      excluded.submission_count,
      'no_duration'::text,
      excluded.match_confidence,
      coalesce(excluded.provider_updated_at, current.provider_updated_at),
      excluded.checked_at,
      excluded.next_refresh_at,
      'known_title_no_provider_times'::text,
      excluded.evidence,
      greatest(current.updated_at, excluded.checked_at)
    )
  returning 1
)
insert into _vaultshuffle_hltb_import_summary
select ${batchNumber}, 'no_duration_estimates_changed', count(*), '{}'::jsonb from changed;

with affected as (
  select distinct steam_app_id
  from _vaultshuffle_hltb_eligibility
  where decision = 'eligible'
), ${hardenedFiniteCatalogueCte()}, desired_jobs as (
  select
    affected.steam_app_id,
    case
      when game.duration_manual_override
        or hardened.steam_app_id is not null
        or (game.duration_status = 'ready' and game.duration_kind in ('endless', 'not-applicable'))
      then 'completed'
      else 'needs_review'
    end as status,
    case
      when game.duration_manual_override
        or hardened.steam_app_id is not null
        or (game.duration_status = 'ready' and game.duration_kind in ('endless', 'not-applicable'))
      then null
      else coalesce(hltb.last_error_code, 'duration_review_required')
    end as last_error_code
  from affected
  join public.catalog_games as game on game.steam_appid = affected.steam_app_id
  left join hardened_finite_catalogue as hardened
    on hardened.steam_app_id = affected.steam_app_id
  left join public.game_duration_estimates as hltb
    on hltb.steam_app_id = affected.steam_app_id and hltb.provider = 'hltb'
), changed as (
  insert into public.game_duration_jobs as current (
    steam_app_id, status, priority, attempts, next_attempt_at,
    locked_at, locked_by, last_error_code, last_error_message, updated_at
  )
  select
    desired.steam_app_id, desired.status, 50, 0, null,
    null, null, desired.last_error_code, null, now()
  from desired_jobs as desired
  order by desired.steam_app_id
  on conflict (steam_app_id) do update
  set status = excluded.status,
      next_attempt_at = null,
      locked_at = null,
      locked_by = null,
      last_error_code = excluded.last_error_code,
      last_error_message = null,
      updated_at = now()
  where current.status <> 'processing'
    and row(
      current.status,
      current.next_attempt_at,
      current.locked_at,
      current.locked_by,
      current.last_error_code,
      current.last_error_message
    ) is distinct from row(
      excluded.status,
      null::timestamptz,
      null::timestamptz,
      null::text,
      excluded.last_error_code,
      null::text
    )
  returning 1
)
insert into _vaultshuffle_hltb_import_summary
select ${batchNumber}, 'duration_jobs_changed', count(*), '{}'::jsonb from changed;

commit;
${standaloneSummary}`;
}

function artifactFile(name, kind, content, appCount, rowCount, actions = {}) {
  return {
    name,
    kind,
    app_count: appCount,
    row_count: rowCount,
    action_counts: actions,
    sha256: sha256(content),
    content,
  };
}

function actionCounts(rows) {
  const counts = { matched: 0, no_duration: 0, demote: 0 };
  for (const row of rows) counts[row.action] += 1;
  return counts;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function batchByAppId(rows, batchSize) {
  const rowsByAppId = new Map();
  for (const row of rows) {
    const grouped = rowsByAppId.get(row.steam_app_id) ?? [];
    grouped.push(row);
    rowsByAppId.set(row.steam_app_id, grouped);
  }
  const appIds = [...rowsByAppId.keys()].sort((left, right) => left - right);
  const batches = [];
  for (let index = 0; index < appIds.length; index += batchSize) {
    const batchAppIds = appIds.slice(index, index + batchSize);
    batches.push(batchAppIds.flatMap((appId) => rowsByAppId.get(appId)).sort(stageRowSort));
  }
  return batches;
}

function dedupeStageRows(rows) {
  const unique = new Map();
  for (const row of rows) {
    const key = `${row.steam_app_id}:${row.provider_game_id}:${row.action}`;
    const current = unique.get(key);
    if (!current || row.checked_at > current.checked_at
        || (row.checked_at === current.checked_at && row.demotion_reason < current.demotion_reason)) {
      unique.set(key, row);
    }
  }
  return [...unique.values()].sort(stageRowSort);
}

function stageRowSort(left, right) {
  return left.steam_app_id - right.steam_app_id
    || left.action.localeCompare(right.action)
    || left.provider_game_id - right.provider_game_id;
}

function validateDurationValues(mainStory, mainExtra, completionist, prefix) {
  const values = [mainStory, mainExtra, completionist].filter((value) => value !== null);
  if (!values.length) throw new Error(`${prefix} has no positive duration value.`);
  if (values.some((value) => value > 120000)) throw new Error(`${prefix} exceeds the duration safety ceiling.`);
  if (mainStory && mainExtra && mainExtra < mainStory) {
    throw new Error(`${prefix} has main-extra below main-story.`);
  }
  const prior = mainExtra ?? mainStory;
  if (completionist && prior && completionist < prior) {
    throw new Error(`${prefix} has completionist below the prior duration tier.`);
  }
  if (mainStory && completionist && completionist >= mainStory * 12) {
    throw new Error(`${prefix} has an extreme completionist ratio.`);
  }
}

function normalizeModes(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.single_player !== "boolean"
      || typeof value.co_op !== "boolean"
      || typeof value.multiplayer !== "boolean") {
    throw new Error(`${name} must contain exact boolean mode flags.`);
  }
  return {
    single_player: value.single_player,
    co_op: value.co_op,
    multiplayer: value.multiplayer,
  };
}

function normalizeStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array.`);
  }
  return [...new Set(value.map((item) => cleanText(item)).filter(Boolean))];
}

function normalizeReason(value, name) {
  const reason = cleanText(value);
  if (!reason || !/^[a-z0-9_]{1,80}$/.test(reason)) throw new Error(`${name} is invalid.`);
  return reason;
}

function requiredConfidence(value, name) {
  if (!CONFIDENCE.has(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function optionalPositiveInteger(value, name) {
  if (value === null || value === undefined) return null;
  return requiredPositiveInteger(value, name);
}

function requiredPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function optionalNonNegativeInteger(value, name) {
  if (value === null || value === undefined) return null;
  return requiredNonNegativeInteger(value, name);
}

function requiredNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function optionalDate(value, name) {
  if (value === null || value === undefined || value === "") return null;
  return requiredDate(value, name);
}

function requiredDate(value, name) {
  if (typeof value !== "string") throw new Error(`${name} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${name} must be an ISO timestamp.`);
  return parsed.toISOString();
}

function parseBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be between 1 and ${MAX_BATCH_SIZE}.`);
  }
  return parsed;
}

function cleanText(value) {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned || null;
}

function cleanComment(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim() || "validator-report.json";
}

function sqlStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const outputDirectoryIndex = args.indexOf("--output-directory");
  const hasOutput = outputIndex >= 1 && Boolean(args[outputIndex + 1]);
  const hasOutputDirectory = outputDirectoryIndex >= 1 && Boolean(args[outputDirectoryIndex + 1]);
  if (hasOutput === hasOutputDirectory) {
    throw new Error(
      "Usage: node build-hltb-writeback-sql.mjs <validator.json> "
      + "(--output <writeback.sql> | --output-directory <directory>) [--batch-size 100]"
    );
  }
  const inputPath = path.resolve(args[0]);
  const batchIndex = args.indexOf("--batch-size");
  const batchSize = batchIndex === -1 ? DEFAULT_BATCH_SIZE : args[batchIndex + 1];
  const inputContent = await readFile(inputPath, "utf8");
  const document = JSON.parse(inputContent);
  const normalized = normalizeValidatorDocument(document, inputPath);

  if (hasOutput) {
    const outputPath = path.resolve(args[outputIndex + 1]);
    const sql = buildHltbWritebackSql(document, { batchSize, sourceName: inputPath });
    await writeFile(outputPath, sql, "utf8");
    console.log(JSON.stringify({
      stage: "hltb_writeback_sql_built",
      mode: "single_file",
      input_path: inputPath,
      output_path: outputPath,
      staged_actions: normalized.stageRows.length,
      staged_appids: new Set(normalized.stageRows.map((row) => row.steam_app_id)).size,
      validator_errors_ignored: normalized.errorCount,
      input_only_rejections_ignored: normalized.inputOnlyRejectionCount,
    }));
    return;
  }

  const outputDirectory = path.resolve(args[outputDirectoryIndex + 1]);
  await mkdir(outputDirectory, { recursive: true });
  const existingEntries = await readdir(outputDirectory);
  if (existingEntries.length) {
    throw new Error(`--output-directory must be empty: ${outputDirectory}`);
  }
  const artifacts = buildHltbWritebackDirectoryArtifacts(document, {
    batchSize,
    sourceName: path.basename(inputPath),
    sourceSha256: sha256(inputContent),
  });
  for (const file of artifacts.files) {
    await writeFile(path.join(outputDirectory, file.name), file.content, "utf8");
  }
  await writeFile(
    path.join(outputDirectory, "manifest.json"),
    artifacts.manifestContent,
    "utf8"
  );
  console.log(JSON.stringify({
    stage: "hltb_writeback_sql_directory_built",
    mode: "standalone_batches",
    input_path: inputPath,
    output_directory: outputDirectory,
    manifest_path: path.join(outputDirectory, "manifest.json"),
    batch_count: artifacts.manifest.batch_count,
    staged_actions: normalized.stageRows.length,
    staged_appids: new Set(normalized.stageRows.map((row) => row.steam_app_id)).size,
    validator_errors_ignored: normalized.errorCount,
    input_only_rejections_ignored: normalized.inputOnlyRejectionCount,
  }));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
