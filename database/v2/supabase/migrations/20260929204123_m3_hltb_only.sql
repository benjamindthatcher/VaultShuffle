-- HLTB is the only duration provider. No new state or provider archive.
-- Applied migrations remain immutable; this correction is additive.
begin;

-- An authored override remains an authored fact even if its old provenance
-- named IGDB. Strip that obsolete identity without relabelling it as HLTB.
update catalog.game_features
set duration_source = case when duration_manual_override then 'manual' else null end,
    duration_source_game_id = null, duration_source_updated_at = null,
    duration_confidence = null, duration_confidence_label = null,
    main_duration_minutes = case when duration_manual_override then main_duration_minutes end,
    extras_duration_minutes = case when duration_manual_override then extras_duration_minutes end,
    completion_duration_minutes = case when duration_manual_override then completion_duration_minutes end,
    duration_kind = case when duration_manual_override then duration_kind else 'unknown' end,
    duration_status = case when duration_manual_override then duration_status else 'unknown' end
where duration_source ~* 'igdb';
update catalog.game_features
set popularity_source = null, popularity_metric = null, popularity_rank = null,
    popularity_low = null, popularity_high = null, popularity_ccu = null,
    popularity_observed_on = null, source_captured_on = null
where popularity_source ~* 'igdb';

-- The legacy duration queue never recorded its provider. Its failures and
-- backoff cannot safely govern HLTB. Rebuild work from the remaining evidence.
delete from catalog.provider_state where provider ~* 'igdb' or (evidence_kind = 'duration' and provider = 'unknown');
delete from catalog.appid_terminal_rejections where provider ~* 'igdb' or (evidence_kind = 'duration' and provider = 'unknown');
delete from migration.legacy_duration_job_archive;
delete from catalog.duration_estimates where provider ~* 'igdb';
delete from catalog.duration_imports where source ~* 'igdb';

alter table catalog.duration_estimates add constraint duration_estimates_hltb_only check (provider = 'hltb');
alter table catalog.duration_imports add constraint duration_imports_no_igdb check (source !~* 'igdb');
alter table catalog.provider_state add constraint provider_state_no_igdb check (provider !~* 'igdb');
alter table catalog.appid_terminal_rejections add constraint terminal_rejections_no_igdb check (provider !~* 'igdb');
alter table catalog.game_features
  add constraint game_features_duration_no_igdb check (duration_source is null or duration_source !~* 'igdb'),
  add constraint game_features_popularity_no_igdb check (popularity_source is null or popularity_source !~* 'igdb');

-- Mirrors the existing reviewed HLTB writeback's finite eligibility rules.
-- Stored but rejected evidence is useful for HLTB review, never a ready value.
create function catalog.hltb_estimate_is_eligible(e catalog.duration_estimates)
returns boolean language sql immutable security invoker
set search_path = pg_catalog, catalog
as $$
  select coalesce(
    e.provider = 'hltb' and e.match_status = 'matched' and e.provider_game_id > 0
    and e.evidence @> '{"identity_validated":true}'::jsonb
    and ((e.evidence->>'verification_method' = 'profile_steam_exact' and e.evidence->>'verification_tier' = 'steam_appid')
      or (e.evidence->>'verification_method' in ('safe_exact_title','safe_exact_alias')
        and e.evidence->>'verification_tier' in ('exact_title','mixed_script_title')))
    and (e.match_confidence in ('medium','high') or (
      e.match_confidence = 'low'
      and e.evidence->>'verification_method' = 'profile_steam_exact'
      and e.evidence->>'verification_tier' = 'steam_appid'
      and e.evidence->>'duration_basis' = 'completion_times'
      and e.evidence->'duration_issues' = '[]'::jsonb
      and (coalesce(e.submission_count,0) >= 2 or
        ((e.main_story_minutes is not null)::int + (e.main_extra_minutes is not null)::int
          + (e.completionist_minutes is not null)::int) >= 2)))
    and (e.main_story_minutes > 0 or e.main_extra_minutes > 0 or e.completionist_minutes > 0)
    and (e.main_story_minutes is null or e.main_story_minutes between 1 and 120000)
    and (e.main_extra_minutes is null or e.main_extra_minutes between 1 and 120000)
    and (e.completionist_minutes is null or e.completionist_minutes between 1 and 120000)
    and (e.main_story_minutes is null or e.main_extra_minutes is null or e.main_extra_minutes >= e.main_story_minutes)
    and (e.completionist_minutes is null or coalesce(e.main_extra_minutes,e.main_story_minutes) is null
      or e.completionist_minutes >= coalesce(e.main_extra_minutes,e.main_story_minutes))
    and (e.main_story_minutes is null or e.completionist_minutes is null
      or e.completionist_minutes::bigint < e.main_story_minutes::bigint * 12), false);
$$;

-- Operator-only, explicit reconciliation after an HLTB writeback, in that
-- same transaction. No definer privileges, hosted worker or automatic timer.
create function catalog.reconcile_hltb_duration(p_game_id integer)
returns void language sql security invoker
set search_path = pg_catalog, catalog
as $$
  with candidate as (
    select e.*, catalog.hltb_estimate_is_eligible(e) as eligible
    from catalog.games g
    left join catalog.duration_estimates e on e.steam_app_id = g.steam_app_id and e.provider = 'hltb'
      and (e.game_id is null or e.game_id = g.id)
    where g.id = p_game_id
  )
  update catalog.game_features f
  set main_duration_minutes = case when c.eligible then c.main_story_minutes end,
      extras_duration_minutes = case when c.eligible then c.main_extra_minutes end,
      completion_duration_minutes = case when c.eligible then c.completionist_minutes end,
      duration_source = case when c.eligible then 'hltb' end,
      duration_source_game_id = case when c.eligible then c.provider_game_id end,
      duration_source_updated_at = case when c.eligible then c.provider_updated_at end,
      duration_confidence = null,
      duration_confidence_label = case when c.eligible then c.match_confidence end,
      duration_status = case when c.eligible then 'ready' when c.provider is not null then 'review_required' else 'unknown' end,
      duration_kind = case when c.eligible then 'finite' else 'unknown' end
  from candidate c
  where f.game_id = p_game_id and not f.duration_manual_override
    and f.duration_kind not in ('endless','not-applicable');
$$;
revoke all on function catalog.hltb_estimate_is_eligible(catalog.duration_estimates) from public, vault_app, vault_worker;
revoke all on function catalog.reconcile_hltb_duration(integer) from public, vault_app, vault_worker;

-- Rebuild existing automatic finite projections; manual and independent
-- nonfinite decisions are intentionally preserved.
select catalog.reconcile_hltb_duration(game_id) from catalog.game_features
where not duration_manual_override and duration_kind not in ('endless','not-applicable');

update ops.data_retention_registry
set rationale = 'HLTB observations only. Rejected HLTB evidence is retained for review; obsolete IGDB payloads are discarded.'
where relation = 'catalog.duration_estimates'::regclass;
update ops.data_retention_registry
set rationale = 'Obsolete unattributed duration retry queue is rebuilt; no legacy rows are loaded or retained.'
where relation = 'migration.legacy_duration_job_archive'::regclass;
commit;
