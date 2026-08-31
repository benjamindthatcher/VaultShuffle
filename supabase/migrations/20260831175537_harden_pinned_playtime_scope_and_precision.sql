-- Match the visible library shelf, including a pin removed/re-scoped during HTTP.
-- Keep observed minutes at the full import's 0.1h precision to avoid false recency.
create or replace function public.get_pinned_playtime_candidates(p_cursor uuid default null, p_limit integer default 150)
returns table(id uuid, steam_id text, appids text[])
language sql stable set search_path = '' as $$
  with identities as (
    select id, steam_id from public.app_users
    union all select id, steam_id from public.manual_steam_profiles
  ), candidates as (
    select a.id, a.steam_id, array_agg(distinct g.catalog_steam_appid::text) as appids
    from identities a
    join public.user_game_pins p on p.user_id = a.id and p.scope = 'library'
    join public.user_games g on g.id = p.game_id and g.user_id = a.id and g.ownership = 'Owned'
    where a.steam_id is not null and a.steam_id <> '' and g.catalog_steam_appid is not null
    group by a.id, a.steam_id
  )
  select * from candidates
  order by (p_cursor is null or candidates.id > p_cursor) desc, candidates.id
  limit least(greatest(coalesce(p_limit,150),1),150);
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
  perform 1 from public.user_game_pins where user_id=p_user_id and scope='library' for share;
  select count(*) into matched from public.user_games g
  where g.user_id=p_user_id and g.ownership='Owned'
    and exists(select 1 from public.user_game_pins p where p.user_id=p_user_id and p.scope='library' and p.game_id=g.id)
    and exists(select 1 from jsonb_to_recordset(p_games) as x(steam_appid text)
      where x.steam_appid::bigint=g.catalog_steam_appid);

  with input as (
    select steam_appid::bigint as appid,round(round(max(minutes)/60,1)*60)::integer as minutes,
      max(case when last_played_at <= now()+interval '5 minutes' then last_played_at end) as played_at
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
      and exists(select 1 from public.user_game_pins p where p.user_id=p_user_id and p.scope='library' and p.game_id=g.id)
      and (round(x.minutes::numeric/60,1)>g.hours_played
        or g.observed_playtime_minutes is null or x.minutes>g.observed_playtime_minutes
        or x.played_at>coalesce(g.last_played_at,'-infinity'::timestamptz))
    returning g.id
  ) select count(*) into changed from updated;
  -- A partial pin read is NOT a fresh whole-library daily snapshot.
  return jsonb_build_object('pinned_games_updated',changed,'pinned_games_matched',matched);
end;
$$;
