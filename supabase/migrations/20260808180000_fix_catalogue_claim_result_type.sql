create or replace function public.claim_catalogue_ingest_jobs(
  p_limit integer default 25,
  p_appids bigint[] default null
)
returns table (steam_appid bigint, attempts integer)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.catalog_ingest_queue queue
  set status = 'pending',
      processing_started_at = null,
      next_attempt_at = now(),
      last_error = 'Recovered an expired catalogue worker lease.',
      updated_at = now()
  where queue.status = 'processing'
    and queue.processing_started_at < now() - interval '15 minutes';

  return query
  with candidates as (
    select queue.steam_appid
    from public.catalog_ingest_queue queue
    where queue.status = 'pending'
      and (queue.next_attempt_at is null or queue.next_attempt_at <= now())
      and (p_appids is null or queue.steam_appid = any(p_appids))
    order by queue.priority desc, queue.first_requested_at asc, queue.steam_appid asc
    for update of queue skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.catalog_ingest_queue queue
  set status = 'processing',
      processing_started_at = now(),
      updated_at = now()
  from candidates
  where queue.steam_appid = candidates.steam_appid
  returning queue.steam_appid, queue.attempts::integer;
end;
$$;

revoke all on function public.claim_catalogue_ingest_jobs(integer, bigint[]) from public;
grant execute on function public.claim_catalogue_ingest_jobs(integer, bigint[]) to service_role;

comment on function public.claim_catalogue_ingest_jobs(integer, bigint[]) is
  'Atomically leases due Steam catalogue metadata jobs and recovers expired worker leases.';
