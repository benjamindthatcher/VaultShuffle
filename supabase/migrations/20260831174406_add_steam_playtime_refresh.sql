-- No new tables/queues. All helpers are service-role-only; browser clients cannot
-- choose another account. Ordinary Steam imports remain separate from pins.
create or replace function public.get_pinned_playtime_candidates(p_cursor uuid default null, p_limit integer default 150)
returns table(id uuid, steam_id text, appids text[])
language sql stable set search_path = '' as $$
  with identities as (
    select id, steam_id from public.app_users
    union all select id, steam_id from public.manual_steam_profiles
  ), candidates as (
    select a.id, a.steam_id, array_agg(distinct g.catalog_steam_appid::text) as appids
    from identities a
    join public.user_game_pins p on p.user_id = a.id
    join public.user_games g on g.id = p.game_id and g.user_id = a.id and g.ownership = 'Owned'
    where a.steam_id is not null and a.steam_id <> '' and g.catalog_steam_appid is not null
    group by a.id, a.steam_id
  )
  select * from candidates
  order by (p_cursor is null or candidates.id > p_cursor) desc, candidates.id
  limit least(greatest(coalesce(p_limit,150),1),150);
$$;

create or replace function public.capture_steam_playtime_snapshot(p_user_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from public.app_accounts where id=p_user_id) then
    raise exception 'INVALID_PLAYTIME_ACCOUNT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  insert into public.user_playtime_snapshots(user_id,captured_on,total_minutes,games_with_playtime)
  select p_user_id,(now() at time zone 'UTC')::date,
    coalesce(sum(round(hours_played*60)),0)::bigint,
    count(*) filter(where hours_played>0)::integer
  from public.user_games where user_id=p_user_id and ownership='Owned'
  on conflict(user_id,captured_on) do update set
    total_minutes=excluded.total_minutes,games_with_playtime=excluded.games_with_playtime;
end;
$$;

create or replace function public.refresh_pinned_steam_playtime(p_user_id uuid, p_games jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare changed integer; matched integer;
begin
  if not exists(select 1 from public.app_accounts where id=p_user_id) then
    raise exception 'INVALID_PLAYTIME_ACCOUNT';
  end if;
  if p_games is null or jsonb_typeof(p_games)<>'array' then
    raise exception 'INVALID_PLAYTIME_PAYLOAD';
  end if;
  if jsonb_array_length(p_games)>100 then raise exception 'PLAYTIME_BATCH_TOO_LARGE'; end if;
  if exists(select 1 from jsonb_to_recordset(p_games) as x(steam_appid text,minutes numeric)
    where steam_appid is null or steam_appid !~ '^[1-9][0-9]*$'
    or minutes is null or minutes<0 or minutes>2147483647 or minutes<>trunc(minutes)) then
    raise exception 'INVALID_PLAYTIME_GAME';
  end if;
  -- Same account lock as full imports. Never reset hours_at_pin or player edits.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  -- Pin actions delete these rows; serialize with unpins while the request saves.
  perform 1 from public.user_game_pins where user_id=p_user_id for share;
  select count(*) into matched from public.user_games g
  where g.user_id=p_user_id and g.ownership='Owned'
    and exists(select 1 from public.user_game_pins p where p.user_id=p_user_id and p.game_id=g.id)
    and exists(select 1 from jsonb_to_recordset(p_games) as x(steam_appid text)
      where x.steam_appid::bigint=g.catalog_steam_appid);

  with input as (
    select steam_appid::bigint as appid,max(minutes)::integer as minutes,max(last_played_at) as played_at
    from jsonb_to_recordset(p_games) as x(steam_appid text,minutes numeric,last_played_at timestamptz)
    group by steam_appid::bigint
  ), updated as (
    update public.user_games g set
      hours_played=greatest(g.hours_played,round(x.minutes::numeric/60,1)),
      observed_playtime_minutes=greatest(g.observed_playtime_minutes,x.minutes),
      last_played_at=greatest(g.last_played_at,x.played_at),
      last_observed_played_at=case
        when g.observed_playtime_minutes is not null and x.minutes>g.observed_playtime_minutes then now()
        when x.played_at>coalesce(g.last_observed_played_at,'-infinity'::timestamptz) then x.played_at
        else g.last_observed_played_at end,
      recency_source=case
        when g.observed_playtime_minutes is not null and x.minutes>g.observed_playtime_minutes then 'observed_playtime_change'
        when x.played_at>coalesce(g.last_observed_played_at,'-infinity'::timestamptz) then 'steam_exact'
        else g.recency_source end,
      recency_evidence_at=case
        when (g.observed_playtime_minutes is not null and x.minutes>g.observed_playtime_minutes)
          or x.played_at>coalesce(g.last_observed_played_at,'-infinity'::timestamptz) then now()
        else g.recency_evidence_at end
    from input x
    where g.user_id=p_user_id and g.ownership='Owned' and g.catalog_steam_appid=x.appid
      and exists(select 1 from public.user_game_pins p where p.user_id=p_user_id and p.game_id=g.id)
      and (round(x.minutes::numeric/60,1)>g.hours_played
        or g.observed_playtime_minutes is null or x.minutes>g.observed_playtime_minutes
        or x.played_at>coalesce(g.last_played_at,'-infinity'::timestamptz))
    returning g.id
  ) select count(*) into changed from updated;
  -- A partial pin read is NOT a fresh whole-library daily snapshot.
  return jsonb_build_object('pinned_games_updated',changed,'pinned_games_matched',matched);
end;
$$;

revoke all on function public.get_pinned_playtime_candidates(uuid,integer) from public,anon,authenticated;
revoke all on function public.refresh_pinned_steam_playtime(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.capture_steam_playtime_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_pinned_playtime_candidates(uuid,integer) to service_role;
grant execute on function public.refresh_pinned_steam_playtime(uuid,jsonb) to service_role;
grant execute on function public.capture_steam_playtime_snapshot(uuid) to service_role;

-- Protect full-library refreshes too: hidden zero/stale imports must not undo
-- newly observed playtime. Explicit manual edits remain unaffected by this RPC.
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
      when excluded.ownership = 'Owned' then greatest(public.user_games.hours_played, excluded.hours_played)
      else public.user_games.hours_played
    end,
    date_added = coalesce(public.user_games.date_added, excluded.date_added),
    last_played_at = case
      when excluded.ownership = 'Owned'
        then greatest(excluded.last_played_at, public.user_games.last_played_at)
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
      when excluded.ownership = 'Owned' then greatest(public.user_games.observed_playtime_minutes, excluded.observed_playtime_minutes)
      else public.user_games.observed_playtime_minutes
    end,
    updated_at = now()
  returning public.user_games.*;

  perform public.refresh_catalog_import_metrics(
    array(
      select distinct input.steam_appid::bigint
      from jsonb_to_recordset(p_games) as input(steam_appid text)
    ),
    now()
  );
end;
$function$;
