alter table public.steam_app_metadata
  add column if not exists next_attempt_at timestamptz,
  add column if not exists processing_started_at timestamptz;

alter table public.steam_app_metadata
  drop constraint if exists steam_app_metadata_status_check;

alter table public.steam_app_metadata
  add constraint steam_app_metadata_status_check
  check (status in ('pending', 'processing', 'ready', 'failed'));

update public.steam_app_metadata
set next_attempt_at = coalesce(next_attempt_at, now())
where status = 'pending';

update public.steam_app_metadata
set next_attempt_at = coalesce(
  next_attempt_at,
  case
    when last_error ilike '%HTTP 403%' then checked_at + interval '24 hours'
    when last_error ilike '%HTTP 429%' then checked_at + interval '12 hours'
    else checked_at + interval '6 hours'
  end,
  now()
)
where status = 'failed';

create index if not exists steam_app_metadata_due_idx
  on public.steam_app_metadata (next_attempt_at, checked_at, steam_appid)
  where status = 'pending';

create index if not exists steam_app_metadata_processing_idx
  on public.steam_app_metadata (processing_started_at, steam_appid)
  where status = 'processing';

create or replace function public.claim_steam_metadata_jobs(
  p_limit integer default 40,
  p_app_ids text[] default null
)
returns table (
  steam_appid text,
  failure_count integer,
  checked_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.steam_app_metadata
  set status = 'pending',
      processing_started_at = null,
      next_attempt_at = now(),
      last_error = coalesce(last_error, 'Recovered expired Steam metadata worker lease.'),
      updated_at = now()
  where status = 'processing'
    and processing_started_at is not null
    and processing_started_at < now() - interval '15 minutes';

  return query
  with claimable as (
    select metadata.steam_appid
    from public.steam_app_metadata metadata
    where metadata.status = 'pending'
      and (metadata.next_attempt_at is null or metadata.next_attempt_at <= now())
      and (p_app_ids is null or metadata.steam_appid = any(p_app_ids))
    order by
      metadata.next_attempt_at asc nulls first,
      metadata.checked_at asc nulls first,
      metadata.failure_count asc,
      metadata.steam_appid
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 40), 100))
  )
  update public.steam_app_metadata metadata
  set status = 'processing',
      processing_started_at = now(),
      updated_at = now()
  from claimable
  where metadata.steam_appid = claimable.steam_appid
  returning metadata.steam_appid, metadata.failure_count, metadata.checked_at;
end;
$$;

revoke all on function public.claim_steam_metadata_jobs(integer, text[]) from public;
grant execute on function public.claim_steam_metadata_jobs(integer, text[]) to service_role;

-- Keep the production-only duration claim function reproducible in source
-- control and align its upper bound with the worker's documented batch size.
create or replace function public.claim_game_duration_jobs(
  p_limit integer default 8,
  p_worker_id text default null
)
returns table (steam_app_id bigint, attempts smallint)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.game_duration_jobs
  set status = 'retry',
      locked_at = null,
      locked_by = null,
      next_attempt_at = now(),
      last_error_code = coalesce(last_error_code, 'stale_lease'),
      last_error_message = coalesce(last_error_message, 'Recovered expired duration worker lease.'),
      updated_at = now()
  where status = 'processing'
    and locked_at is not null
    and locked_at < now() - interval '15 minutes';

  return query
  with claimable as (
    select jobs.steam_app_id
    from public.game_duration_jobs jobs
    where jobs.status in ('pending', 'retry')
      and (jobs.next_attempt_at is null or jobs.next_attempt_at <= now())
    order by jobs.priority desc, jobs.created_at, jobs.steam_app_id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 8), 48))
  )
  update public.game_duration_jobs jobs
  set status = 'processing',
      locked_at = now(),
      locked_by = coalesce(nullif(p_worker_id, ''), 'worker'),
      updated_at = now()
  from claimable
  where jobs.steam_app_id = claimable.steam_app_id
  returning jobs.steam_app_id, jobs.attempts;
end;
$$;

revoke all on function public.claim_game_duration_jobs(integer, text) from public;
grant execute on function public.claim_game_duration_jobs(integer, text) to service_role;

create table if not exists public.metadata_worker_runs (
  id uuid primary key default gen_random_uuid(),
  worker_name text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  counts jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  constraint metadata_worker_runs_status_check
    check (status in ('running', 'succeeded', 'partial', 'failed')),
  constraint metadata_worker_runs_duration_check
    check (duration_ms is null or duration_ms >= 0),
  constraint metadata_worker_runs_finished_check
    check (
      (status = 'running' and finished_at is null)
      or (status <> 'running' and finished_at is not null)
    )
);

create index if not exists metadata_worker_runs_recent_idx
  on public.metadata_worker_runs (worker_name, started_at desc);

create index if not exists metadata_worker_runs_running_idx
  on public.metadata_worker_runs (started_at)
  where status = 'running';

alter table public.metadata_worker_runs enable row level security;
revoke all on table public.metadata_worker_runs from public, anon, authenticated;
grant select, insert, update on table public.metadata_worker_runs to service_role;
