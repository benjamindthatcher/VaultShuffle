-- Record recency evidence as part of the Steam import itself.
--
-- The import is the only moment that holds both the playtime we saw last time
-- and the playtime Steam is reporting now, so it is the only place that can tell
-- whether a game was played in between. Doing it here also makes it atomic: the
-- comparison and the write happen under the same advisory lock as the rest of
-- the import, so two concurrent refreshes cannot both claim the same rise.
--
-- The rule that makes this honest: a FIRST observation proves nothing. Importing
-- a library with 150 lifetime hours on a game is not evidence it was played
-- today. Only a rise above an established baseline is.
--
-- Granularity: hours_played is stored to one decimal place, so the smallest
-- detectable rise is six minutes. Sessions shorter than that may not register,
-- which is an acceptable definition of "actually played it".

create or replace function public.upsert_user_steam_games(p_user_id uuid, p_games jsonb, p_ownership text)
 returns setof public.user_games
 language plpgsql
 set search_path to ''
as $function$
begin
  if p_user_id is null or not exists (
    select 1 from public.app_users where id = p_user_id
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
    -- Baseline for next time. Deliberately paired with no recency claim.
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
    completion_suggestion_dismissed_at =
      public.user_games.completion_suggestion_dismissed_at,
    completion_suggestion_dismissed_playtime =
      public.user_games.completion_suggestion_dismissed_playtime,
    previous_active_status = public.user_games.previous_active_status,
    hours_played = case
      when excluded.ownership = 'Owned' then excluded.hours_played
      else public.user_games.hours_played
    end,
    date_added = coalesce(public.user_games.date_added, excluded.date_added),
    last_played_at = case
      when excluded.ownership = 'Owned'
        then coalesce(
          excluded.last_played_at,
          public.user_games.last_played_at
        )
      else public.user_games.last_played_at
    end,

    -- A rise above an established baseline is proof the game was played between
    -- the two observations. Falling back to the newest exact timestamp keeps
    -- Steam's own answer usable on the rare accounts that supply one. A drop
    -- (Steam correcting itself, or a shared library going away) proves nothing,
    -- and must not be read as activity.
    last_observed_played_at = case
      when excluded.ownership <> 'Owned' then public.user_games.last_observed_played_at
      when public.user_games.observed_playtime_minutes is not null
       and excluded.observed_playtime_minutes > public.user_games.observed_playtime_minutes
        then now()
      when excluded.last_played_at is not null
       and (public.user_games.last_observed_played_at is null
            or excluded.last_played_at > public.user_games.last_observed_played_at)
        then excluded.last_played_at
      else public.user_games.last_observed_played_at
    end,
    recency_source = case
      when excluded.ownership <> 'Owned' then public.user_games.recency_source
      when public.user_games.observed_playtime_minutes is not null
       and excluded.observed_playtime_minutes > public.user_games.observed_playtime_minutes
        then 'observed_playtime_change'
      when excluded.last_played_at is not null
       and (public.user_games.last_observed_played_at is null
            or excluded.last_played_at > public.user_games.last_observed_played_at)
        then 'steam_exact'
      else public.user_games.recency_source
    end,
    recency_evidence_at = case
      when excluded.ownership <> 'Owned' then public.user_games.recency_evidence_at
      when public.user_games.observed_playtime_minutes is not null
       and excluded.observed_playtime_minutes > public.user_games.observed_playtime_minutes
        then now()
      when excluded.last_played_at is not null
       and (public.user_games.last_observed_played_at is null
            or excluded.last_played_at > public.user_games.last_observed_played_at)
        then now()
      else public.user_games.recency_evidence_at
    end,
    -- Always tracks the latest reading, including downward corrections, so the
    -- next comparison is against what Steam actually says today.
    observed_playtime_minutes = case
      when excluded.ownership = 'Owned' then excluded.observed_playtime_minutes
      else public.user_games.observed_playtime_minutes
    end,
    updated_at = now()
  returning public.user_games.*;
end;
$function$;
