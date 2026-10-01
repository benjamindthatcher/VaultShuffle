import { createHash } from 'node:crypto';

const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const sha256 = value => createHash('sha256').update(value).digest('hex');
const guard = `do $guard$ begin
  if (select expected_project_ref from ops.project_marker where marker) is distinct from 'vbjtbwelnhbbdfrqczyf'
    then raise exception 'Wrong HLTB writeback target'; end if;
end $guard$;`;

/** Use the shared detail-page normalizer; this only changes destination SQL. */
export function buildV2Artifacts(normalized, options) {
  const { batchSize, sourceName, sourceSha256 } = options;
  const groups = [];
  for (const row of normalized.stageRows) {
    if (!groups.length || (new Set(groups.at(-1).map(x => x.steam_app_id)).size >= batchSize
      && groups.at(-1).at(-1).steam_app_id !== row.steam_app_id)) groups.push([]);
    groups.at(-1).push(row);
  }
  const files = [{ name: 'setup.sql', role: 'setup', content: `-- V2 HLTB operator-only writeback. No runtime role may apply this SQL.\n${guard}\n` }];
  for (const [index, rows] of groups.entries()) files.push({
    name: `batch-${String(index + 1).padStart(4, '0')}.sql`, role: 'batch', content: batchSql(rows),
    staged_app_count: new Set(rows.map(row => row.steam_app_id)).size, staged_row_count: rows.length,
  });
  files.push({ name: 'finalize.sql', role: 'finalize', content: `${guard}\nselect count(*) as eligible_hltb_estimates from catalog.duration_estimates e where catalog.hltb_estimate_is_eligible(e);\n` });
  const manifest = { schema_version: 1, kind: 'vaultshuffle_hltb_validator_writeback', target: 'v2',
    source: sourceName, source_sha256: sourceSha256, batch_size: batchSize, batch_count: groups.length,
    staged_app_count: new Set(normalized.stageRows.map(row => row.steam_app_id)).size,
    staged_row_count: normalized.stageRows.length, validator_errors_ignored: normalized.errorCount,
    input_only_rejections_ignored: normalized.inputOnlyRejectionCount, replay_safe: true,
    execution_model: 'standalone_read_committed_batches_with_transaction_advisory_lock',
    files: files.map(({ content, ...entry }) => ({ ...entry, sha256: sha256(content) })) };
  return { files, manifest, manifestContent: JSON.stringify(manifest, null, 2) + '\n' };
}

function batchSql(rows) {
  return `begin isolation level read committed;
set local lock_timeout='5s';
set local statement_timeout='60s';
${guard}
do $lock$ begin
  if not pg_try_advisory_xact_lock(1448236628,1213482818) then
    raise exception 'Another VaultShuffle HLTB writeback is active'; end if;
end $lock$;
create temporary table _hltb_stage on commit drop as
select * from jsonb_to_recordset(${literal(JSON.stringify(rows))}::jsonb) as s(
  action text,steam_app_id bigint,provider_game_id bigint,main_story_minutes integer,
  main_extra_minutes integer,completionist_minutes integer,submission_count integer,
  match_confidence text,provider_updated_at timestamptz,checked_at timestamptz,
  next_refresh_at timestamptz,last_error_code text,evidence jsonb,demotion_reason text);
-- Lock the same catalogue rows as review save/undo. Preserve quarantine and overrides.
select g.id from catalog.games g join _hltb_stage s on s.steam_app_id=g.steam_app_id
  order by g.id for update of g;
create temporary table _hltb_eligible on commit drop as
select s.*,g.id as game_id from _hltb_stage s
join catalog.games g on g.steam_app_id=s.steam_app_id
join catalog.game_features f on f.game_id=g.id
where not f.duration_manual_override and not exists(select 1 from catalog.review_decisions r
  where r.steam_app_id=s.steam_app_id and r.decision_kind='quarantine' and r.decision_status='excluded');
-- Validator rejection demotes only its exact stored identity, never a newer match.
update catalog.duration_estimates e set match_status='ambiguous',match_confidence='none',
  checked_at=s.checked_at,next_refresh_at=null,last_error_code=left('hltb_identity_'||s.demotion_reason,80),
  updated_at=greatest(e.updated_at,s.checked_at)
from _hltb_eligible s where s.action='demote' and e.steam_app_id=s.steam_app_id
  and e.provider='hltb' and e.provider_game_id=s.provider_game_id and s.checked_at>=e.checked_at;
-- Different page IDs or loss of established times are review conflicts, not replacements.
update catalog.duration_estimates e set
  match_status=case when e.provider_game_id is distinct from s.provider_game_id then 'ambiguous' else 'needs_review' end,
  match_confidence='none',checked_at=s.checked_at,next_refresh_at=null,
  last_error_code=case when e.provider_game_id is distinct from s.provider_game_id then 'hltb_provider_id_conflict' else 'hltb_no_duration_conflict' end,
  updated_at=greatest(e.updated_at,s.checked_at)
from _hltb_eligible s where s.action in('matched','no_duration')
  and e.steam_app_id=s.steam_app_id and e.provider='hltb' and s.checked_at>=e.checked_at
  and ((e.provider_game_id is not null and e.provider_game_id is distinct from s.provider_game_id)
    or (s.action='no_duration' and (e.match_status='matched' or e.main_story_minutes is not null
      or e.main_extra_minutes is not null or e.completionist_minutes is not null)));
insert into catalog.duration_estimates as current(game_id,steam_app_id,provider,provider_game_id,
  main_story_minutes,main_extra_minutes,completionist_minutes,submission_count,match_status,
  match_confidence,provider_updated_at,checked_at,next_refresh_at,last_error_code,evidence,created_at,updated_at)
select game_id,steam_app_id,'hltb',provider_game_id,main_story_minutes,main_extra_minutes,
  completionist_minutes,submission_count,case when action='matched' then 'matched' else 'no_duration' end,
  match_confidence,provider_updated_at,checked_at,
  coalesce(next_refresh_at,checked_at+case when action='matched' then interval '365 days' else interval '90 days' end),
  last_error_code,evidence,checked_at,checked_at
from _hltb_eligible where action in('matched','no_duration')
on conflict(steam_app_id,provider) do update set game_id=excluded.game_id,
  provider_game_id=excluded.provider_game_id,main_story_minutes=excluded.main_story_minutes,
  main_extra_minutes=excluded.main_extra_minutes,completionist_minutes=excluded.completionist_minutes,
  submission_count=excluded.submission_count,match_status=excluded.match_status,
  match_confidence=excluded.match_confidence,provider_updated_at=coalesce(excluded.provider_updated_at,current.provider_updated_at),
  checked_at=excluded.checked_at,next_refresh_at=excluded.next_refresh_at,
  last_error_code=excluded.last_error_code,evidence=excluded.evidence,updated_at=greatest(current.updated_at,excluded.checked_at)
where excluded.checked_at>=current.checked_at
  and (current.provider_game_id is null or current.provider_game_id=excluded.provider_game_id)
  and (excluded.match_status='matched' or (current.match_status<>'matched'
    and current.main_story_minutes is null and current.main_extra_minutes is null and current.completionist_minutes is null));
-- Existing resolver preserves manual/nonfinite decisions and rejects invalid evidence.
create temporary table _hltb_before on commit drop as select f.* from catalog.game_features f
  where f.game_id in(select game_id from _hltb_eligible);
select catalog.reconcile_hltb_duration(game_id) from (select distinct game_id from _hltb_eligible) g;
update catalog.game_features f set feature_revision=f.feature_revision+1,updated_at=now()
from _hltb_before b where f.game_id=b.game_id and
  row(f.main_duration_minutes,f.extras_duration_minutes,f.completion_duration_minutes,
    f.duration_kind,f.duration_status,f.duration_source,f.duration_source_game_id,f.duration_source_updated_at,f.duration_confidence_label)
  is distinct from row(b.main_duration_minutes,b.extras_duration_minutes,b.completion_duration_minutes,
    b.duration_kind,b.duration_status,b.duration_source,b.duration_source_game_id,b.duration_source_updated_at,b.duration_confidence_label);
select count(*) as staged_rows from _hltb_stage;
commit;
`;
}
