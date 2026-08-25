-- Bring every unprotected catalogue projection and duration job onto the
-- hardened arbitration policy after the validated HLTB import and automatic
-- non-finite rebuild. Raw provider rows and quarantine state are immutable.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '15min';

lock table public.game_duration_estimates in share mode;
lock table public.catalog_game_quarantine in share mode;
lock table public.catalog_games in share row exclusive mode;
lock table public.game_duration_jobs in row exclusive mode;

create temporary table pg_temp.duration_catalogue_protected_before
on commit drop
as
select
  game.steam_appid,
  pg_catalog.to_jsonb(game) as protected_row
from public.catalog_games as game
where game.duration_manual_override
   or exists (
     select 1
     from public.catalog_game_quarantine as quarantine
     where quarantine.steam_appid = game.steam_appid
       and quarantine.review_status = 'excluded'
   );

create temporary table pg_temp.duration_catalogue_evidence_guard
on commit drop
as
select
  count(*) as estimate_rows,
  coalesce(
    sum(
      pg_catalog.hashtextextended(
        pg_catalog.to_jsonb(estimate)::text,
        0
      )::numeric
    ),
    0::numeric
  ) as evidence_fingerprint
from public.game_duration_estimates as estimate;

create temporary table pg_temp.duration_catalogue_quarantine_guard
on commit drop
as
select
  count(*) as quarantine_rows,
  coalesce(
    sum(
      pg_catalog.hashtextextended(
        pg_catalog.to_jsonb(quarantine)::text,
        0
      )::numeric
    ),
    0::numeric
  ) as quarantine_fingerprint
from public.catalog_game_quarantine as quarantine;

create temporary table pg_temp.duration_catalogue_reconcile_plan
on commit drop
as
with expected as (
  select
    game.steam_appid,
    case when winner.provider is not null then winner.main_story_minutes end
      as expected_main_story_minutes,
    case when winner.provider is not null then winner.main_extra_minutes end
      as expected_main_extras_minutes,
    case when winner.provider is not null then winner.completionist_minutes end
      as expected_completionist_minutes,
    coalesce(winner.provider, review_match.provider, latest.provider)
      as expected_duration_source,
    coalesce(
      winner.provider_game_id,
      review_match.provider_game_id,
      latest.provider_game_id
    )::text as expected_duration_source_game_id,
    case
      when winner.provider is not null
        then coalesce(winner.provider_updated_at, winner.checked_at)
      when review_match.provider is not null
        then coalesce(review_match.provider_updated_at, review_match.checked_at)
      else coalesce(latest.provider_updated_at, latest.checked_at)
    end as expected_duration_source_updated_at,
    case
      when winner.provider is not null then winner.match_confidence
      when review_match.match_confidence in ('low', 'medium', 'high')
        then review_match.match_confidence
      when latest.match_confidence in ('low', 'medium', 'high')
        then latest.match_confidence
    end as expected_duration_confidence,
    case when winner.provider is not null then 'ready' else 'review_required' end
      as expected_duration_status,
    case when winner.provider is not null then 'finite' else 'unknown' end
      as expected_duration_kind,
    case
      when winner.provider is not null then 'accepted_finite'
      when review_match.provider is not null then 'matched_review'
      else 'nonmatched_review'
    end as expected_projection,
    game.main_story_minutes,
    game.main_extras_minutes,
    game.completionist_minutes,
    game.duration_source,
    game.duration_source_game_id,
    game.duration_source_updated_at,
    game.duration_confidence,
    game.duration_status,
    game.duration_kind
  from public.catalog_games as game
  left join lateral (
    select estimate.*
    from public.game_duration_estimates as estimate
    where estimate.steam_app_id = game.steam_appid
      and estimate.match_status = 'matched'
      and estimate.match_confidence in ('medium', 'high')
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
          and (
            (
              estimate.evidence ->> 'verification_method' = 'profile_steam_exact'
              and estimate.evidence ->> 'verification_tier' = 'steam_appid'
            )
            or (
              estimate.evidence ->> 'verification_method' in (
                'safe_exact_title', 'safe_exact_alias'
              )
              and estimate.evidence ->> 'verification_tier' in (
                'exact_title', 'mixed_script_title'
              )
            )
          )
        )
        or (
          estimate.provider = 'igdb'
          and coalesce(estimate.submission_count, 0) >= 5
          and (
            (estimate.main_story_minutes is not null)::int
            + (estimate.main_extra_minutes is not null)::int
            + (estimate.completionist_minutes is not null)::int
          ) >= 2
          and lower(game.name) !~
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
      case estimate.match_confidence when 'high' then 2 else 1 end desc,
      case estimate.provider when 'hltb' then 2 when 'igdb' then 1 end desc,
      (
        (estimate.main_story_minutes is not null)::int
        + (estimate.main_extra_minutes is not null)::int
        + (estimate.completionist_minutes is not null)::int
      ) desc,
      coalesce(estimate.submission_count, 0) desc,
      estimate.checked_at desc nulls last,
      estimate.provider_game_id asc nulls last
    limit 1
  ) as winner on true
  left join lateral (
    select estimate.*
    from public.game_duration_estimates as estimate
    where winner.provider is null
      and estimate.steam_app_id = game.steam_appid
      and estimate.match_status = 'matched'
    order by
      case estimate.match_confidence
        when 'high' then 3 when 'medium' then 2 when 'low' then 1 else 0
      end desc,
      case estimate.provider
        when 'hltb' then 4 when 'igdb' then 3 when 'igdb-parent' then 2
        when 'igdb-title' then 1 else 0
      end desc,
      estimate.checked_at desc nulls last,
      estimate.provider_game_id asc nulls last
    limit 1
  ) as review_match on true
  left join lateral (
    select estimate.*
    from public.game_duration_estimates as estimate
    where winner.provider is null
      and review_match.provider is null
      and estimate.steam_app_id = game.steam_appid
      and estimate.match_status in (
        'no_duration', 'ambiguous', 'needs_review', 'not_found'
      )
    order by
      case estimate.match_status
        when 'no_duration' then 4 when 'ambiguous' then 3
        when 'needs_review' then 2 when 'not_found' then 1
      end desc,
      estimate.checked_at desc nulls last,
      estimate.provider asc
    limit 1
  ) as latest on true
  where not game.duration_manual_override
    and game.duration_kind not in ('endless', 'not-applicable')
    and not exists (
      select 1
      from public.catalog_game_quarantine as quarantine
      where quarantine.steam_appid = game.steam_appid
        and quarantine.review_status = 'excluded'
    )
    and coalesce(winner.provider, review_match.provider, latest.provider)
      is not null
)
select
  expected.steam_appid,
  expected.expected_main_story_minutes,
  expected.expected_main_extras_minutes,
  expected.expected_completionist_minutes,
  expected.expected_duration_source,
  expected.expected_duration_source_game_id,
  expected.expected_duration_source_updated_at,
  expected.expected_duration_confidence,
  expected.expected_duration_status,
  expected.expected_duration_kind,
  expected.expected_projection
from expected
where row(
  expected.main_story_minutes,
  expected.main_extras_minutes,
  expected.completionist_minutes,
  expected.duration_source,
  expected.duration_source_game_id,
  expected.duration_source_updated_at,
  expected.duration_confidence,
  expected.duration_status,
  expected.duration_kind
) is distinct from row(
  expected.expected_main_story_minutes,
  expected.expected_main_extras_minutes,
  expected.expected_completionist_minutes,
  expected.expected_duration_source,
  expected.expected_duration_source_game_id,
  expected.expected_duration_source_updated_at,
  expected.expected_duration_confidence,
  expected.expected_duration_status,
  expected.expected_duration_kind
);

alter table pg_temp.duration_catalogue_reconcile_plan
  add primary key (steam_appid);

do $$
declare
  planned_count bigint;
begin
  select count(*) into planned_count
  from pg_temp.duration_catalogue_reconcile_plan;

  if planned_count > 10000 then
    raise exception
      'whole-catalogue duration reconciliation safety cap exceeded: % rows',
      planned_count;
  end if;

  raise notice
    'whole-catalogue duration reconciliation planned % rows',
    planned_count;
end;
$$;

do $$
declare
  affected record;
begin
  for affected in
    select plan.steam_appid
    from pg_temp.duration_catalogue_reconcile_plan as plan
    order by plan.steam_appid
  loop
    perform public.reconcile_catalogue_duration(affected.steam_appid, false);
  end loop;
end;
$$;

-- A projected endless result is a catalogue classification, not a provider
-- duration. Preserve the raw provider rows and make that distinction explicit.
update public.catalog_games as game
set duration_source = 'classification',
    duration_source_game_id = null,
    duration_source_updated_at = now(),
    duration_confidence = 'medium',
    updated_at = now()
where game.duration_kind = 'endless'
  and game.duration_status = 'ready'
  and not game.duration_manual_override
  and not exists (
    select 1
    from public.catalog_game_quarantine as quarantine
    where quarantine.steam_appid = game.steam_appid
      and quarantine.review_status = 'excluded'
  )
  and row(
    game.duration_source,
    game.duration_source_game_id,
    game.duration_confidence
  ) is distinct from row(
    'classification'::text,
    null::text,
    'medium'::text
  );

-- Jobs describe whether the public projection is settled. Do not steal active
-- worker claims, but normalize every other job against the rebuilt catalogue.
with desired as (
  select
    game.steam_appid,
    case
      when game.duration_manual_override
        or (
          game.duration_status = 'ready'
          and game.duration_kind in ('finite', 'endless', 'not-applicable')
        )
      then 'completed'
      else 'needs_review'
    end as desired_status,
    case
      when game.duration_manual_override
        or (
          game.duration_status = 'ready'
          and game.duration_kind in ('finite', 'endless', 'not-applicable')
        )
      then null
      else coalesce(hltb.last_error_code, 'duration_review_required')
    end as desired_error_code
  from public.catalog_games as game
  left join public.game_duration_estimates as hltb
    on hltb.steam_app_id = game.steam_appid
   and hltb.provider = 'hltb'
)
update public.game_duration_jobs as job
set status = desired.desired_status,
    next_attempt_at = null,
    locked_at = null,
    locked_by = null,
    last_error_code = desired.desired_error_code,
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
    desired.desired_status,
    null::timestamptz,
    null::timestamptz,
    null::text,
    desired.desired_error_code,
    null::text
  );

do $$
begin
  if exists (
    select 1
    from pg_temp.duration_catalogue_reconcile_plan as plan
    join public.catalog_games as game
      on game.steam_appid = plan.steam_appid
    where row(
      game.main_story_minutes,
      game.main_extras_minutes,
      game.completionist_minutes,
      game.duration_source,
      game.duration_source_game_id,
      game.duration_source_updated_at,
      game.duration_confidence,
      game.duration_status,
      game.duration_kind
    ) is distinct from row(
      plan.expected_main_story_minutes,
      plan.expected_main_extras_minutes,
      plan.expected_completionist_minutes,
      plan.expected_duration_source,
      plan.expected_duration_source_game_id,
      plan.expected_duration_source_updated_at,
      plan.expected_duration_confidence,
      plan.expected_duration_status,
      plan.expected_duration_kind
    )
  ) then
    raise exception 'whole-catalogue reconciliation disagrees with its plan';
  end if;

  if exists (
    select 1
    from pg_temp.duration_catalogue_protected_before as before
    left join public.catalog_games as game
      on game.steam_appid = before.steam_appid
    where game.steam_appid is null
       or before.protected_row is distinct from pg_catalog.to_jsonb(game)
  ) then
    raise exception 'whole-catalogue reconciliation changed a protected row';
  end if;

  if exists (
    select 1
    from pg_temp.duration_catalogue_evidence_guard as before
    cross join lateral (
      select
        count(*) as estimate_rows,
        coalesce(
          sum(
            pg_catalog.hashtextextended(
              pg_catalog.to_jsonb(estimate)::text,
              0
            )::numeric
          ),
          0::numeric
        ) as evidence_fingerprint
      from public.game_duration_estimates as estimate
    ) as after
    where row(before.estimate_rows, before.evidence_fingerprint)
      is distinct from row(after.estimate_rows, after.evidence_fingerprint)
  ) then
    raise exception 'whole-catalogue reconciliation changed raw evidence';
  end if;

  if exists (
    select 1
    from pg_temp.duration_catalogue_quarantine_guard as before
    cross join lateral (
      select
        count(*) as quarantine_rows,
        coalesce(
          sum(
            pg_catalog.hashtextextended(
              pg_catalog.to_jsonb(quarantine)::text,
              0
            )::numeric
          ),
          0::numeric
        ) as quarantine_fingerprint
      from public.catalog_game_quarantine as quarantine
    ) as after
    where row(before.quarantine_rows, before.quarantine_fingerprint)
      is distinct from row(after.quarantine_rows, after.quarantine_fingerprint)
  ) then
    raise exception 'whole-catalogue reconciliation changed quarantine state';
  end if;

  if exists (
    select 1
    from public.catalog_games as game
    where game.duration_kind = 'endless'
      and game.duration_status = 'ready'
      and not game.duration_manual_override
      and not exists (
        select 1
        from public.catalog_game_quarantine as quarantine
        where quarantine.steam_appid = game.steam_appid
          and quarantine.review_status = 'excluded'
      )
      and row(
        game.duration_source,
        game.duration_source_game_id,
        game.duration_confidence
      ) is distinct from row(
        'classification'::text,
        null::text,
        'medium'::text
      )
  ) then
    raise exception 'automatic endless provenance was not normalized';
  end if;

  if exists (
    select 1
    from public.game_duration_jobs as job
    join public.catalog_games as game
      on game.steam_appid = job.steam_app_id
    where job.status <> 'processing'
      and (
        (
          job.status = 'completed'
          and not (
            game.duration_manual_override
            or (
              game.duration_status = 'ready'
              and game.duration_kind in ('finite', 'endless', 'not-applicable')
            )
          )
        )
        or (
          job.status <> 'completed'
          and (
            game.duration_manual_override
            or (
              game.duration_status = 'ready'
              and game.duration_kind in ('finite', 'endless', 'not-applicable')
            )
          )
        )
        or job.locked_at is not null
        or job.locked_by is not null
      )
  ) then
    raise exception 'duration jobs disagree with rebuilt catalogue state';
  end if;
end;
$$;

commit;
