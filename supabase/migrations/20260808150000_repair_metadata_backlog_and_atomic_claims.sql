-- Repair only the two legacy catalogue failures produced by the retired
-- Store/app-reviews response mixing bug. Other failed rows retain their
-- attempt history and backoff state for inspection.
update public.catalog_ingest_queue
set status = 'pending',
    attempts = 0,
    next_attempt_at = now(),
    processing_started_at = null,
    last_error = null,
    rejection_reason = null,
    updated_at = now()
where status in ('pending', 'failed')
  and last_error in (
    'Steam metadata did not include a title.',
    'Unknown catalogue ingestion error'
  );

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
    where (
      game.metadata_fetched_at is null
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
    )
    and not exists (
      select 1
      from public.catalog_ingest_queue exhausted
      where exhausted.steam_appid = game.steam_appid
        and exhausted.attempts >= 3
        and exhausted.last_error = format(
          'Steam Store reports AppID %s as unavailable.',
          game.steam_appid
        )
        and exhausted.updated_at > now() - interval '180 days'
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
  returning queue.steam_appid, queue.attempts;
end;
$$;

revoke all on function public.claim_catalogue_ingest_jobs(integer, bigint[]) from public;
grant execute on function public.claim_catalogue_ingest_jobs(integer, bigint[]) to service_role;

create or replace function public.claim_steam_tag_jobs(p_limit integer default 180)
returns table (
  steam_appid bigint,
  tags_failure_count integer,
  genres text[],
  categories text[],
  main_story_minutes integer,
  main_extras_minutes integer,
  completionist_minutes integer,
  duration_kind text
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.catalog_games game
  set tags_status = 'pending',
      tags_processing_started_at = null,
      tags_next_attempt_at = now(),
      tags_last_error = 'Recovered an expired Steam tag worker lease.',
      updated_at = now()
  where game.tags_status = 'processing'
    and game.tags_processing_started_at < now() - interval '15 minutes';

  return query
  with candidates as (
    select game.steam_appid
    from public.catalog_games game
    where game.tags_status = 'pending'
      and (game.tags_next_attempt_at is null or game.tags_next_attempt_at <= now())
    order by game.tags_fetched_at asc nulls first, game.steam_appid asc
    for update of game skip locked
    limit greatest(1, least(coalesce(p_limit, 180), 220))
  )
  update public.catalog_games game
  set tags_status = 'processing',
      tags_processing_started_at = now(),
      updated_at = now()
  from candidates
  where game.steam_appid = candidates.steam_appid
  returning
    game.steam_appid,
    game.tags_failure_count,
    game.genres,
    game.categories,
    game.main_story_minutes,
    game.main_extras_minutes,
    game.completionist_minutes,
    game.duration_kind;
end;
$$;

revoke all on function public.claim_steam_tag_jobs(integer) from public;
grant execute on function public.claim_steam_tag_jobs(integer) to service_role;

-- Exact-title HLTB matches from the reviewed duration queue. Ambiguous rows
-- remain untouched and visible in needs_review.
insert into public.game_duration_estimates (
  steam_app_id,
  provider,
  provider_game_id,
  main_story_minutes,
  main_extra_minutes,
  completionist_minutes,
  submission_count,
  match_status,
  match_confidence,
  checked_at,
  next_refresh_at,
  last_error_code,
  updated_at
)
values
  (47400, 'hltb', 9280, 420, null, 512, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (116100, 'hltb', 17601, 157, 275, 377, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (233250, 'hltb', 7100, 326, 1114, 2632, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (246680, 'hltb', 27619, 167, 209, 313, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (253130, 'hltb', 15865, 221, null, null, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (259280, 'hltb', 12296, 765, null, 1215, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (307090, 'hltb', 21432, 68, null, null, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (714010, 'hltb', 125667, 316, 880, 1445, null, 'matched', 'high', now(), now() + interval '365 days', null, now())
on conflict (steam_app_id, provider) do update
set provider_game_id = excluded.provider_game_id,
    main_story_minutes = excluded.main_story_minutes,
    main_extra_minutes = excluded.main_extra_minutes,
    completionist_minutes = excluded.completionist_minutes,
    submission_count = excluded.submission_count,
    match_status = excluded.match_status,
    match_confidence = excluded.match_confidence,
    checked_at = excluded.checked_at,
    next_refresh_at = excluded.next_refresh_at,
    last_error_code = excluded.last_error_code,
    updated_at = excluded.updated_at;

update public.game_duration_jobs
set status = 'completed',
    locked_at = null,
    locked_by = null,
    last_error_code = null,
    last_error_message = null,
    updated_at = now()
where steam_app_id in (47400, 116100, 233250, 246680, 253130, 259280, 307090, 714010);

comment on function public.claim_catalogue_ingest_jobs(integer, bigint[]) is
  'Atomically leases due Steam catalogue metadata jobs and recovers expired worker leases.';
comment on function public.claim_steam_tag_jobs(integer) is
  'Atomically leases due Steam community-tag jobs and recovers expired worker leases.';
