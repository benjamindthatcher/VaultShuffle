-- Independent freshness clocks avoid refetching already-current Store facts.
-- The old claim boundary remains available during application rollout.
begin;
set local lock_timeout='5s';
alter table catalog.game_features add column reviews_checked_at timestamptz;

create function ops.catalogue_refresh_plan(p_game integer)
returns table(needs_details boolean,needs_reviews boolean,needs_deck boolean)
language sql stable security definer set search_path=pg_catalog as $$
  select m.fetched_at is null or m.fetched_at<=statement_timestamp()-interval '30 days',
    f.review_total is null or f.reviews_checked_at is null or f.reviews_checked_at<=statement_timestamp()-interval '30 days',
    f.deck_compatibility_detail is null or f.deck_checked_at is null or f.deck_checked_at<=statement_timestamp()-interval '30 days'
  from catalog.games g left join catalog.game_metadata m on m.game_id=g.id
  left join catalog.game_features f on f.game_id=g.id where g.id=p_game
$$;
revoke all on function ops.catalogue_refresh_plan(integer) from public,vault_app,vault_worker;

create function ops.claim_catalogue_refresh()
returns table(outbox_id bigint,lease_token uuid,steam_app_id bigint,provider_mode text,known_deck smallint,
  needs_details boolean,needs_reviews boolean,needs_deck boolean)
language sql security definer set search_path=pg_catalog as $$
  select c.outbox_id,c.lease_token,c.steam_app_id,c.provider_mode,c.known_deck,
    p.needs_details,p.needs_reviews,p.needs_deck
  from ops.claim_catalogue_metadata() c
  join catalog.games g on g.steam_app_id=c.steam_app_id
  cross join lateral ops.catalogue_refresh_plan(g.id) p
$$;
revoke all on function ops.claim_catalogue_refresh() from public,vault_app,vault_worker;
grant execute on function ops.claim_catalogue_refresh() to vault_worker;

create or replace function ops.queue_catalogue_metadata(p_limit integer)
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare n integer;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception using errcode='22023',message='catalogue_limit';end if;
  insert into ops.enrichment_outbox(provider,game_id,catalog_revision,kind)
    select 'steam_store',g.id,coalesce(f.feature_revision,0),'metadata'
    from catalog.games g left join catalog.game_metadata m on m.game_id=g.id
    left join catalog.game_features f on f.game_id=g.id
    where g.steam_app_id is not null and g.lifecycle_status='active'
      and (m.fetched_at is null or m.fetched_at<=statement_timestamp()-interval '30 days'
        or f.review_total is null or f.reviews_checked_at is null or f.reviews_checked_at<=statement_timestamp()-interval '30 days'
        or f.deck_compatibility_detail is null or f.deck_checked_at is null or f.deck_checked_at<=statement_timestamp()-interval '30 days')
      and not exists(select 1 from ops.enrichment_outbox o where o.game_id=g.id
        and (o.status in('pending','enqueued','retryable') or o.completed_at>statement_timestamp()-interval '30 days'))
    order by m.fetched_at nulls first,g.id limit p_limit
    on conflict(provider,game_id,catalog_revision,kind) do nothing;
  get diagnostics n=row_count;return n;
end $$;

alter function ops.finish_catalogue_metadata(bigint,uuid,jsonb) rename to finish_catalogue_details;
revoke all on function ops.finish_catalogue_details(bigint,uuid,jsonb) from public,vault_app,vault_worker;
create function ops.finish_catalogue_metadata(p_id bigint,p_token uuid,p_result jsonb)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare o ops.enrichment_outbox;d jsonb;h bytea;outcome text;v_now timestamptz:=clock_timestamp();
  total bigint;positive bigint;deck smallint;v_revision integer;v_appid bigint;p record;
begin
  if p_result is null or jsonb_typeof(p_result)<>'object' or pg_column_size(p_result)>65536
    or (p_result ? 'rateLimited' and jsonb_typeof(p_result->'rateLimited')<>'boolean')
    or (p_result ? 'optionalIncomplete' and jsonb_typeof(p_result->'optionalIncomplete')<>'boolean') then
    raise exception using errcode='22023',message='catalogue_result_invalid';end if;
  h:=sha256(convert_to(p_result::text,'UTF8'));
  select * into o from ops.enrichment_outbox where id=p_id for update;
  if not found or o.lease_token is distinct from p_token then return 'stale';end if;
  if o.status in('retryable','failed') and o.last_error_code='optional_incomplete' then
    if o.result_hash=h then return 'replayed';else return 'stale';end if;
  end if;
  if p_result->>'status' not in('signals','current') then
    outcome:=ops.finish_catalogue_details(p_id,p_token,p_result);
    if outcome<>'published' then return outcome;end if;
    d:=p_result->'details';
    if d->>'reviewTotal' is not null then
      update catalog.game_features set reviews_checked_at=v_now where game_id=o.game_id;
    end if;
  else
    if o.status='succeeded' then
      if o.result_hash=h then return 'replayed';else return 'stale';end if;
    end if;
    if o.status in('retryable','failed') and o.last_error_code='optional_rate_limited' then
      if o.result_hash=h then return 'replayed';else return 'stale';end if;
    end if;
    if o.status<>'enqueued' or o.lease_expires_at<=v_now then return 'stale';end if;
    select steam_app_id into v_appid from catalog.games where id=o.game_id for no key update;
    if v_appid::text is distinct from p_result->>'appId' then
      raise exception using errcode='22023',message='catalogue_appid_mismatch';end if;
    select coalesce(feature_revision,0) into v_revision from catalog.game_features where game_id=o.game_id for update;
    if coalesce(v_revision,0)<>o.lease_catalog_revision then
      update ops.enrichment_outbox set status='failed',completed_at=v_now,last_error_code='catalogue_revision_changed',
        lease_expires_at=v_now+interval '650 milliseconds' where id=p_id;return 'stale';end if;
    if p_result->>'status'='current' then
      select * into p from ops.catalogue_refresh_plan(o.game_id);
      if p.needs_details or p.needs_reviews or p.needs_deck
        or p_result->>'rateLimited'='true' or p_result->>'optionalIncomplete'='true' then
        raise exception using errcode='22023',message='catalogue_not_current';end if;
      -- A skipped job made no Store call, so it releases the global lease now.
      update ops.enrichment_outbox set status='succeeded',completed_at=v_now,result_hash=h,
        lease_expires_at=v_now where id=p_id;
      return 'current';
    end if;
    d:=p_result->'signals';
    if jsonb_typeof(d) is distinct from 'object' or (d->>'reviewTotal' is null)<>(d->>'reviewPositive' is null) then
      raise exception using errcode='22023',message='catalogue_reviews_invalid';end if;
    if d->>'reviewTotal' is not null then
      if jsonb_typeof(d->'reviewTotal')<>'number' or jsonb_typeof(d->'reviewPositive')<>'number'
        or (d->>'reviewTotal')!~'^[0-9]{1,10}$' or (d->>'reviewPositive')!~'^[0-9]{1,10}$' then
        raise exception using errcode='22023',message='catalogue_reviews_invalid';end if;
      total:=(d->>'reviewTotal')::bigint;positive:=(d->>'reviewPositive')::bigint;
      if total>2147483647 or positive>total then raise exception using errcode='22023',message='catalogue_reviews_invalid';end if;
    end if;
    if d->>'deckCategory' is not null then
      if jsonb_typeof(d->'deckCategory')<>'number' or (d->>'deckCategory')!~'^[0-3]$' then
        raise exception using errcode='22023',message='catalogue_deck_invalid';end if;
      deck:=(d->>'deckCategory')::smallint;
    end if;
    if total is not null or deck is not null then
      insert into catalog.game_features(game_id) values(o.game_id) on conflict(game_id) do nothing;
      update catalog.game_features set feature_revision=feature_revision+1,updated_at=v_now,
        review_total=coalesce(total,review_total),review_positive=coalesce(positive,review_positive),
        review_negative=case when total is not null then total-positive else review_negative end,
        reviews_checked_at=case when total is not null then v_now else reviews_checked_at end,
        deck_compatibility_detail=coalesce(deck,deck_compatibility_detail),
        deck_checked_at=case when deck is not null then v_now else deck_checked_at end,
        deck_compatibility=case when deck in(2,3) then 'supported' when deck=1 then 'unsupported' when deck=0 then 'unknown' else deck_compatibility end
        where game_id=o.game_id;
    end if;
    update ops.enrichment_outbox set status='succeeded',completed_at=v_now,result_hash=h,
      lease_expires_at=v_now+interval '650 milliseconds' where id=p_id;
    outcome:='published';
  end if;
  -- Complete details already use the accepted partial-429 publication boundary.
  if p_result->>'status'='complete' and p_result->>'rateLimited'='true' then return outcome;end if;
  if p_result->>'rateLimited'='true' or p_result->>'optionalIncomplete'='true' then
    update ops.enrichment_outbox set status=case when attempt>=5 then 'failed' else 'retryable' end,
      available_at=v_now+case when p_result->>'rateLimited'='true' then interval '30 minutes' else interval '5 minutes'*power(2,attempt) end,
      completed_at=case when attempt>=5 then v_now else null end,
      last_error_code=case when p_result->>'rateLimited'='true' then 'optional_rate_limited' else 'optional_incomplete' end
      where id=p_id;
    if p_result->>'rateLimited'='true' then
      insert into ops.abuse_cooldowns(bucket,key_digest,window_started_at,source_window_seconds,request_count,observed_at,expires_at,algorithm_version,status)
        values('catalogue_store_pause',sha256(convert_to('steam_store','UTF8')),v_now,1800,1,v_now,v_now+interval '30 minutes','store_429_v1','active')
        on conflict(bucket,key_digest) do update set window_started_at=v_now,observed_at=v_now,expires_at=v_now+interval '30 minutes',status='active';
      update ops.enrichment_outbox set available_at=greatest(available_at,v_now+interval '30 minutes') where status in('pending','retryable');
    end if;
  end if;
  return outcome;
end $$;
revoke all on function ops.finish_catalogue_metadata(bigint,uuid,jsonb) from public,vault_app,vault_worker;
grant execute on function ops.finish_catalogue_metadata(bigint,uuid,jsonb) to vault_worker;
commit;
