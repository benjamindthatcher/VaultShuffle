-- Verifies the additive cleanup against the pre-migration synthetic seed.
do $$
begin
  if exists(select 1 from catalog.duration_estimates where provider<>'hltb')
    or exists(select 1 from catalog.duration_imports where source ~* 'igdb')
    or exists(select 1 from catalog.provider_state where evidence_kind='duration' and provider='unknown')
    or exists(select 1 from migration.legacy_duration_job_archive) then
    raise exception 'obsolete provider evidence or retry state survived';
  end if;
  if not exists(select 1 from catalog.game_features f join catalog.games g on g.id=f.game_id
    where g.steam_app_id=3999999001 and f.main_duration_minutes is null and f.duration_source is null
      and f.duration_kind='unknown' and f.duration_status='unknown' and f.duration_confidence is null) then
    raise exception 'IGDB-only projection was retained';
  end if;
  if not exists(select 1 from catalog.game_features f join catalog.games g on g.id=f.game_id
    where g.steam_app_id=3999999002 and f.duration_manual_override and f.main_duration_minutes=111
      and f.extras_duration_minutes=222 and f.completion_duration_minutes=333 and f.duration_source='manual'
      and f.duration_source_game_id is null and f.duration_kind='finite') then
    raise exception 'manual override was lost or relabelled as HLTB';
  end if;
  if not exists(select 1 from catalog.game_features f join catalog.games g on g.id=f.game_id
    where g.steam_app_id=3999999003 and f.main_duration_minutes=600 and f.duration_source='hltb'
      and f.duration_source_game_id=123 and f.duration_status='ready' and f.duration_kind='finite') then
    raise exception 'valid HLTB was not projected';
  end if;
  if not exists(select 1 from catalog.game_features f join catalog.games g on g.id=f.game_id
    where g.steam_app_id=3999999004 and f.main_duration_minutes is null and f.duration_source is null
      and f.duration_status='review_required' and f.duration_kind='unknown') then
    raise exception 'unvalidated HLTB projected ready';
  end if;
  if not exists(select 1 from catalog.game_features f join catalog.games g on g.id=f.game_id
    where g.steam_app_id=3999999005 and f.duration_kind='endless' and f.main_duration_minutes=111) then
    raise exception 'independent nonfinite classification changed';
  end if;
  if not exists(select 1 from catalog.provider_state where provider='hltb' and evidence_kind='duration' and failure_count=3) then
    raise exception 'attributed HLTB state was lost';
  end if;
  if exists(select 1 from catalog.game_features where popularity_source ~* 'igdb') then
    raise exception 'IGDB popularity survived';
  end if;
end $$;

begin;
do $$
declare gid integer; e catalog.duration_estimates; n integer; role_name text;
begin
  select id into gid from catalog.games where steam_app_id=3999999003;
  select * into e from catalog.duration_estimates where game_id=gid;
  if not catalog.hltb_estimate_is_eligible(e) then raise exception 'valid HLTB rejected'; end if;
  e.match_confidence='low'; e.submission_count=1;
  e.evidence=e.evidence||'{"duration_basis":"completion_times","duration_issues":[]}'::jsonb;
  if not catalog.hltb_estimate_is_eligible(e) then raise exception 'strong low HLTB rejected'; end if;
  e.main_extra_minutes=null; e.completionist_minutes=null;
  if catalog.hltb_estimate_is_eligible(e) then raise exception 'thin low HLTB accepted'; end if;
  e.submission_count=2;
  if not catalog.hltb_estimate_is_eligible(e) then raise exception 'sufficient low HLTB rejected'; end if;
  e.evidence=e.evidence||'{"duration_issues":["mismatch"]}'::jsonb;
  if catalog.hltb_estimate_is_eligible(e) then raise exception 'dirty low HLTB accepted'; end if;
  e.match_confidence='high'; e.main_extra_minutes=500;
  if catalog.hltb_estimate_is_eligible(e) then raise exception 'incoherent tiers accepted'; end if;
  e.main_extra_minutes=900; e.completionist_minutes=7200;
  if catalog.hltb_estimate_is_eligible(e) then raise exception 'implausible multiplier accepted'; end if;
  e.completionist_minutes=1200; e.evidence='{}';
  if catalog.hltb_estimate_is_eligible(e) then raise exception 'missing identity accepted'; end if;

  -- Reconciliation is explicit and protects an override even when estimates change.
  update catalog.game_features set duration_manual_override=true,main_duration_minutes=777 where game_id=gid;
  update catalog.duration_estimates set main_story_minutes=650 where game_id=gid;
  perform catalog.reconcile_hltb_duration(gid);
  if not exists(select 1 from catalog.game_features where game_id=gid and main_duration_minutes=777) then
    raise exception 'reconciliation overwrote manual override';
  end if;
  update catalog.game_features set duration_manual_override=false where game_id=gid;
  perform catalog.reconcile_hltb_duration(gid);
  if not exists(select 1 from catalog.game_features where game_id=gid and main_duration_minutes=650) then
    raise exception 'explicit HLTB writeback did not refresh';
  end if;
  delete from catalog.duration_estimates where game_id=gid;
  perform catalog.reconcile_hltb_duration(gid);
  if not exists(select 1 from catalog.game_features where game_id=gid and duration_kind='unknown' and main_duration_minutes is null) then
    raise exception 'missing HLTB left stale values';
  end if;
  begin
    insert into catalog.duration_estimates(steam_app_id,provider,match_status,checked_at,created_at,updated_at)
    values(3999999003,'igdb','matched',now(),now(),now());
    raise exception 'IGDB can be reintroduced';
  exception when check_violation then null;
  end;
  begin
    update catalog.game_features set duration_source='igdb-title' where game_id=gid;
    raise exception 'IGDB projection can be reintroduced';
  exception when check_violation then null;
  end;
  foreach role_name in array array['vault_app','vault_worker','anon','authenticated'] loop
    if to_regrole(role_name) is not null and
      (has_function_privilege(role_name,'catalog.reconcile_hltb_duration(integer)','EXECUTE')
       or has_function_privilege(role_name,'catalog.hltb_estimate_is_eligible(catalog.duration_estimates)','EXECUTE')) then
      raise exception 'runtime role can invoke operator duration correction: %',role_name;
    end if;
  end loop;
  execute 'set local role vault_app';
  begin
    perform catalog.reconcile_hltb_duration(gid);
    raise exception 'app can mutate shared durations';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
end $$;
rollback;
-- Remove the committed synthetic pre-migration seed before other fixtures.
delete from catalog.duration_estimates where steam_app_id between 3999999001 and 3999999005;
delete from catalog.games where steam_app_id between 3999999001 and 3999999005;
