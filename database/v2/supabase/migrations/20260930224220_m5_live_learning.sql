-- Fixed worker projections and one atomic live aggregate in the existing reco
-- relations. Imported warm-start evidence stays intact. No Blacklist timestamp,
-- decision history, user-copy table or nightly snapshot accumulation.
create function ops.learning_draws(p_after bigint,p_limit integer)
returns table(cursor bigint,entry jsonb)
language sql stable security definer set search_path=pg_catalog as $$
  select d.id,jsonb_build_object('id',d.id::text,'user_id',a.public_id,'steam_appid',d.steam_app_id::text,'mood',
    case when d.mood in('brain-off','chill','intense') then d.mood else null end,
    'genres',coalesce(m.genres,'[]'),'tags',coalesce(m.weighted_tags,'[]'),'title',coalesce(g.title,''),'events',
    coalesce((select jsonb_agg(jsonb_build_object('draw_id',d.id::text,'event_type',e.event_type,
      'created_at',to_char(e.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) order by e.occurred_at,e.id)
      from(select distinct on(event_type) * from app.vault_draw_events where draw_id=d.id and account_id=d.account_id order by event_type,id) e),'[]'))
  from app.vault_draws d join app.accounts a on a.id=d.account_id and a.lifecycle_status='active'
    left join catalog.games g on g.steam_app_id=d.steam_app_id left join catalog.game_metadata m on m.game_id=g.id
  where p_after>=0 and p_limit between 1 and 1000 and d.id>p_after and d.drawn_at>statement_timestamp()-interval '180 days'
  order by d.id limit greatest(0,least(p_limit,1000))
$$;
create function ops.learning_outcomes(p_after bigint,p_limit integer)
returns table(cursor bigint,entry jsonb)
language sql stable security definer set search_path=pg_catalog as $$
  select s.account_id::bigint*4294967296+s.game_id,jsonb_build_object('userId',a.public_id,'steamAppId',g.steam_app_id,
    'action',case when s.blacklisted then 'blacklist' else 'complete' end,
    'reviewedAt',case when s.blacklisted then null else to_char(s.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
    'genres',coalesce(m.genres,'[]'),'tags',coalesce(m.weighted_tags,'[]'),'title',g.title)
  from app.game_state s join app.accounts a on a.id=s.account_id and a.lifecycle_status='active'
    join catalog.games g on g.id=s.game_id and g.steam_app_id is not null left join catalog.game_metadata m on m.game_id=g.id
  where p_after>=0 and p_limit between 1 and 1000 and (s.account_id,s.game_id)>( (p_after/4294967296)::integer,(p_after%4294967296)::integer)
    and (s.blacklisted or s.completed_at>statement_timestamp()-interval '180 days')
  order by s.account_id,s.game_id limit greatest(0,least(p_limit,1000))
$$;
create function ops.learning_pins(p_after bigint,p_limit integer)
returns table(cursor bigint,entry jsonb)
language sql stable security definer set search_path=pg_catalog as $$
  select p.account_id::bigint*4294967296+p.game_id,jsonb_build_object('userId',a.public_id,'steamAppId',g.steam_app_id,
    'pinnedAt',to_char(max(p.pinned_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'genres',coalesce(m.genres,'[]'),'tags',coalesce(m.weighted_tags,'[]'),'title',g.title)
  from app.pins p join app.accounts a on a.id=p.account_id and a.lifecycle_status='active'
    join catalog.games g on g.id=p.game_id and g.steam_app_id is not null left join catalog.game_metadata m on m.game_id=g.id
  where p_after>=0 and p_limit between 1 and 1000 and (p.account_id,p.game_id)>((p_after/4294967296)::integer,(p_after%4294967296)::integer)
    and p.scope in('library','all') and p.pinned_at>statement_timestamp()-interval '180 days'
  group by p.account_id,p.game_id,a.public_id,g.steam_app_id,g.title,m.genres,m.weighted_tags
  order by p.account_id,p.game_id limit greatest(0,least(p_limit,1000))
$$;
create function ops.learning_playtime(p_after integer,p_limit integer)
returns table(game_id integer,steam_app_id bigint,endorsements numeric,launched bigint,unplayed bigint,total_hours numeric,owners bigint)
language sql stable security definer set search_path=pg_catalog as $$
  select l.game_id,g.steam_app_id,sum(least(1::numeric,greatest(0::numeric,(l.playtime_minutes-120)/1080.0))),
    count(*) filter(where l.playtime_minutes>0),count(*) filter(where l.playtime_minutes=0),sum(l.playtime_minutes)/60.0,count(*)
  from app.library_games l join app.accounts a on a.id=l.account_id and a.lifecycle_status='active'
    join catalog.games g on g.id=l.game_id and g.steam_app_id is not null left join app.account_capabilities c on c.account_id=a.id
  where p_after>=0 and p_limit between 1 and 1000 and l.game_id>p_after and l.playtime_minutes is not null
    and c.playtime_visibility is distinct from 'hidden'
  group by l.game_id,g.steam_app_id order by l.game_id limit greatest(0,least(p_limit,1000))
$$;
create function ops.learning_weights()
returns table(key text,positive numeric,total numeric)
language sql stable security definer set search_path=pg_catalog as $$
  select distinct on(weight_key) weight_key,positive,total from reco.operator_weight_versions
  where effective_at is null or effective_at<=statement_timestamp()
  order by weight_key,coalesce(effective_at,source_updated_at,created_at) desc,id desc limit 1000
$$;
create function ops.publish_live_learning(p_started_at timestamptz,p_preferences jsonb,p_games jsonb)
returns bigint language plpgsql security definer set search_path=pg_catalog as $$
declare v_snapshot bigint;v_now timestamptz:=clock_timestamp();
begin
  if p_started_at is null or p_started_at>v_now or p_started_at<v_now-interval '5 minutes'
    or not coalesce(jsonb_typeof(p_preferences)='array' and jsonb_array_length(p_preferences)<=200000,false)
    or not coalesce(jsonb_typeof(p_games)='array' and jsonb_array_length(p_games)<=100000,false)
    or pg_column_size(p_preferences)>33554432 or pg_column_size(p_games)>16777216 then
    raise exception using errcode='22023',message='learning_publish_invalid';end if;
  perform pg_advisory_xact_lock(61437,3);
  -- A slow older rebuild cannot replace a newer one.
  if exists(select 1 from reco.warm_start_snapshots where snapshot_key='live-learning' and frozen_at>p_started_at) then return null;end if;
  -- Acquire FK key shares before changing aggregate rows, avoiding a cascade
  -- deletion/publication cycle. No personal authored/revision columns change.
  perform 1 from app.accounts where lifecycle_status='active' order by id for key share;
  insert into reco.warm_start_snapshots(snapshot_key,snapshot_version,status,frozen_at)
    values('live-learning',1,'frozen',p_started_at)
    on conflict(snapshot_key,snapshot_version) do update set frozen_at=p_started_at,status='frozen'
    returning id into v_snapshot;
  delete from reco.user_genre_preferences where snapshot_id=v_snapshot;
  delete from reco.genre_preference_globals where snapshot_id=v_snapshot;
  delete from reco.game_preference_globals where snapshot_id=v_snapshot;
  insert into reco.user_genre_preferences(snapshot_id,account_id,source_user_id,genre,mood,positive,total,source_updated_at)
    select v_snapshot,a.id,a.public_id,r.genre,r.context_mood,r.positive,r.total,p_started_at
    from jsonb_to_recordset(p_preferences) r(user_id uuid,genre text,context_mood text,positive numeric,total numeric)
      join app.accounts a on a.public_id=r.user_id and a.lifecycle_status='active';
  insert into reco.genre_preference_globals(snapshot_id,genre,mood,positive,total,source_updated_at)
    select v_snapshot,genre,mood,sum(positive),sum(total),p_started_at from reco.user_genre_preferences
    where snapshot_id=v_snapshot group by genre,mood;
  insert into reco.game_preference_globals(snapshot_id,steam_app_id,game_id,positive,total,total_hours,source_updated_at)
    select v_snapshot,r.steam_app_id,g.id,r.positive,r.total,r.total_hours,p_started_at
    from jsonb_to_recordset(p_games) r(steam_app_id bigint,positive numeric,total numeric,total_hours numeric)
      left join catalog.games g on g.steam_app_id=r.steam_app_id;
  return v_snapshot;
end $$;
revoke all on function ops.learning_draws(bigint,integer),ops.learning_outcomes(bigint,integer),ops.learning_pins(bigint,integer),
  ops.learning_playtime(integer,integer),ops.learning_weights(),ops.publish_live_learning(timestamptz,jsonb,jsonb) from public,vault_app,vault_worker;
grant execute on function ops.learning_draws(bigint,integer),ops.learning_outcomes(bigint,integer),ops.learning_pins(bigint,integer),
  ops.learning_playtime(integer,integer),ops.learning_weights(),ops.publish_live_learning(timestamptz,jsonb,jsonb) to vault_worker;
