begin;

-- Only the trusted server role can create sessions. The verified_steam caller
-- must first validate Steam OpenID; browser roles never execute this boundary.
create function app.start_session(
  p_steam_id bigint, p_kind text, p_digest bytea, p_expires_at timestamptz,
  p_display_name text, p_steam_display_name text, p_avatar_url text, p_profile_url text
) returns table(account_id integer, account_public_id uuid, resumed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_account integer;
  v_public uuid;
  v_resumed boolean;
begin
  if p_steam_id is null or p_steam_id::text !~ '^[0-9]{17}$'
    or p_kind is null or p_kind not in ('manual','verified_steam')
    or p_digest is null or octet_length(p_digest) <> 32
    or p_expires_at is null or p_expires_at <= statement_timestamp()
    or p_expires_at > statement_timestamp() + (case when p_kind='manual' then interval '365 days 5 minutes' else interval '30 days 5 minutes' end)
    or (p_kind='manual' and (p_display_name is null or length(btrim(p_display_name)) not between 1 and 80))
    or (p_display_name is not null and length(btrim(p_display_name)) not between 1 and 80)
    or (p_steam_display_name is not null and length(btrim(p_steam_display_name)) not between 1 and 80)
    or length(p_avatar_url)>2048 or length(p_profile_url)>2048
  then raise exception 'INVALID_SESSION_REQUEST'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vault-auth:'||p_kind||':'||p_steam_id::text,0));
  select a.id,a.public_id into v_account,v_public
  from app.accounts a join app.steam_profiles sp on sp.account_id=a.id
  where sp.steam_id=p_steam_id and sp.verified=(p_kind='verified_steam')
    and a.account_kind=case when p_kind='manual' then 'manual' else 'steam' end
    and a.lifecycle_status='active'
  order by sp.created_at desc,a.id desc limit 1 for update of a;
  v_resumed := found;
  if not v_resumed then
    insert into app.accounts(account_kind,display_name,last_seen_at)
      values(case when p_kind='manual' then 'manual' else 'steam' end,p_display_name,statement_timestamp())
      returning id,public_id into v_account,v_public;
    insert into app.steam_profiles(account_id,steam_id,verified,display_name,steam_display_name,avatar_url,profile_url)
      values(v_account,p_steam_id,p_kind='verified_steam',p_display_name,p_steam_display_name,p_avatar_url,p_profile_url);
  else
    update app.accounts set last_seen_at=statement_timestamp(),
      display_name=case when p_kind='verified_steam' then coalesce(p_display_name,display_name) else display_name end
      where id=v_account;
    update app.steam_profiles set
      display_name=case when p_kind='verified_steam' then coalesce(p_display_name,display_name) else display_name end,
      steam_display_name=coalesce(p_steam_display_name,steam_display_name),
      avatar_url=coalesce(p_avatar_url,avatar_url),profile_url=coalesce(p_profile_url,profile_url),updated_at=statement_timestamp()
      where app.steam_profiles.account_id=v_account;
  end if;
  insert into app.sessions(account_id,token_digest,session_kind,last_seen_at,expires_at)
    values(v_account,p_digest,p_kind,statement_timestamp(),p_expires_at);
  return query select v_account,v_public,v_resumed;
end $$;

-- Existing public-profile URL resumption is intentionally separate from a
-- verified Steam identity. Return only the metadata already shown at lookup.
create function app.lookup_manual_profile(p_steam_id bigint)
returns table(display_name text,steam_display_name text,avatar_url text)
language sql stable security definer set search_path = '' as $$
  select a.display_name,sp.steam_display_name,sp.avatar_url
  from app.accounts a join app.steam_profiles sp on sp.account_id=a.id
  where a.account_kind='manual' and a.lifecycle_status='active' and not sp.verified
    and sp.steam_id=p_steam_id and p_steam_id::text ~ '^[0-9]{17}$'
  order by sp.created_at desc,a.id desc limit 1
$$;

create function app.revoke_current_session(p_session_id bigint,p_digest bytea)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if app.current_account_id() is null then raise exception 'ACCOUNT_CONTEXT_REQUIRED'; end if;
  update app.sessions set revoked_at=coalesce(revoked_at,statement_timestamp())
    where account_id=app.current_account_id() and id=p_session_id and token_digest=p_digest;
  return found;
end $$;

create function app.update_current_profile(p_display_name text,p_avatar_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_account integer := app.current_account_id();
begin
  if v_account is null then raise exception 'ACCOUNT_CONTEXT_REQUIRED'; end if;
  if (p_display_name is not null and length(btrim(p_display_name)) not between 1 and 80)
    or length(p_avatar_url)>2048 then raise exception 'INVALID_PROFILE'; end if;
  update app.accounts set display_name=case when account_kind='steam' then coalesce(p_display_name,display_name) else display_name end where id=v_account;
  update app.steam_profiles set steam_display_name=coalesce(p_display_name,steam_display_name),
    display_name=case when verified then coalesce(p_display_name,display_name) else display_name end,
    avatar_url=coalesce(p_avatar_url,avatar_url),updated_at=statement_timestamp() where account_id=v_account;
end $$;

revoke all on function app.start_session(bigint,text,bytea,timestamptz,text,text,text,text),
  app.lookup_manual_profile(bigint),app.revoke_current_session(bigint,bytea),app.update_current_profile(text,text) from public;
grant execute on function app.start_session(bigint,text,bytea,timestamptz,text,text,text,text),
  app.lookup_manual_profile(bigint),app.revoke_current_session(bigint,bytea),app.update_current_profile(text,text) to vault_app;

-- Existing revisions invalidate pages after authored writes. Operator restores
-- have no tenant context and must preserve their serialized revision values.
create function app.bump_authored_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_account integer := case when TG_OP='DELETE' then OLD.account_id else NEW.account_id end;
begin
  if app.current_account_id() is not null then
    if app.current_account_id() <> v_account then raise exception 'ACCOUNT_CONTEXT_MISMATCH'; end if;
    if TG_OP <> 'UPDATE' or NEW is distinct from OLD then
      update app.accounts set state_revision=state_revision+1 where id=v_account;
      if TG_TABLE_NAME='collection_games' then
        update app.collections set revision=revision+1,updated_at=statement_timestamp()
          where account_id=v_account and id=case when TG_OP='DELETE' then OLD.collection_id else NEW.collection_id end;
      end if;
    end if;
  end if;
  return null;
end $$;
revoke all on function app.bump_authored_revision() from public;
do $$
declare relation_name text;
begin
  foreach relation_name in array array['game_state','pins','snoozes','vault_state','collections','collection_games','account_preferences'] loop
    execute format('create trigger bump_authored_revision after insert or update or delete on app.%I for each row execute function app.bump_authored_revision()',relation_name);
  end loop;
end $$;

-- Preserve the source algorithm: the current caller supplies each bucket's
-- policy window. No expiry is guessed from an imported row with no policy.
create function app.consume_request_limit(p_bucket text,p_digest bytea,p_limit integer,p_window_seconds integer)
returns table(allowed boolean,remaining integer,retry_after_seconds integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_count integer;
begin
  if p_bucket is null or p_bucket !~ '^[a-z0-9_]{1,64}$'
    or p_digest is null or octet_length(p_digest)<>32
    or p_limit is null or p_limit not between 1 and 10000
    or p_window_seconds is null or p_window_seconds not between 10 and 86400
    then raise exception 'INVALID_REQUEST_LIMIT'; end if;
  insert into ops.abuse_cooldowns as current_limit
    (bucket,key_digest,account_id,window_started_at,source_window_seconds,request_count,source_updated_at,observed_at,expires_at,algorithm_version,status)
  values(p_bucket,p_digest,app.current_account_id(),v_now,p_window_seconds,1,v_now,v_now,
    v_now+make_interval(secs=>p_window_seconds),'source-fixed-window-v1','active')
  on conflict(bucket,key_digest) do update set
    account_id=coalesce(current_limit.account_id,excluded.account_id),
    window_started_at=case when current_limit.window_started_at<=v_now-make_interval(secs=>p_window_seconds) then v_now else current_limit.window_started_at end,
    request_count=case when current_limit.window_started_at<=v_now-make_interval(secs=>p_window_seconds) then 1 else least(current_limit.request_count+1,p_limit+1) end,
    source_window_seconds=p_window_seconds,source_updated_at=v_now,observed_at=v_now,
    expires_at=(case when current_limit.window_started_at<=v_now-make_interval(secs=>p_window_seconds) then v_now else current_limit.window_started_at end)+make_interval(secs=>p_window_seconds),
    algorithm_version='source-fixed-window-v1',status='active'
  where current_limit.account_id is null or excluded.account_id is null or current_limit.account_id=excluded.account_id
  returning current_limit.window_started_at,current_limit.request_count into v_start,v_count;
  if not found then raise exception 'REQUEST_LIMIT_IDENTITY_MISMATCH'; end if;
  return query select v_count<=p_limit,greatest(0,p_limit-v_count),
    case when v_count<=p_limit then 0 else greatest(1,ceil(extract(epoch from(v_start+make_interval(secs=>p_window_seconds)-v_now)))::integer) end;
end $$;

create function app.refund_request_limit(p_bucket text,p_digest bytea)
returns void language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_bucket is null or p_bucket !~ '^[a-z0-9_]{1,64}$' or p_digest is null or octet_length(p_digest)<>32
    then raise exception 'INVALID_REQUEST_LIMIT'; end if;
  select request_count into v_count from ops.abuse_cooldowns
    where bucket=p_bucket and key_digest=p_digest for update;
  if not found then return; end if;
  if v_count=1 then delete from ops.abuse_cooldowns where bucket=p_bucket and key_digest=p_digest;
  else update ops.abuse_cooldowns set request_count=request_count-1 where bucket=p_bucket and key_digest=p_digest; end if;
end $$;
revoke all on function app.consume_request_limit(text,bytea,integer,integer),app.refund_request_limit(text,bytea) from public;
grant execute on function app.consume_request_limit(text,bytea,integer,integer),app.refund_request_limit(text,bytea) to vault_app;

create function app.apply_game_decision(p_game_id integer,p_action text,p_request_key uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_account integer := app.current_account_id();
  v_was_complete boolean;
  v_existing_game integer;
begin
  if v_account is null then raise exception 'ACCOUNT_CONTEXT_REQUIRED'; end if;
  if p_game_id is null or p_action is null or p_action not in ('complete','blacklist','reactivate')
    then raise exception 'INVALID_GAME_DECISION'; end if;
  perform 1 from app.accounts where id=v_account and lifecycle_status='active' for update;
  if not found then raise exception 'ACCOUNT_CONTEXT_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(v_account,p_game_id);
  if not exists(select 1 from catalog.games g where g.id=p_game_id and g.lifecycle_status='active'
    and (exists(select 1 from app.library_games where account_id=v_account and game_id=p_game_id)
      or exists(select 1 from app.family_game_access where account_id=v_account and game_id=p_game_id)))
    then raise exception 'GAME_NOT_FOUND'; end if;

  if p_action='complete' and p_request_key is not null then
    select game_id into v_existing_game from app.completion_events where account_id=v_account and dedupe_key=p_request_key::text;
    if found then
      if v_existing_game<>p_game_id then raise exception 'REQUEST_KEY_REUSED'; end if;
      return false;
    end if;
  end if;
  select completed_at is not null into v_was_complete from app.game_state where account_id=v_account and game_id=p_game_id;
  if p_action='complete' then
    if v_was_complete is true then return false; end if;
    insert into app.game_state(account_id,game_id,completed_at,blacklisted,revision)
      values(v_account,p_game_id,statement_timestamp(),false,1)
    on conflict(account_id,game_id) do update set completed_at=statement_timestamp(),blacklisted=false,
      revision=app.game_state.revision+1,updated_at=statement_timestamp();
    insert into app.completion_events(account_id,game_id,occurred_at,source,dedupe_key,
      origin_surface,legacy_hours_played,legacy_estimate_minutes,legacy_price_cents)
      select v_account,p_game_id,statement_timestamp(),'user',p_request_key::text,'library',lg.playtime_minutes::numeric/60,
        case when coalesce(gf.main_duration_minutes,0)+coalesce(gf.extras_duration_minutes,0)+coalesce(gf.completion_duration_minutes,0)>0 then
          greatest(60,round((coalesce(gf.main_duration_minutes,0)+coalesce(gf.extras_duration_minutes,0)+coalesce(gf.completion_duration_minutes,0))::numeric/
            nullif((case when gf.main_duration_minutes>0 then 1 else 0 end)+(case when gf.extras_duration_minutes>0 then 1 else 0 end)+(case when gf.completion_duration_minutes>0 then 1 else 0 end),0)/60)*60)::integer end,
        price.value
      from catalog.games g left join app.library_games lg on lg.account_id=v_account and lg.game_id=g.id
      left join catalog.game_features gf on gf.game_id=g.id
      left join lateral (select case when coalesce(p.is_free,o.is_free) then 0 else p.price_initial_cents end value
        from catalog.offers o left join catalog.offer_prices p on p.offer_id=o.id and p.is_current and p.currency='USD'
        where o.game_id=g.id and o.region_code='US' order by p.observed_at desc nulls last,o.last_observed_at desc,o.id desc limit 1) price on true
      where g.id=p_game_id;
  elsif p_action='blacklist' then
    -- Exactly the existing permanent flag, with no timestamp/history for it.
    insert into app.game_state(account_id,game_id,completed_at,blacklisted,revision)
      values(v_account,p_game_id,null,true,1)
    on conflict(account_id,game_id) do update set completed_at=null,blacklisted=true,
      revision=app.game_state.revision+1,updated_at=statement_timestamp()
      where app.game_state.completed_at is not null or not app.game_state.blacklisted;
  else
    delete from app.game_state where account_id=v_account and game_id=p_game_id
      and (completed_at is not null or blacklisted) and manual_progress is null and notes is null
      and review_requested_at is null and completion_dismissed_at is null;
    update app.game_state set completed_at=null,blacklisted=false,previous_active_status=null,
      revision=revision+1,updated_at=statement_timestamp()
      where account_id=v_account and game_id=p_game_id and (completed_at is not null or blacklisted);
    if v_was_complete is true then
      update app.completion_events set undone_at=statement_timestamp()
        where account_id=v_account and game_id=p_game_id and undone_at is null;
    end if;
  end if;
  if p_action in ('complete','blacklist') then
    delete from app.pins where account_id=v_account and scope='library' and game_id=p_game_id;
    update app.vault_state set current_game_id=null,revision=revision+1,updated_at=statement_timestamp()
      where account_id=v_account and current_game_id=p_game_id;
  end if;
  return true;
end $$;

create function app.set_game_notes(p_game_id integer,p_notes text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_account integer := app.current_account_id(); v_notes text := nullif(btrim(p_notes),'');
begin
  if v_account is null then raise exception 'ACCOUNT_CONTEXT_REQUIRED'; end if;
  if length(v_notes)>10000 then raise exception 'INVALID_GAME_NOTES'; end if;
  perform 1 from app.accounts where id=v_account and lifecycle_status='active' for update;
  if not found then raise exception 'ACCOUNT_CONTEXT_REQUIRED'; end if;
  if not exists(select 1 from app.library_games where account_id=v_account and game_id=p_game_id)
    and not exists(select 1 from app.family_game_access where account_id=v_account and game_id=p_game_id)
    then raise exception 'GAME_NOT_FOUND'; end if;
  if v_notes is not null then
    insert into app.game_state(account_id,game_id,notes,revision) values(v_account,p_game_id,v_notes,1)
    on conflict(account_id,game_id) do update set notes=v_notes,revision=app.game_state.revision+1,updated_at=statement_timestamp()
      where app.game_state.notes is distinct from v_notes;
  else
    delete from app.game_state where account_id=v_account and game_id=p_game_id
      and completed_at is null and not blacklisted and manual_progress is null
      and review_requested_at is null and completion_dismissed_at is null;
    update app.game_state set notes=null,revision=revision+1,updated_at=statement_timestamp()
      where account_id=v_account and game_id=p_game_id and notes is not null;
  end if;
end $$;
revoke all on function app.apply_game_decision(integer,text,uuid),app.set_game_notes(integer,text) from public;
grant execute on function app.apply_game_decision(integer,text,uuid),app.set_game_notes(integer,text) to vault_app;

-- The ordinary server can restore an existing decision and remove sparse
-- authored rows once their last fact is cleared. The existing forced tenant
-- policy applies to every operation; no public/client role receives access.
grant insert (blacklisted), update (blacklisted) on app.game_state to vault_app;
grant delete on app.game_state to vault_app;
-- Current completion review keeps measurements in its existing claim ledger.
grant update (origin_surface)
  on app.completion_events to vault_app;

-- Rebuild the existing on-demand regional Steam cache in the private catalogue.
-- Prices expire; permanent Blacklist state above has no expiry.
create table catalog.wishlist_store_cache (
  steam_app_id bigint not null check (steam_app_id between 1 and 4294967295),
  country text not null check (country in ('GB','US','DE','CA','AU')),
  game jsonb check (game is null or (jsonb_typeof(game)='object' and pg_column_size(game)<=65536)),
  checked_at timestamptz,
  expires_at timestamptz not null default 'epoch',
  retry_after timestamptz not null default 'epoch',
  lease_token uuid,
  lease_until timestamptz not null default 'epoch',
  primary key (steam_app_id,country)
);
alter table catalog.wishlist_store_cache enable row level security;
alter table catalog.wishlist_store_cache force row level security;
revoke all on catalog.wishlist_store_cache from public;
grant select,insert,update on catalog.wishlist_store_cache to vault_app;
create policy runtime_store_cache on catalog.wishlist_store_cache for all to vault_app using (true) with check (true);

create function catalog.claim_wishlist_store_refresh(p_appid bigint,p_country text,p_token uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare entry catalog.wishlist_store_cache; claimed boolean := false;
begin
  if p_token is null then raise exception 'INVALID_CACHE_LEASE'; end if;
  insert into catalog.wishlist_store_cache(steam_app_id,country) values(p_appid,p_country) on conflict do nothing;
  select * into entry from catalog.wishlist_store_cache where steam_app_id=p_appid and country=p_country for update;
  if entry.expires_at<=now() and entry.retry_after<=now() and entry.lease_until<=now() then
    update catalog.wishlist_store_cache set lease_token=p_token,lease_until=now()+interval '30 seconds'
      where steam_app_id=p_appid and country=p_country returning * into entry;
    claimed := true;
  end if;
  return to_jsonb(entry)||jsonb_build_object('claimed',claimed);
end $$;
revoke all on function catalog.claim_wishlist_store_refresh(bigint,text,uuid) from public;
grant execute on function catalog.claim_wishlist_store_refresh(bigint,text,uuid) to vault_app;

-- Kind changes were supported by the current collection editor. Keep them
-- tenant-protected and atomic with membership cleanup in the repository.
grant update (collection_kind) on app.collections to vault_app;

commit;

-- The Library's original Added value is an account fact, not catalogue
-- first_seen_at. Expose only that existing evidence to its owning account;
-- unrelated legacy measurements remain unavailable to the ordinary runtime.
create policy current_library_added_read on app.library_legacy_measurements
  for select to vault_app using (account_id = app.current_account_id());
grant select (account_id, steam_app_id, legacy_date_added_raw)
  on app.library_legacy_measurements to vault_app;
