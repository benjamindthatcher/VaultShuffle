-- Preserve unresolved provider results as explicit review work instead of
-- reporting a terminal "no match" or re-queueing the same title on every load.

alter table public.catalog_games
  drop constraint if exists catalog_games_duration_status_check;
alter table public.catalog_games
  add constraint catalog_games_duration_status_check
  check (duration_status in ('pending', 'processing', 'ready', 'failed', 'no_match', 'review_required'));

create or replace function public.queue_missing_game_durations(p_limit integer default 250)
returns integer
language plpgsql
security definer
set search_path = 'public'
as $$
declare queued_count integer;
begin
  with candidates as (
    select c.steam_appid
    from public.catalog_games c
    where c.steam_type = 'game'
      and c.duration_kind = 'unknown'
      and c.duration_status <> 'review_required'
      and not exists (
        select 1
        from public.game_duration_estimates e
        where e.steam_app_id = c.steam_appid
          and (
            e.match_status = 'matched'
            or (e.next_refresh_at is not null and e.next_refresh_at > now())
          )
      )
    order by c.users_that_imported desc, c.import_sighting_count desc, c.created_at
    limit greatest(1, least(coalesce(p_limit, 250), 1000))
  ), inserted as (
    insert into public.game_duration_jobs (steam_app_id, status, priority, next_attempt_at)
    select steam_appid, 'pending', 60, now()
    from candidates
    on conflict (steam_app_id) do update
      set status = case
            when public.game_duration_jobs.status in ('failed', 'needs_review', 'completed')
              then 'retry'
            else public.game_duration_jobs.status
          end,
          next_attempt_at = case
            when public.game_duration_jobs.status in ('failed', 'needs_review', 'completed')
              then now()
            else public.game_duration_jobs.next_attempt_at
          end,
          updated_at = now()
    returning 1
  )
  select count(*) into queued_count from inserted;
  return queued_count;
end;
$$;

revoke all on function public.queue_missing_game_durations(integer) from public, anon, authenticated;
grant execute on function public.queue_missing_game_durations(integer) to service_role;

create or replace function public.sync_duration_estimate()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  update public.catalog_games
  set main_story_minutes = case when new.match_status = 'matched' then new.main_story_minutes else main_story_minutes end,
      main_extras_minutes = case when new.match_status = 'matched' then new.main_extra_minutes else main_extras_minutes end,
      completionist_minutes = case when new.match_status = 'matched' then new.completionist_minutes else completionist_minutes end,
      duration_source = new.provider,
      duration_source_game_id = new.provider_game_id::text,
      duration_source_updated_at = coalesce(new.provider_updated_at, new.checked_at),
      duration_confidence = case when new.match_confidence in ('low','medium','high') then new.match_confidence else null end,
      duration_status = case
        when new.match_status = 'matched' then 'ready'
        when new.match_status in ('no_duration', 'not_found') then
          case when duration_kind in ('endless', 'not-applicable') then 'ready' else 'review_required' end
        else 'failed'
      end,
      duration_kind = case
        when new.match_status = 'matched'
          and duration_kind not in ('endless', 'not-applicable') then 'finite'
        else duration_kind
      end,
      updated_at = now()
  where steam_appid = new.steam_app_id;

  if new.match_status = 'matched'
    and exists (
      select 1
      from public.catalog_games c
      where c.steam_appid = new.steam_app_id
        and c.duration_kind = 'finite'
    ) then
    update public.games
    set main_story_minutes = new.main_story_minutes,
        main_extras_minutes = new.main_extra_minutes,
        completionist_minutes = new.completionist_minutes,
        duration_source = new.provider,
        duration_source_updated_at = coalesce(new.provider_updated_at, new.checked_at),
        duration_confidence = case when new.match_confidence in ('low','medium','high') then new.match_confidence else null end,
        updated_at = now()
    where steam_appid is not null
      and steam_appid ~ '^[0-9]+$'
      and steam_appid::bigint = new.steam_app_id;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_duration_estimate() from public, anon, authenticated;
grant execute on function public.sync_duration_estimate() to service_role;

update public.catalog_games c
set duration_status = 'review_required',
    updated_at = now()
where c.duration_kind = 'unknown'
  and c.duration_status = 'no_match'
  and not exists (
    select 1
    from public.game_duration_estimates e
    where e.steam_app_id = c.steam_appid
      and e.match_status = 'matched'
  );

update public.game_duration_jobs j
set status = 'needs_review',
    locked_at = null,
    locked_by = null,
    updated_at = now()
from public.catalog_games c
where c.steam_appid = j.steam_app_id
  and c.duration_status = 'review_required'
  and c.duration_kind = 'unknown';
-- Version aligned with the production Supabase migration history.
