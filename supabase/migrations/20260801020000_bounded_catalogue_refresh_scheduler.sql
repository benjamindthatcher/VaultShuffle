-- Queue a bounded set of stale or incomplete shared Steam catalogue rows.
-- Keeping this selection in Postgres avoids loading the entire catalogue into a
-- serverless function and lets the worker prioritise missing artwork/metadata.

create or replace function public.queue_stale_catalogue_metadata(
  p_limit integer default 100,
  p_refresh_after interval default interval '30 days',
  p_incomplete_retry_after interval default interval '7 days'
)
returns integer
language sql
security definer
set search_path = public, pg_catalog
as $$
  with candidates as (
    select
      game.steam_appid,
      case
        when game.header_url is null or game.capsule_url is null then 100
        when coalesce(cardinality(game.genres), 0) = 0
          or coalesce(cardinality(game.categories), 0) = 0 then 90
        else 50
      end as queue_priority,
      case
        when game.header_url is null or game.capsule_url is null then 'missing_artwork'
        when coalesce(cardinality(game.genres), 0) = 0
          or coalesce(cardinality(game.categories), 0) = 0 then 'incomplete_metadata'
        else 'stale_metadata'
      end as refresh_reason
    from public.catalog_games game
    where game.metadata_fetched_at is null
       or game.metadata_fetched_at < now() - p_refresh_after
       or (
         (
           game.header_url is null
           or game.capsule_url is null
           or coalesce(cardinality(game.genres), 0) = 0
           or coalesce(cardinality(game.categories), 0) = 0
         )
         and game.metadata_fetched_at < now() - p_incomplete_retry_after
       )
    order by
      case
        when game.header_url is null or game.capsule_url is null then 0
        when coalesce(cardinality(game.genres), 0) = 0
          or coalesce(cardinality(game.categories), 0) = 0 then 1
        else 2
      end,
      game.metadata_fetched_at asc nulls first,
      game.steam_appid asc
    limit greatest(1, least(coalesce(p_limit, 100), 250))
  ), queued as (
    insert into public.catalog_ingest_queue (
      steam_appid,
      status,
      reason,
      priority,
      requested_count,
      source_payload,
      next_attempt_at,
      last_requested_at,
      updated_at
    )
    select
      candidate.steam_appid,
      'pending',
      'refresh',
      candidate.queue_priority,
      1,
      jsonb_build_object('refresh_reason', candidate.refresh_reason),
      now(),
      now(),
      now()
    from candidates candidate
    on conflict (steam_appid) do update
    set status = 'pending',
        reason = 'refresh',
        priority = greatest(public.catalog_ingest_queue.priority, excluded.priority),
        requested_count = coalesce(public.catalog_ingest_queue.requested_count, 0) + 1,
        source_payload = coalesce(public.catalog_ingest_queue.source_payload, '{}'::jsonb) || excluded.source_payload,
        next_attempt_at = now(),
        last_requested_at = now(),
        rejection_reason = null,
        last_error = null,
        updated_at = now()
    where public.catalog_ingest_queue.status <> 'processing'
    returning 1
  )
  select count(*)::integer from queued;
$$;

revoke all on function public.queue_stale_catalogue_metadata(integer, interval, interval) from public;
grant execute on function public.queue_stale_catalogue_metadata(integer, interval, interval) to service_role;

comment on function public.queue_stale_catalogue_metadata(integer, interval, interval) is
  'Queues a bounded, priority-ordered set of stale or incomplete shared Steam catalogue rows.';
