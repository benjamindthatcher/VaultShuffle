-- Publish successful app details when an optional review/Deck lookup hits 429.
-- Keep the existing shared 30-minute Store pause and five-attempt retry bound.
-- A partial publication receipt must replay without republishing or repausing.
begin;
set local lock_timeout='5s';
create or replace function ops.finish_catalogue_metadata(p_id bigint,p_token uuid,p_result jsonb)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare outcome text;d jsonb;total bigint;positive bigint;deck smallint;game integer;
  o ops.enrichment_outbox;h bytea;v_now timestamptz;
begin
  if p_result is null or jsonb_typeof(p_result)<>'object' or pg_column_size(p_result)>65536
    or (p_result ? 'rateLimited' and jsonb_typeof(p_result->'rateLimited')<>'boolean') then
    raise exception using errcode='22023',message='catalogue_result_invalid';
  end if;
  if p_result->>'status'='complete' then
    d:=p_result->'details';
    if (d->>'reviewTotal' is null)<>(d->>'reviewPositive' is null) then
      raise exception using errcode='22023',message='catalogue_reviews_invalid';
    end if;
    if d->>'reviewTotal' is not null then
      if jsonb_typeof(d->'reviewTotal')<>'number' or jsonb_typeof(d->'reviewPositive')<>'number'
        or (d->>'reviewTotal')!~'^[0-9]{1,10}$' or (d->>'reviewPositive')!~'^[0-9]{1,10}$' then
        raise exception using errcode='22023',message='catalogue_reviews_invalid';
      end if;
      total:=(d->>'reviewTotal')::bigint;positive:=(d->>'reviewPositive')::bigint;
      if total>2147483647 or positive>total then
        raise exception using errcode='22023',message='catalogue_reviews_invalid';
      end if;
    end if;
    if d->>'deckCategory' is not null then
      if jsonb_typeof(d->'deckCategory')<>'number' or (d->>'deckCategory')!~'^[0-3]$' then
        raise exception using errcode='22023',message='catalogue_deck_invalid';
      end if;
      deck:=(d->>'deckCategory')::smallint;
    end if;
    if p_result->>'rateLimited'='true' then
      h:=sha256(convert_to(p_result::text,'UTF8'));
      select * into o from ops.enrichment_outbox where id=p_id for update;
      if not found or o.lease_token is distinct from p_token then return 'stale';end if;
      if o.status in('retryable','failed') and o.last_error_code='optional_rate_limited' then
        if o.result_hash=h then return 'replayed';else return 'stale';end if;
      end if;
    end if;
  end if;
  -- The original publication helper owns the identity, lease and revision fences.
  outcome:=ops.finish_catalogue_metadata_v1(p_id,p_token,p_result);
  if outcome='published' then
    select game_id into game from ops.enrichment_outbox where id=p_id;
    if total is not null then
      update catalog.game_features set review_total=total,review_positive=positive,review_negative=total-positive
        where game_id=game;
    end if;
    -- Null optional signals preserve the stored facts. Successful Deck refreshes
    -- may upgrade or downgrade a known rating after the revision fence accepts it.
    if deck is not null then
      update catalog.game_features set deck_compatibility_detail=deck,deck_checked_at=clock_timestamp(),
        deck_compatibility=case when deck in(2,3) then 'supported' when deck=1 then 'unsupported' else 'unknown' end
        where game_id=game;
    end if;
    if p_result->>'rateLimited'='true' then
      v_now:=clock_timestamp();
      update ops.enrichment_outbox set status=case when attempt>=5 then 'failed' else 'retryable' end,
        available_at=v_now+interval '30 minutes',
        completed_at=case when attempt>=5 then v_now else null end,
        last_error_code='optional_rate_limited'
        where id=p_id;
      -- Keep result_hash and lease_token as the receipt for this publication.
      insert into ops.abuse_cooldowns(bucket,key_digest,window_started_at,source_window_seconds,request_count,observed_at,expires_at,algorithm_version,status)
        values('catalogue_store_pause',sha256(convert_to('steam_store','UTF8')),v_now,1800,1,v_now,v_now+interval '30 minutes','store_429_v1','active')
        on conflict(bucket,key_digest) do update set window_started_at=v_now,observed_at=v_now,expires_at=v_now+interval '30 minutes',status='active';
      update ops.enrichment_outbox set available_at=greatest(available_at,v_now+interval '30 minutes')
        where status in('pending','retryable');
    end if;
  end if;
  return outcome;
end $$;
revoke all on function ops.finish_catalogue_metadata(bigint,uuid,jsonb) from public,vault_app,vault_worker;
grant execute on function ops.finish_catalogue_metadata(bigint,uuid,jsonb) to vault_worker;
commit;
