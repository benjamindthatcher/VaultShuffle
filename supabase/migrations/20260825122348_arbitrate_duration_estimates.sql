alter table public.catalog_games
  add column if not exists duration_manual_override boolean not null default false;

-- These five catalogue decisions were explicitly adjudicated by the owner.
update public.catalog_games
set duration_manual_override = true,
    duration_source = 'manual-classification'
where steam_appid in (223750, 250820, 412220, 573090, 2349820);

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
  existing_game public.catalog_games%rowtype;
  best_match public.game_duration_estimates%rowtype;
  review_match public.game_duration_estimates%rowtype;
  latest_evidence public.game_duration_estimates%rowtype;
begin
  select *
  into existing_game
  from public.catalog_games
  where steam_appid = p_steam_app_id
  for update;

  if not found or existing_game.duration_manual_override then
    return;
  end if;

  -- Only medium/high provider rows with internally coherent values can become ready.
  select estimate.*
  into best_match
  from public.game_duration_estimates as estimate
  where estimate.steam_app_id = p_steam_app_id
    and estimate.provider in ('hltb', 'igdb', 'igdb-parent', 'igdb-title')
    and estimate.match_status = 'matched'
    and estimate.match_confidence in ('medium', 'high')
    and (
      estimate.main_story_minutes > 0
      or estimate.main_extra_minutes > 0
      or estimate.completionist_minutes > 0
    )
    and (estimate.main_story_minutes is null or estimate.main_story_minutes between 1 and 120000)
    and (estimate.main_extra_minutes is null or estimate.main_extra_minutes between 1 and 120000)
    and (estimate.completionist_minutes is null or estimate.completionist_minutes between 1 and 120000)
    and (
      estimate.main_story_minutes is null
      or estimate.main_extra_minutes is null
      or estimate.main_extra_minutes >= estimate.main_story_minutes
    )
    and (
      estimate.completionist_minutes is null
      or coalesce(estimate.main_extra_minutes, estimate.main_story_minutes) is null
      or estimate.completionist_minutes >= coalesce(estimate.main_extra_minutes, estimate.main_story_minutes)
    )
    and (
      estimate.main_story_minutes is null
      or estimate.completionist_minutes is null
      or estimate.completionist_minutes::bigint < estimate.main_story_minutes::bigint * 12
    )
  order by
    case estimate.match_confidence when 'high' then 2 else 1 end desc,
    case estimate.provider
      when 'hltb' then 4
      when 'igdb' then 3
      when 'igdb-parent' then 2
      when 'igdb-title' then 1
    end desc,
    (
      (estimate.main_story_minutes is not null)::int
      + (estimate.main_extra_minutes is not null)::int
      + (estimate.completionist_minutes is not null)::int
    ) desc,
    coalesce(estimate.submission_count, 0) desc,
    estimate.checked_at desc nulls last,
    estimate.provider_game_id asc nulls last
  limit 1;

  if found then
    update public.catalog_games
    set main_story_minutes = best_match.main_story_minutes,
        main_extras_minutes = best_match.main_extra_minutes,
        completionist_minutes = best_match.completionist_minutes,
        duration_source = best_match.provider,
        duration_source_game_id = best_match.provider_game_id::text,
        duration_source_updated_at = coalesce(best_match.provider_updated_at, best_match.checked_at),
        duration_confidence = best_match.match_confidence,
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
        best_match.main_story_minutes,
        best_match.main_extra_minutes,
        best_match.completionist_minutes,
        best_match.provider,
        best_match.provider_game_id::text,
        coalesce(best_match.provider_updated_at, best_match.checked_at),
        best_match.match_confidence,
        'ready'::text,
        'finite'::text
      );
    return;
  end if;

  -- Low-confidence or malformed matches remain stored, but require review.
  select estimate.*
  into review_match
  from public.game_duration_estimates as estimate
  where estimate.steam_app_id = p_steam_app_id
    and estimate.match_status = 'matched'
  order by
    case estimate.match_confidence
      when 'high' then 3
      when 'medium' then 2
      when 'low' then 1
      else 0
    end desc,
    case estimate.provider
      when 'hltb' then 4
      when 'igdb' then 3
      when 'igdb-parent' then 2
      when 'igdb-title' then 1
      else 0
    end desc,
    estimate.checked_at desc nulls last,
    estimate.provider_game_id asc nulls last
  limit 1;

  if found then
    update public.catalog_games
    set main_story_minutes = null,
        main_extras_minutes = null,
        completionist_minutes = null,
        duration_source = review_match.provider,
        duration_source_game_id = review_match.provider_game_id::text,
        duration_source_updated_at = coalesce(review_match.provider_updated_at, review_match.checked_at),
        duration_confidence = case
          when review_match.match_confidence in ('low', 'medium', 'high')
            then review_match.match_confidence
          else null
        end,
        duration_status = 'review_required',
        duration_kind = 'unknown',
        updated_at = now()
    where steam_appid = p_steam_app_id
      and row(
        main_story_minutes,
        main_extras_minutes,
        completionist_minutes,
        duration_source,
        duration_source_game_id,
        duration_confidence,
        duration_status,
        duration_kind
      ) is distinct from row(
        null::integer,
        null::integer,
        null::integer,
        review_match.provider,
        review_match.provider_game_id::text,
        case
          when review_match.match_confidence in ('low', 'medium', 'high')
            then review_match.match_confidence
          else null
        end,
        'review_required'::text,
        'unknown'::text
      );
    return;
  end if;

  select estimate.*
  into latest_evidence
  from public.game_duration_estimates as estimate
  where estimate.steam_app_id = p_steam_app_id
    and estimate.match_status in ('no_duration', 'ambiguous', 'needs_review', 'not_found')
  order by
    case estimate.match_status
      when 'no_duration' then 4
      when 'ambiguous' then 3
      when 'needs_review' then 2
      when 'not_found' then 1
    end desc,
    estimate.checked_at desc nulls last,
    estimate.provider asc
  limit 1;

  if found then
    update public.catalog_games
    set main_story_minutes = null,
        main_extras_minutes = null,
        completionist_minutes = null,
        duration_source = case
          when existing_game.duration_kind in ('endless', 'not-applicable')
            then existing_game.duration_source
          else latest_evidence.provider
        end,
        duration_source_game_id = case
          when existing_game.duration_kind in ('endless', 'not-applicable')
            then existing_game.duration_source_game_id
          else latest_evidence.provider_game_id::text
        end,
        duration_source_updated_at = case
          when existing_game.duration_kind in ('endless', 'not-applicable')
            then existing_game.duration_source_updated_at
          else coalesce(latest_evidence.provider_updated_at, latest_evidence.checked_at)
        end,
        duration_confidence = case
          when existing_game.duration_kind in ('endless', 'not-applicable')
            then existing_game.duration_confidence
          when latest_evidence.match_confidence in ('low', 'medium', 'high')
            then latest_evidence.match_confidence
          else null
        end,
        duration_status = case
          when existing_game.duration_kind in ('endless', 'not-applicable') then 'ready'
          else 'review_required'
        end,
        duration_kind = case
          when existing_game.duration_kind in ('endless', 'not-applicable')
            then existing_game.duration_kind
          else 'unknown'
        end,
        updated_at = now()
    where steam_appid = p_steam_app_id;
    return;
  end if;

  if existing_game.duration_kind in ('endless', 'not-applicable') then
    return;
  end if;

  if p_estimate_removed then
    update public.catalog_games
    set main_story_minutes = null,
        main_extras_minutes = null,
        completionist_minutes = null,
        duration_source = null,
        duration_source_game_id = null,
        duration_source_updated_at = null,
        duration_confidence = null,
        duration_status = 'review_required',
        duration_kind = 'unknown',
        updated_at = now()
    where steam_appid = p_steam_app_id;
  end if;
end;
$$;

create or replace function public.sync_duration_estimate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.reconcile_catalogue_duration(old.steam_app_id, true);
    return old;
  end if;

  if tg_op = 'UPDATE' and old.steam_app_id is distinct from new.steam_app_id then
    if old.steam_app_id < new.steam_app_id then
      perform public.reconcile_catalogue_duration(old.steam_app_id, true);
      perform public.reconcile_catalogue_duration(new.steam_app_id, false);
    else
      perform public.reconcile_catalogue_duration(new.steam_app_id, false);
      perform public.reconcile_catalogue_duration(old.steam_app_id, true);
    end if;
    return new;
  end if;

  perform public.reconcile_catalogue_duration(new.steam_app_id, false);
  return new;
end;
$$;

drop trigger if exists sync_duration_estimate_trigger on public.game_duration_estimates;

create trigger sync_duration_estimate_trigger
after insert or update or delete on public.game_duration_estimates
for each row execute function public.sync_duration_estimate();

revoke all on function public.reconcile_catalogue_duration(bigint, boolean)
  from public, anon, authenticated;
revoke all on function public.sync_duration_estimate()
  from public, anon, authenticated;

comment on function public.reconcile_catalogue_duration(bigint, boolean) is
  'Applies manual override > validated medium/high match > review evidence > unknown precedence to one catalogue game.';

comment on column public.catalog_games.duration_manual_override is
  'True only after a human duration classification; automatic provider and tag rules must not replace it.';
