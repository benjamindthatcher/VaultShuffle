-- Existing nightly sweeps, through worker-only fixed operations. Accounts are
-- selected from current identity/state; no fake browser sessions or new cursor
-- table. Existing job timestamps and charged pin attempts rotate the sweeps.
create function ops.schedule_owned_refresh(p_limit integer)
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare a record;j record;n integer:=0;capacity integer;
begin
  if p_limit is null or p_limit not between 1 and 150 then raise exception using errcode='22023',message='refresh_limit';end if;
  -- Preserve lane lock ordering before account/sync/job operations.
  perform ops._m2_queue_lock('vault_background');
  select greatest(0,20-count(*)::integer) into capacity from ops.jobs where lane='background' and job_kind='owned_snapshot'
    and status in('queued','enqueued','leased','fetching','publishing','retryable');
  if capacity=0 then return 0;end if;
  for a in select ac.id,last_job.requested_at from app.accounts ac
    join app.steam_profiles sp on sp.account_id=ac.id
    left join lateral(select max(created_at) requested_at from ops.jobs where account_id=ac.id and job_kind='owned_snapshot') last_job on true
    where ac.lifecycle_status='active' and (ac.account_kind='manual' or sp.verified)
      and (last_job.requested_at is null or last_job.requested_at<statement_timestamp()-interval '1 day')
      and not exists(select 1 from ops.jobs where account_id=ac.id and job_kind='owned_snapshot'
        and status in('queued','enqueued','leased','fetching','publishing','retryable'))
    order by last_job.requested_at nulls first,ac.id limit least(p_limit,capacity) loop
    select * into j from ops.request_owned_snapshot_for_account(a.id,gen_random_uuid());
    if j.job_id is not null and not j.coalesced then n:=n+1;end if;
  end loop;
  return n;
end $$;

create function ops.scheduled_pin_targets(p_limit integer)
returns table(account_id integer,game_id integer,steam_app_id text)
language sql stable security definer set search_path=pg_catalog as $$
  select p.account_id,p.game_id,g.steam_app_id::text
    from app.pins p join app.accounts a on a.id=p.account_id
    join app.steam_profiles sp on sp.account_id=a.id
    join app.library_games l on l.account_id=a.id and l.game_id=p.game_id
    join catalog.games g on g.id=p.game_id
    left join lateral(select max(charged_at) last_check from ops.provider_call_charges
      where account_id=a.id and scope_game_id=p.game_id and endpoint='pinned') c on true
    where p_limit between 1 and 150 and p.scope in('library','all') and a.lifecycle_status='active'
      and (a.account_kind='manual' or sp.verified) and g.lifecycle_status='active' and g.steam_app_id is not null
      and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id and d.decision_kind='quarantine' and d.decision_status='excluded')
      and (c.last_check is null or c.last_check<statement_timestamp()-interval '1 day')
    -- A bounded rotating pin scan. Older charged attempts sort before new ones.
    group by p.account_id,p.game_id,g.steam_app_id,c.last_check
    order by c.last_check nulls first,p.account_id,p.game_id limit greatest(0,least(p_limit,150))
$$;

create function ops.reserve_scheduled_pin(p_account_id integer,p_game_id integer)
returns table(game_id integer,steam_app_id text,steam_id text,attempt_id uuid,attempt_token uuid)
language plpgsql security definer set search_path=pg_catalog as $$
declare previous text:=current_setting('app.account_id',true);r record;appid bigint;subject bigint;
begin
  select g.steam_app_id,sp.steam_id into appid,subject from app.library_games l
    join catalog.games g on g.id=l.game_id join app.accounts a on a.id=l.account_id
    join app.steam_profiles sp on sp.account_id=a.id
    where l.account_id=p_account_id and l.game_id=p_game_id and g.lifecycle_status='active'
      and a.lifecycle_status='active' and (a.account_kind='manual' or sp.verified)
      and g.steam_app_id is not null and exists(select 1 from app.pins p where p.account_id=a.id and p.game_id=g.id and p.scope in('library','all'))
      and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id and d.decision_kind='quarantine' and d.decision_status='excluded');
  if not found then return;end if;
  perform set_config('app.account_id',p_account_id::text,true);
  select * into r from app.begin_pinned_owned_refresh(p_game_id);
  perform set_config('app.account_id',coalesce(previous,''),true);
  if r.allowed and r.provider_mode='live' then
    return query select p_game_id,appid::text,subject::text,r.attempt_id,r.attempt_token;
  end if;
end $$;

create function ops.publish_scheduled_pin(p_attempt_id uuid,p_attempt_token uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a integer;previous text:=current_setting('app.account_id',true);r record;
begin
  select account_id into a from ops.provider_call_charges where attempt_id=p_attempt_id and attempt_token=p_attempt_token and endpoint='pinned';
  if a is null then return false;end if;
  perform set_config('app.account_id',a::text,true);
  select * into r from app.record_pinned_owned_observation(p_attempt_id,p_attempt_token,p_result);
  perform set_config('app.account_id',coalesce(previous,''),true);
  return coalesce(r.accepted,false);
end $$;

-- Re-evaluate existing Family candidates after metadata changes. Each call
-- locks one real parent and uses the existing access reducer; users are neither
-- fabricated nor granted privileges. Repeat calls only select stale members.
create function ops.refresh_family_metadata(p_limit integer)
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare a record;n integer:=0;previous text:=current_setting('app.account_id',true);
begin
  if p_limit is null or p_limit not between 1 and 25 then raise exception using errcode='22023',message='family_refresh_limit';end if;
  for a in select ac.id from app.accounts ac where ac.lifecycle_status='active' and exists(
    select 1 from app.family_members fm cross join lateral jsonb_array_elements_text(fm.candidate_app_ids) c(appid)
    join catalog.games g on g.steam_app_id=c.appid::bigint
    join catalog.game_metadata m on m.game_id=g.id
    where fm.account_id=ac.id and (fm.checked_at is null or m.fetched_at>fm.checked_at)) order by ac.id limit p_limit loop
    perform 1 from app.accounts where id=a.id for no key update;
    perform set_config('app.account_id',a.id::text,true);
    perform app._refresh_family_access();n:=n+1;
  end loop;
  perform set_config('app.account_id',coalesce(previous,''),true);return n;
end $$;
revoke all on function ops.schedule_owned_refresh(integer),ops.scheduled_pin_targets(integer),ops.reserve_scheduled_pin(integer,integer),
  ops.publish_scheduled_pin(uuid,uuid,jsonb),ops.refresh_family_metadata(integer) from public,vault_app,vault_worker;
grant execute on function ops.schedule_owned_refresh(integer),ops.scheduled_pin_targets(integer),ops.reserve_scheduled_pin(integer,integer),
  ops.publish_scheduled_pin(uuid,uuid,jsonb),ops.refresh_family_metadata(integer) to vault_worker;
