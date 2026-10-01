-- Owner-bound, bounded lookup includes private quarantine evidence without
-- granting the runtime direct access to the internal review ledger.
create function app.pinned_playtime_targets()
returns table(game_id integer,steam_app_id text,eligible boolean)
language sql stable security definer set search_path=pg_catalog as $$
  select p.game_id,g.steam_app_id::text,
    l.game_id is not null and g.lifecycle_status='active' and g.steam_app_id is not null
    and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id and d.decision_kind='quarantine' and d.decision_status='excluded')
  from app.pins p join catalog.games g on g.id=p.game_id
    left join app.library_games l on l.account_id=p.account_id and l.game_id=p.game_id
  where p.account_id=app.current_account_id() and p.scope in ('library','all') order by p.slot limit 3
$$;
revoke all on function app.pinned_playtime_targets() from public,vault_app,vault_worker;
grant execute on function app.pinned_playtime_targets() to vault_app;

-- Reuse existing request counters for the current one-minute account + shared
-- Steam-library allowance. Shared identities must not bind to one workspace.
create function app.begin_pinned_playtime_window(p_account_digest bytea,p_steam_digest bytea)
returns table(allowed boolean,retry_after_seconds integer)
language plpgsql security definer set search_path=pg_catalog as $$
declare a integer:=app.current_account_id(); gate record;
begin
  if a is null or not exists(select 1 from ops._m2_authorized_profile(a))
    or p_account_digest is null or octet_length(p_account_digest)<>32
    or p_steam_digest is null or octet_length(p_steam_digest)<>32 then
    raise exception using errcode='22023',message='pinned_refresh_invalid'; end if;
  select * into gate from app.consume_request_limit('pinned_playtime_account',p_account_digest,1,60);
  if not gate.allowed then return query select false,gate.retry_after_seconds;return;end if;
  perform set_config('app.account_id','',true);
  select * into gate from app.consume_request_limit('pinned_playtime_steam',p_steam_digest,1,60);
  perform set_config('app.account_id',a::text,true);
  return query select gate.allowed,gate.retry_after_seconds;
end $$;
revoke all on function app.begin_pinned_playtime_window(bytea,bytea) from public,vault_app,vault_worker;
grant execute on function app.begin_pinned_playtime_window(bytea,bytea) to vault_app;

-- Serialize with authored writes/full publication before the applied M2
-- sync/charge fence. Preserve all its monotonic/anomaly/sweep rules verbatim.
alter function app.record_pinned_owned_observation(uuid,uuid,jsonb) rename to _m2_record_pinned_owned_observation;
revoke all on function app._m2_record_pinned_owned_observation(uuid,uuid,jsonb) from public,vault_app,vault_worker;
create function app.record_pinned_owned_observation(p_attempt_id uuid,p_attempt_token uuid,p_result jsonb)
returns table(accepted boolean,game_id integer,observed_at timestamptz,minutes integer,current_library boolean)
language plpgsql security definer set search_path=pg_catalog as $$
declare a integer:=app.current_account_id(); g integer;
begin
  if a is null then return query select false,null::integer,null::timestamptz,null::integer,false;return;end if;
  -- Serialize authored/revision writes, but permit a claim's account-FK key
  -- share while it holds the sync fence. We never change the account key.
  perform 1 from app.accounts where id=a for no key update;
  select c.scope_game_id into g from ops.provider_call_charges c
    where c.attempt_id=p_attempt_id and c.attempt_token=p_attempt_token and c.account_id=a and c.endpoint='pinned';
  if g is null or not exists(select 1 from app.library_games l join catalog.games cg on cg.id=l.game_id
      where l.account_id=a and l.game_id=g and cg.lifecycle_status='active'
      and not exists(select 1 from catalog.review_decisions d where d.game_id=g and d.decision_kind='quarantine' and d.decision_status='excluded')) then
    return query select false,g,clock_timestamp(),null::integer,false;return;end if;
  return query select * from app._m2_record_pinned_owned_observation(p_attempt_id,p_attempt_token,p_result);
end $$;
revoke all on function app.record_pinned_owned_observation(uuid,uuid,jsonb) from public,vault_app,vault_worker;
grant execute on function app.record_pinned_owned_observation(uuid,uuid,jsonb) to vault_app;
