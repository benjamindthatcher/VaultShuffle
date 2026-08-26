-- Refresh classifications after catalogue metadata enrichment. The targets are
-- the exact rows produced by the corrected read-only classifier preview:
-- community "Team-Based" alone is no longer a competitive/endless signal.
-- Provider evidence and quarantine are immutable throughout this migration.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '10min';

lock table public.game_duration_estimates in share mode;
lock table public.catalog_game_quarantine in share mode;
lock table public.catalog_games in share row exclusive mode;
lock table public.game_duration_jobs in row exclusive mode;

create temporary table pg_temp.refresh_classification_plan (
  steam_appid bigint primary key,
  action text not null check (action in ('promote_endless', 'demote_review'))
) on commit drop;

insert into pg_temp.refresh_classification_plan (steam_appid, action)
values
  (381210, 'promote_endless'),
  (945360, 'promote_endless'),
  (2767030, 'promote_endless'),
  (581320, 'promote_endless'),
  (674940, 'promote_endless'),
  (386360, 'promote_endless'),
  (4704690, 'promote_endless'),
  (1568590, 'promote_endless'),
  (2429640, 'promote_endless'),
  (3932890, 'promote_endless'),
  (505460, 'promote_endless'),
  (1997040, 'promote_endless'),
  (555570, 'promote_endless'),
  (335240, 'promote_endless'),
  (300, 'promote_endless'),
  (307950, 'promote_endless'),
  (559650, 'promote_endless'),
  (224540, 'promote_endless'),
  (209080, 'promote_endless'),
  (4920, 'promote_endless'),
  (2072560, 'promote_endless'),
  (1957780, 'promote_endless'),
  (2948190, 'promote_endless'),
  (562010, 'promote_endless'),
  (1206610, 'promote_endless'),
  (1276760, 'promote_endless'),
  (2951690, 'promote_endless'),
  (788260, 'promote_endless'),
  (610180, 'promote_endless'),
  (2920270, 'promote_endless'),
  (1375740, 'promote_endless'),
  (801550, 'promote_endless'),
  (2695490, 'promote_endless'),
  (3659280, 'promote_endless'),
  (2827230, 'promote_endless'),
  (2981220, 'promote_endless'),
  (4172530, 'promote_endless'),
  (4551040, 'promote_endless'),
  (1243960, 'promote_endless'),
  (2234150, 'promote_endless'),
  (2467300, 'promote_endless'),
  (2265920, 'promote_endless'),
  (2355860, 'promote_endless'),
  (784050, 'promote_endless'),
  (3075800, 'demote_review'),
  (3104020, 'demote_review'),
  (1948490, 'demote_review'),
  (3241520, 'demote_review'),
  (1806420, 'demote_review'),
  (675270, 'demote_review'),
  (1677400, 'demote_review'),
  (2467840, 'demote_review'),
  (3279150, 'demote_review');

create temporary table pg_temp.refresh_classification_protected_before
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

create temporary table pg_temp.refresh_classification_evidence_guard
on commit drop
as
select
  count(*) as estimate_rows,
  coalesce(sum(pg_catalog.hashtextextended(
    pg_catalog.to_jsonb(estimate)::text, 0
  )::numeric), 0::numeric) as evidence_fingerprint
from public.game_duration_estimates as estimate;

create temporary table pg_temp.refresh_classification_quarantine_guard
on commit drop
as
select
  count(*) as quarantine_rows,
  coalesce(sum(pg_catalog.hashtextextended(
    pg_catalog.to_jsonb(quarantine)::text, 0
  )::numeric), 0::numeric) as quarantine_fingerprint
from public.catalog_game_quarantine as quarantine;

do $$
declare
  planned_count bigint;
  promotion_count bigint;
  demotion_count bigint;
begin
  select
    count(*),
    count(*) filter (where action = 'promote_endless'),
    count(*) filter (where action = 'demote_review')
  into planned_count, promotion_count, demotion_count
  from pg_temp.refresh_classification_plan;

  if row(planned_count, promotion_count, demotion_count)
    is distinct from row(53::bigint, 44::bigint, 9::bigint)
  then
    raise exception
      'classification refresh plan changed: total %, promote %, demote %',
      planned_count, promotion_count, demotion_count;
  end if;

  if exists (
    select 1
    from pg_temp.refresh_classification_plan as plan
    left join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    where game.steam_appid is null
       or game.duration_manual_override
       or exists (
         select 1
         from public.catalog_game_quarantine as quarantine
         where quarantine.steam_appid = plan.steam_appid
           and quarantine.review_status = 'excluded'
       )
  ) then
    raise exception 'classification refresh plan contains a missing or protected row';
  end if;

  if exists (
    select 1
    from pg_temp.refresh_classification_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    where (
      plan.action = 'promote_endless'
      and (
        game.duration_kind <> 'unknown'
        or game.duration_status <> 'review_required'
        or lower(btrim(coalesce(game.steam_type, ''))) <> 'game'
      )
    ) or (
      plan.action = 'demote_review'
      and (
        game.duration_kind <> 'endless'
        or game.duration_status <> 'ready'
        or game.duration_source <> 'classification'
      )
    )
  ) then
    raise exception 'classification refresh live state differs from preview';
  end if;
end;
$$;

update public.catalog_games as game
set main_story_minutes = null,
    main_extras_minutes = null,
    completionist_minutes = null,
    duration_source = 'classification',
    duration_source_game_id = null,
    duration_source_updated_at = now(),
    duration_confidence = 'medium',
    duration_status = 'ready',
    duration_kind = 'endless',
    updated_at = now()
from pg_temp.refresh_classification_plan as plan
where plan.steam_appid = game.steam_appid
  and plan.action = 'promote_endless';

update public.catalog_games as game
set main_story_minutes = null,
    main_extras_minutes = null,
    completionist_minutes = null,
    duration_confidence = null,
    duration_status = 'review_required',
    duration_kind = 'unknown',
    updated_at = now()
from pg_temp.refresh_classification_plan as plan
where plan.steam_appid = game.steam_appid
  and plan.action = 'demote_review';

do $$
declare
  affected record;
begin
  for affected in
    select steam_appid
    from pg_temp.refresh_classification_plan
    where action = 'demote_review'
    order by steam_appid
  loop
    perform public.reconcile_catalogue_duration(affected.steam_appid, false);
  end loop;
end;
$$;

with desired as (
  select
    plan.steam_appid,
    case
      when game.duration_status = 'ready'
        and game.duration_kind in ('finite', 'endless', 'not-applicable')
      then 'completed'
      else 'needs_review'
    end as status
  from pg_temp.refresh_classification_plan as plan
  join public.catalog_games as game
    on game.steam_appid = plan.steam_appid
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
where desired.steam_appid = job.steam_app_id
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
    from pg_temp.refresh_classification_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    where plan.action = 'promote_endless'
      and (
        game.duration_kind <> 'endless'
        or game.duration_status <> 'ready'
        or game.duration_source <> 'classification'
        or game.duration_source_game_id is not null
        or game.main_story_minutes is not null
        or game.main_extras_minutes is not null
        or game.completionist_minutes is not null
      )
  ) then
    raise exception 'a promoted endless classification failed its postcondition';
  end if;

  if exists (
    select 1
    from pg_temp.refresh_classification_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    where plan.action = 'demote_review'
      and game.duration_kind in ('endless', 'not-applicable')
  ) then
    raise exception 'an unsupported automatic classification remained nonfinite';
  end if;

  if exists (
    select 1
    from pg_temp.refresh_classification_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    join public.game_duration_jobs as job
      on job.steam_app_id = plan.steam_appid
    where job.status is distinct from case
      when game.duration_status = 'ready'
        and game.duration_kind in ('finite', 'endless', 'not-applicable')
      then 'completed'
      else 'needs_review'
    end
  ) then
    raise exception 'classification refresh left a job-state mismatch';
  end if;

  if exists (
    select 1
    from pg_temp.refresh_classification_protected_before as before
    left join public.catalog_games as game
      on game.steam_appid = before.steam_appid
    where game.steam_appid is null
       or before.protected_row is distinct from pg_catalog.to_jsonb(game)
  ) then
    raise exception 'classification refresh changed a protected catalogue row';
  end if;

  if exists (
    select 1
    from pg_temp.refresh_classification_evidence_guard as before
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
    raise exception 'classification refresh changed raw duration evidence';
  end if;

  if exists (
    select 1
    from pg_temp.refresh_classification_quarantine_guard as before
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
    raise exception 'classification refresh changed quarantine state';
  end if;
end;
$$;

commit;
