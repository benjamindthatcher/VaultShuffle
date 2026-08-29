-- Move shared product ownership from the verified identity table to the neutral
-- account table. Add every replacement first so this transaction holds the
-- child-table locks before it removes any app_users reference. That lock order
-- prevents a normal child insert (child table, then app_users) from deadlocking
-- with this migration while keeping every table protected throughout.
do $migration$
declare
  relation record;
  relation_plan jsonb := '[
    {"table_name":"app_settings","old_constraint":"app_settings_user_id_fkey","new_constraint":"app_settings_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"catalog_user_imports","old_constraint":"catalog_user_imports_user_id_fkey","new_constraint":"catalog_user_imports_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"collections","old_constraint":"collections_user_id_fkey","new_constraint":"collections_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"completion_events","old_constraint":"completion_events_user_id_fkey","new_constraint":"completion_events_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"contact_messages","old_constraint":"contact_messages_user_id_fkey","new_constraint":"contact_messages_user_id_account_fkey","delete_rule":"SET NULL"},
    {"table_name":"feedback_submissions","old_constraint":"feedback_submissions_user_id_fkey","new_constraint":"feedback_submissions_user_id_account_fkey","delete_rule":"SET NULL"},
    {"table_name":"purge_reviews","old_constraint":"purge_reviews_user_id_fkey","new_constraint":"purge_reviews_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"steam_import_jobs","old_constraint":"steam_import_jobs_user_id_fkey","new_constraint":"steam_import_jobs_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"user_game_pins","old_constraint":"user_game_pins_user_id_fkey","new_constraint":"user_game_pins_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"user_game_snoozes","old_constraint":"user_game_snoozes_user_id_fkey","new_constraint":"user_game_snoozes_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"user_games","old_constraint":"user_games_user_id_fkey","new_constraint":"user_games_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"user_genre_preferences","old_constraint":"user_genre_preferences_user_id_fkey","new_constraint":"user_genre_preferences_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"user_playtime_snapshots","old_constraint":"user_playtime_snapshots_user_id_fkey","new_constraint":"user_playtime_snapshots_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"user_vault_state","old_constraint":"user_vault_state_user_id_fkey","new_constraint":"user_vault_state_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"vault_draw_events","old_constraint":"vault_draw_events_user_id_fkey","new_constraint":"vault_draw_events_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"vault_draws","old_constraint":"vault_draws_user_id_fkey","new_constraint":"vault_draws_user_id_account_fkey","delete_rule":"CASCADE"},
    {"table_name":"vault_events","old_constraint":"vault_events_user_id_fkey","new_constraint":"vault_events_user_id_account_fkey","delete_rule":"CASCADE"}
  ]'::jsonb;
begin
  for relation in
    select *
    from jsonb_to_recordset(relation_plan) as relations(
      table_name text,
      old_constraint text,
      new_constraint text,
      delete_rule text
    )
    order by table_name
  loop
    execute format(
      'alter table public.%I add constraint %I foreign key (user_id) references public.app_accounts(id) on delete %s not valid',
      relation.table_name,
      relation.new_constraint,
      relation.delete_rule
    );
  end loop;

  for relation in
    select *
    from jsonb_to_recordset(relation_plan) as relations(
      table_name text,
      old_constraint text,
      new_constraint text,
      delete_rule text
    )
    order by table_name
  loop
    execute format(
      'alter table public.%I validate constraint %I',
      relation.table_name,
      relation.new_constraint
    );
  end loop;

  for relation in
    select *
    from jsonb_to_recordset(relation_plan) as relations(
      table_name text,
      old_constraint text,
      new_constraint text,
      delete_rule text
    )
    order by table_name
  loop
    execute format(
      'alter table public.%I drop constraint %I',
      relation.table_name,
      relation.old_constraint
    );
    execute format(
      'alter table public.%I rename constraint %I to %I',
      relation.table_name,
      relation.new_constraint,
      relation.old_constraint
    );
  end loop;
end;
$migration$;

-- Both import RPCs previously rejected any UUID not present in app_users.
-- Their behaviour is otherwise unchanged; only the neutral account validation
-- allows a manual profile to use the same bounded import machinery.
create or replace function public.register_catalog_imports(
  p_user_id uuid,
  p_appids bigint[],
  p_priority smallint default 80
)
returns integer
language plpgsql
set search_path to ''
as $function$
declare
  queued_count integer;
begin
  if p_user_id is null or not exists (
    select 1 from public.app_accounts where id = p_user_id
  ) then
    raise exception 'A valid catalogue import account is required';
  end if;

  if p_priority not between 0 and 100 then
    raise exception 'Catalogue queue priority must be between 0 and 100';
  end if;

  with requested as (
    select distinct appid
    from unnest(coalesce(p_appids, '{}'::bigint[])) as appid
    where appid > 0
  )
  insert into public.catalog_user_imports (user_id, steam_appid)
  select p_user_id, appid from requested
  on conflict (user_id, steam_appid) do update set
    last_imported_at = now(),
    import_sync_count = public.catalog_user_imports.import_sync_count + 1;

  with requested as (
    select distinct appid
    from unnest(coalesce(p_appids, '{}'::bigint[])) as appid
    where appid > 0
  ), importer_counts as (
    select
      imports.steam_appid,
      count(*)::integer as users_that_imported,
      min(imports.first_imported_at) as first_seen_at,
      max(imports.last_imported_at) as last_seen_at
    from public.catalog_user_imports as imports
    join requested on requested.appid = imports.steam_appid
    group by imports.steam_appid
  )
  insert into public.catalog_game_sightings (
    steam_appid,
    import_count,
    first_seen_at,
    last_seen_at
  )
  select steam_appid, users_that_imported, first_seen_at, last_seen_at
  from importer_counts
  on conflict (steam_appid) do update set
    import_count = excluded.import_count,
    first_seen_at = least(public.catalog_game_sightings.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(public.catalog_game_sightings.last_seen_at, excluded.last_seen_at);

  with requested as (
    select distinct appid
    from unnest(coalesce(p_appids, '{}'::bigint[])) as appid
    where appid > 0
  ), queued as (
    insert into public.catalog_ingest_queue (steam_appid, reason, priority)
    select requested.appid, 'user_import', p_priority
    from requested
    left join public.catalog_games on catalog_games.steam_appid = requested.appid
    where catalog_games.steam_appid is null
    on conflict (steam_appid) do update set
      requested_count = public.catalog_ingest_queue.requested_count + 1,
      last_requested_at = now(),
      priority = greatest(public.catalog_ingest_queue.priority, excluded.priority),
      status = case
        when public.catalog_ingest_queue.status = 'failed'
          and coalesce(public.catalog_ingest_queue.next_attempt_at, now()) <= now()
          then 'pending'
        else public.catalog_ingest_queue.status
      end,
      updated_at = now()
    returning steam_appid
  )
  select count(*) into queued_count from queued;

  update public.catalog_games
  set
    users_that_imported = importer_counts.users_that_imported,
    import_sighting_count = importer_counts.users_that_imported,
    last_seen_at = importer_counts.last_seen_at,
    updated_at = now()
  from (
    select
      imports.steam_appid,
      count(*)::integer as users_that_imported,
      max(imports.last_imported_at) as last_seen_at
    from public.catalog_user_imports as imports
    where imports.steam_appid = any(coalesce(p_appids, '{}'::bigint[]))
    group by imports.steam_appid
  ) as importer_counts
  where catalog_games.steam_appid = importer_counts.steam_appid;

  return queued_count;
end;
$function$;

create or replace function public.upsert_user_steam_games(
  p_user_id uuid,
  p_games jsonb,
  p_ownership text
)
returns setof public.user_games
language plpgsql
set search_path to ''
as $function$
begin
  if p_user_id is null or not exists (
    select 1 from public.app_accounts where id = p_user_id
  ) then
    raise exception 'INVALID_IMPORT_USER';
  end if;

  if p_ownership not in ('Owned', 'Wishlist') then
    raise exception 'INVALID_IMPORT_OWNERSHIP';
  end if;

  if p_games is null or jsonb_typeof(p_games) <> 'array' then
    raise exception 'INVALID_IMPORT_PAYLOAD';
  end if;

  if jsonb_array_length(p_games) > 500 then
    raise exception 'IMPORT_BATCH_TOO_LARGE';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_games) as input(steam_appid text)
    where input.steam_appid is null
       or input.steam_appid !~ '^[1-9][0-9]*$'
  ) then
    raise exception 'INVALID_IMPORT_GAME';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_games) as input(steam_appid text)
    left join public.catalog_games catalog
      on catalog.steam_appid = input.steam_appid::bigint
    where catalog.steam_appid is null
  ) then
    raise exception 'MISSING_CATALOG_GAME';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  return query
  insert into public.user_games (
    user_id,
    catalog_steam_appid,
    ownership,
    status,
    rating,
    hours_played,
    completion_percentage,
    priority,
    date_added,
    last_played_at,
    notes,
    completed_at,
    slept_at,
    completion_suggestion_dismissed_at,
    completion_suggestion_dismissed_playtime,
    observed_playtime_minutes,
    last_observed_played_at,
    recency_source,
    recency_evidence_at
  )
  select
    p_user_id,
    catalog.steam_appid,
    p_ownership,
    coalesce(input.status, 'Not Started'),
    greatest(0, least(coalesce(input.rating, 0), 10)),
    greatest(coalesce(input.hours_played, 0), 0),
    greatest(0, least(coalesce(input.completion_percentage, 0), 100)),
    coalesce(input.priority, 'Medium'),
    input.date_added,
    input.last_played_at,
    coalesce(input.notes, ''),
    input.completed_at,
    input.slept_at,
    input.completion_suggestion_dismissed_at,
    input.completion_suggestion_dismissed_playtime,
    round(greatest(coalesce(input.hours_played, 0), 0) * 60)::integer,
    input.last_played_at,
    case when input.last_played_at is not null then 'steam_exact' end,
    case when input.last_played_at is not null then now() end
  from jsonb_to_recordset(p_games) as input(
    steam_appid text,
    status text,
    rating integer,
    hours_played numeric,
    completion_percentage integer,
    priority text,
    date_added text,
    last_played_at timestamptz,
    notes text,
    completed_at timestamptz,
    slept_at timestamptz,
    completion_suggestion_dismissed_at timestamptz,
    completion_suggestion_dismissed_playtime numeric
  )
  join public.catalog_games catalog
    on catalog.steam_appid = input.steam_appid::bigint
  on conflict (user_id, catalog_steam_appid) do update set
    ownership = case
      when public.user_games.ownership = 'Owned'
        or excluded.ownership = 'Owned' then 'Owned'
      else 'Wishlist'
    end,
    status = public.user_games.status,
    rating = public.user_games.rating,
    completion_percentage = public.user_games.completion_percentage,
    priority = public.user_games.priority,
    notes = public.user_games.notes,
    completed_at = public.user_games.completed_at,
    slept_at = public.user_games.slept_at,
    completion_suggestion_dismissed_at = public.user_games.completion_suggestion_dismissed_at,
    completion_suggestion_dismissed_playtime = public.user_games.completion_suggestion_dismissed_playtime,
    previous_active_status = public.user_games.previous_active_status,
    hours_played = case
      when excluded.ownership = 'Owned' then excluded.hours_played
      else public.user_games.hours_played
    end,
    date_added = coalesce(public.user_games.date_added, excluded.date_added),
    last_played_at = case
      when excluded.ownership = 'Owned'
        then coalesce(excluded.last_played_at, public.user_games.last_played_at)
      else public.user_games.last_played_at
    end,
    last_observed_played_at = case
      when excluded.ownership <> 'Owned' then public.user_games.last_observed_played_at
      when public.user_games.observed_playtime_minutes is not null
       and excluded.observed_playtime_minutes > public.user_games.observed_playtime_minutes
        then now()
      when excluded.last_played_at is not null
       and (
         public.user_games.last_observed_played_at is null
         or excluded.last_played_at > public.user_games.last_observed_played_at
       )
        then excluded.last_played_at
      else public.user_games.last_observed_played_at
    end,
    recency_source = case
      when excluded.ownership <> 'Owned' then public.user_games.recency_source
      when public.user_games.observed_playtime_minutes is not null
       and excluded.observed_playtime_minutes > public.user_games.observed_playtime_minutes
        then 'observed_playtime_change'
      when excluded.last_played_at is not null
       and (
         public.user_games.last_observed_played_at is null
         or excluded.last_played_at > public.user_games.last_observed_played_at
       )
        then 'steam_exact'
      else public.user_games.recency_source
    end,
    recency_evidence_at = case
      when excluded.ownership <> 'Owned' then public.user_games.recency_evidence_at
      when public.user_games.observed_playtime_minutes is not null
       and excluded.observed_playtime_minutes > public.user_games.observed_playtime_minutes
        then now()
      when excluded.last_played_at is not null
       and (
         public.user_games.last_observed_played_at is null
         or excluded.last_played_at > public.user_games.last_observed_played_at
       )
        then now()
      else public.user_games.recency_evidence_at
    end,
    observed_playtime_minutes = case
      when excluded.ownership = 'Owned' then excluded.observed_playtime_minutes
      else public.user_games.observed_playtime_minutes
    end,
    updated_at = now()
  returning public.user_games.*;
end;
$function$;
