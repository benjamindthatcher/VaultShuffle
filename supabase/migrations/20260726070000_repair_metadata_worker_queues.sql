-- Recover abandoned worker leases and avoid repeatedly re-queueing duration
-- results that are still inside their provider refresh window.

grant select, insert, update, delete on public.catalog_game_quarantine to service_role;
grant select, insert, update on public.catalog_ingest_queue to service_role;
grant select, insert, update on public.steam_app_metadata to service_role;
grant select, insert, update on public.game_duration_jobs to service_role;
grant select, insert, update on public.game_duration_estimates to service_role;

update public.game_duration_jobs
set status = 'retry',
    locked_at = null,
    locked_by = null,
    next_attempt_at = now(),
    last_error_code = 'stale_worker_lease',
    last_error_message = 'Recovered an expired duration worker lease.',
    updated_at = now()
where locked_at < now() - interval '15 minutes'
  and locked_by is not null;

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
      and not exists (
        select 1
        from public.game_duration_estimates e
        where e.steam_app_id = c.steam_appid
          and e.next_refresh_at is not null
          and e.next_refresh_at > now()
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
