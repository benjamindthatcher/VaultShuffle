-- Accept a final narrow low-sample IGDB tier for clearly finite story games.
-- Identity must come from IGDB's unique Steam external-game mapping. The row
-- must supply all three coherent tiers, Steam must corroborate a single-player
-- story without multiplayer or sandbox signals, and the estimate remains low
-- confidence because it has one submission.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '10min';

lock table public.game_duration_estimates in share mode;
lock table public.catalog_game_quarantine in share mode;
lock table public.catalog_games in share row exclusive mode;
lock table public.game_duration_jobs in row exclusive mode;

create temporary table pg_temp.strict_story_igdb_protected_before
on commit drop
as
select game.steam_appid, pg_catalog.to_jsonb(game) as protected_row
from public.catalog_games as game
where game.duration_manual_override
   or exists (
     select 1
     from public.catalog_game_quarantine as quarantine
     where quarantine.steam_appid = game.steam_appid
       and quarantine.review_status = 'excluded'
   );

create temporary table pg_temp.strict_story_igdb_evidence_guard
on commit drop
as
select
  count(*) as estimate_rows,
  coalesce(sum(pg_catalog.hashtextextended(
    pg_catalog.to_jsonb(estimate)::text, 0
  )::numeric), 0::numeric) as evidence_fingerprint
from public.game_duration_estimates as estimate;

create temporary table pg_temp.strict_story_igdb_quarantine_guard
on commit drop
as
select
  count(*) as quarantine_rows,
  coalesce(sum(pg_catalog.hashtextextended(
    pg_catalog.to_jsonb(quarantine)::text, 0
  )::numeric), 0::numeric) as quarantine_fingerprint
from public.catalog_game_quarantine as quarantine;

create or replace function public.reconcile_catalogue_duration(
  p_steam_app_id bigint,
  p_estimate_removed boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  projected_game public.catalog_games%rowtype;
  low_sample public.game_duration_estimates%rowtype;
begin
  perform public.reconcile_catalogue_duration_v2(
    p_steam_app_id,
    p_estimate_removed
  );

  select *
  into projected_game
  from public.catalog_games
  where steam_appid = p_steam_app_id
  for update;

  if not found
    or projected_game.duration_manual_override
    or projected_game.duration_kind in ('endless', 'not-applicable')
    or (
      projected_game.duration_status = 'ready'
      and projected_game.duration_kind = 'finite'
    )
  then
    return;
  end if;

  if exists (
    select 1
    from public.catalog_game_quarantine as quarantine
    where quarantine.steam_appid = p_steam_app_id
      and quarantine.review_status = 'excluded'
  ) then
    return;
  end if;

  select estimate.*
  into low_sample
  from public.game_duration_estimates as estimate
  where estimate.steam_app_id = p_steam_app_id
    and estimate.match_status = 'matched'
    and estimate.match_confidence = 'low'
    and estimate.provider_game_id is not null
    and (
      estimate.main_story_minutes > 0
      or estimate.main_extra_minutes > 0
      or estimate.completionist_minutes > 0
    )
    and (
      estimate.main_story_minutes is null
      or estimate.main_story_minutes between 1 and 120000
    )
    and (
      estimate.main_extra_minutes is null
      or estimate.main_extra_minutes between 1 and 120000
    )
    and (
      estimate.completionist_minutes is null
      or estimate.completionist_minutes between 1 and 120000
    )
    and (
      estimate.main_story_minutes is null
      or estimate.main_extra_minutes is null
      or estimate.main_extra_minutes >= estimate.main_story_minutes
    )
    and (
      estimate.completionist_minutes is null
      or coalesce(
        estimate.main_extra_minutes,
        estimate.main_story_minutes
      ) is null
      or estimate.completionist_minutes >= coalesce(
        estimate.main_extra_minutes,
        estimate.main_story_minutes
      )
    )
    and (
      estimate.main_story_minutes is null
      or estimate.completionist_minutes is null
      or estimate.completionist_minutes::bigint
        < estimate.main_story_minutes::bigint * 12
    )
    and (
      (
        estimate.provider = 'hltb'
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
        and (
          (
            coalesce(estimate.submission_count, 0) between 2 and 4
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
          or (
            coalesce(estimate.submission_count, 0) = 1
            and estimate.main_story_minutes between 30 and 30000
            and estimate.main_extra_minutes
              between estimate.main_story_minutes and 30000
            and estimate.completionist_minutes
              between estimate.main_extra_minutes and 30000
            and estimate.main_extra_minutes::bigint
              <= estimate.main_story_minutes::bigint * 4
            and estimate.completionist_minutes::bigint
              <= estimate.main_extra_minutes::bigint * 3
            and estimate.completionist_minutes::bigint
              <= estimate.main_story_minutes::bigint * 6
            and lower(btrim(coalesce(projected_game.steam_type, ''))) = 'game'
            and coalesce(projected_game.review_total, 0) >= 100
            and exists (
              select 1
              from unnest(
                coalesce(projected_game.categories, array[]::text[])
              ) as category(value)
              where lower(btrim(category.value)) in (
                'single-player', 'single player'
              )
            )
            and not exists (
              select 1
              from unnest(
                coalesce(projected_game.categories, array[]::text[])
              ) as category(value)
              where lower(btrim(category.value)) in (
                'multi-player', 'multiplayer', 'online co-op', 'co-op',
                'mmo', 'pvp', 'online pvp'
              )
            )
            and exists (
              select 1
              from pg_catalog.jsonb_object_keys(
                coalesce(projected_game.tags, '{}'::jsonb)
              ) as tag(value)
              where lower(btrim(tag.value)) in (
                'story rich', 'campaign', 'visual novel', 'multiple endings',
                'choices matter', 'narrative', 'linear'
              )
            )
            and not exists (
              select 1
              from pg_catalog.jsonb_object_keys(
                coalesce(projected_game.tags, '{}'::jsonb)
              ) as tag(value)
              where lower(btrim(tag.value)) in (
                'sandbox', 'open world survival craft', 'colony sim',
                'life sim', 'city builder', 'god game', 'automation'
              )
            )
          )
        )
        and lower(projected_game.name) !~
          '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
        and (
          estimate.evidence @>
            '{"duplicate_provider_id_validated": true}'::jsonb
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
  order by
    case estimate.provider when 'hltb' then 2 when 'igdb' then 1 else 0 end desc,
    (
      (estimate.main_story_minutes is not null)::int
      + (estimate.main_extra_minutes is not null)::int
      + (estimate.completionist_minutes is not null)::int
    ) desc,
    coalesce(estimate.submission_count, 0) desc,
    estimate.checked_at desc nulls last,
    estimate.provider_game_id asc
  limit 1;

  if not found then
    return;
  end if;

  update public.catalog_games
  set main_story_minutes = low_sample.main_story_minutes,
      main_extras_minutes = low_sample.main_extra_minutes,
      completionist_minutes = low_sample.completionist_minutes,
      duration_source = low_sample.provider,
      duration_source_game_id = low_sample.provider_game_id::text,
      duration_source_updated_at = coalesce(
        low_sample.provider_updated_at,
        low_sample.checked_at
      ),
      duration_confidence = 'low',
      duration_status = 'ready',
      duration_kind = 'finite',
      updated_at = now()
  where steam_appid = p_steam_app_id
    and row(
      main_story_minutes,
      main_extras_minutes,
      completionist_minutes,
      duration_source,
      duration_source_game_id,
      duration_source_updated_at,
      duration_confidence,
      duration_status,
      duration_kind
    ) is distinct from row(
      low_sample.main_story_minutes,
      low_sample.main_extra_minutes,
      low_sample.completionist_minutes,
      low_sample.provider,
      low_sample.provider_game_id::text,
      coalesce(low_sample.provider_updated_at, low_sample.checked_at),
      'low'::text,
      'ready'::text,
      'finite'::text
    );
end;
$$;

revoke all on function public.reconcile_catalogue_duration(bigint, boolean)
  from public, anon, authenticated;
grant execute on function public.reconcile_catalogue_duration(bigint, boolean)
  to service_role;

comment on function public.reconcile_catalogue_duration(bigint, boolean) is
  'Projects hardened evidence plus narrowly accepted low-sample exact-Steam HLTB and direct IGDB estimates, including strict single-submission story rows; preserves manual, excluded and nonfinite rows.';

create temporary table pg_temp.strict_story_igdb_plan
on commit drop
as
select distinct estimate.steam_app_id
from public.game_duration_estimates as estimate
join public.catalog_games as game
  on game.steam_appid = estimate.steam_app_id
where game.duration_status = 'review_required'
  and game.duration_kind = 'unknown'
  and not game.duration_manual_override
  and estimate.provider = 'igdb'
  and estimate.match_status = 'matched'
  and estimate.match_confidence = 'low'
  and estimate.provider_game_id is not null
  and coalesce(estimate.submission_count, 0) = 1
  and estimate.main_story_minutes between 30 and 30000
  and estimate.main_extra_minutes
    between estimate.main_story_minutes and 30000
  and estimate.completionist_minutes
    between estimate.main_extra_minutes and 30000
  and estimate.main_extra_minutes::bigint
    <= estimate.main_story_minutes::bigint * 4
  and estimate.completionist_minutes::bigint
    <= estimate.main_extra_minutes::bigint * 3
  and estimate.completionist_minutes::bigint
    <= estimate.main_story_minutes::bigint * 6
  and lower(btrim(coalesce(game.steam_type, ''))) = 'game'
  and coalesce(game.review_total, 0) >= 100
  and lower(game.name) !~
    '(^|[^a-z0-9])(demo|playtest|prologue|alpha|beta|soundtrack|server|content[ -]?pack)([^a-z0-9]|$)'
  and exists (
    select 1
    from unnest(coalesce(game.categories, array[]::text[])) as category(value)
    where lower(btrim(category.value)) in ('single-player', 'single player')
  )
  and not exists (
    select 1
    from unnest(coalesce(game.categories, array[]::text[])) as category(value)
    where lower(btrim(category.value)) in (
      'multi-player', 'multiplayer', 'online co-op', 'co-op',
      'mmo', 'pvp', 'online pvp'
    )
  )
  and exists (
    select 1
    from pg_catalog.jsonb_object_keys(coalesce(game.tags, '{}'::jsonb))
      as tag(value)
    where lower(btrim(tag.value)) in (
      'story rich', 'campaign', 'visual novel', 'multiple endings',
      'choices matter', 'narrative', 'linear'
    )
  )
  and not exists (
    select 1
    from pg_catalog.jsonb_object_keys(coalesce(game.tags, '{}'::jsonb))
      as tag(value)
    where lower(btrim(tag.value)) in (
      'sandbox', 'open world survival craft', 'colony sim', 'life sim',
      'city builder', 'god game', 'automation'
    )
  )
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
  and not exists (
    select 1
    from public.catalog_game_quarantine as quarantine
    where quarantine.steam_appid = game.steam_appid
      and quarantine.review_status = 'excluded'
  );

alter table pg_temp.strict_story_igdb_plan
  add primary key (steam_app_id);

do $$
declare
  planned_count bigint;
  affected record;
begin
  select count(*) into planned_count
  from pg_temp.strict_story_igdb_plan;

  if planned_count <> 213 then
    raise exception 'strict story IGDB plan changed: expected 213, found %',
      planned_count;
  end if;

  for affected in
    select steam_app_id
    from pg_temp.strict_story_igdb_plan
    order by steam_app_id
  loop
    perform public.reconcile_catalogue_duration(affected.steam_app_id, false);
  end loop;
end;
$$;

with desired as (
  select
    plan.steam_app_id,
    case
      when game.duration_status = 'ready'
        and game.duration_kind in ('finite', 'endless', 'not-applicable')
      then 'completed'
      else 'needs_review'
    end as status
  from pg_temp.strict_story_igdb_plan as plan
  join public.catalog_games as game
    on game.steam_appid = plan.steam_app_id
)
update public.game_duration_jobs as job
set status = desired.status,
    next_attempt_at = null,
    locked_at = null,
    locked_by = null,
    last_error_code = case
      when desired.status = 'completed' then null
      else 'duration_review_required'
    end,
    last_error_message = null,
    updated_at = now()
from desired
where desired.steam_app_id = job.steam_app_id
  and job.status <> 'processing'
  and row(
    job.status,
    job.next_attempt_at,
    job.locked_at,
    job.locked_by,
    job.last_error_code,
    job.last_error_message
  ) is distinct from row(
    desired.status,
    null::timestamptz,
    null::timestamptz,
    null::text,
    case when desired.status = 'completed'
      then null else 'duration_review_required' end,
    null::text
  );

do $$
begin
  if exists (
    select 1
    from pg_temp.strict_story_igdb_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_app_id
    where game.duration_status <> 'ready'
       or game.duration_kind <> 'finite'
       or not (
         game.main_story_minutes > 0
         or game.main_extras_minutes > 0
         or game.completionist_minutes > 0
       )
  ) then
    raise exception 'a strict story IGDB candidate did not resolve finite';
  end if;

  if exists (
    select 1
    from pg_temp.strict_story_igdb_plan as plan
    join public.game_duration_jobs as job
      on job.steam_app_id = plan.steam_app_id
    where job.status <> 'completed'
  ) then
    raise exception 'a strict story IGDB candidate job did not complete';
  end if;

  if exists (
    select 1
    from pg_temp.strict_story_igdb_protected_before as before
    left join public.catalog_games as game
      on game.steam_appid = before.steam_appid
    where game.steam_appid is null
       or before.protected_row is distinct from pg_catalog.to_jsonb(game)
  ) then
    raise exception 'strict story IGDB reconciliation changed a protected row';
  end if;

  if exists (
    select 1
    from pg_temp.strict_story_igdb_evidence_guard as before
    cross join lateral (
      select
        count(*) as estimate_rows,
        coalesce(sum(pg_catalog.hashtextextended(
          pg_catalog.to_jsonb(estimate)::text, 0
        )::numeric), 0::numeric) as evidence_fingerprint
      from public.game_duration_estimates as estimate
    ) as after
    where row(before.estimate_rows, before.evidence_fingerprint)
      is distinct from row(after.estimate_rows, after.evidence_fingerprint)
  ) then
    raise exception 'strict story IGDB reconciliation changed raw evidence';
  end if;

  if exists (
    select 1
    from pg_temp.strict_story_igdb_quarantine_guard as before
    cross join lateral (
      select
        count(*) as quarantine_rows,
        coalesce(sum(pg_catalog.hashtextextended(
          pg_catalog.to_jsonb(quarantine)::text, 0
        )::numeric), 0::numeric) as quarantine_fingerprint
      from public.catalog_game_quarantine as quarantine
    ) as after
    where row(before.quarantine_rows, before.quarantine_fingerprint)
      is distinct from row(after.quarantine_rows, after.quarantine_fingerprint)
  ) then
    raise exception 'strict story IGDB reconciliation changed quarantine state';
  end if;
end;
$$;

commit;

