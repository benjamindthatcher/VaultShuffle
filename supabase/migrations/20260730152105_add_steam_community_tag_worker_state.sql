alter table public.catalog_games
  add column if not exists tags_source text,
  add column if not exists tags_status text not null default 'pending',
  add column if not exists tags_fetched_at timestamptz,
  add column if not exists tags_processing_started_at timestamptz,
  add column if not exists tags_next_attempt_at timestamptz,
  add column if not exists tags_failure_count integer not null default 0,
  add column if not exists tags_last_error text;

alter table public.catalog_games
  drop constraint if exists catalog_games_tags_status_check;
alter table public.catalog_games
  add constraint catalog_games_tags_status_check
  check (tags_status in ('pending', 'processing', 'ready', 'failed'));

alter table public.catalog_games
  drop constraint if exists catalog_games_tags_failure_count_check;
alter table public.catalog_games
  add constraint catalog_games_tags_failure_count_check
  check (tags_failure_count >= 0);

create index if not exists catalog_games_tag_worker_queue_idx
  on public.catalog_games (tags_status, tags_next_attempt_at, tags_fetched_at, steam_appid)
  where tags_status in ('pending', 'processing');

update public.catalog_games
set tags_status = case
      when tags <> '{}'::jsonb then 'ready'
      else 'pending'
    end,
    tags_source = case
      when tags <> '{}'::jsonb then coalesce(tags_source, 'legacy')
      else tags_source
    end,
    tags_fetched_at = case
      when tags <> '{}'::jsonb then coalesce(tags_fetched_at, metadata_fetched_at, updated_at)
      else tags_fetched_at
    end,
    tags_next_attempt_at = case
      when tags = '{}'::jsonb then coalesce(tags_next_attempt_at, now())
      else null
    end,
    tags_processing_started_at = null,
    updated_at = now();

comment on column public.catalog_games.tags is
  'Complete Steam community tag map keyed by tag name with provider vote weights. Stored before visibility filtering.';
comment on column public.catalog_games.tags_source is
  'Provider used for the complete community tag map, currently steamspy.';
comment on column public.catalog_games.tags_status is
  'Shared per-AppID tag enrichment state; never user-specific.';
