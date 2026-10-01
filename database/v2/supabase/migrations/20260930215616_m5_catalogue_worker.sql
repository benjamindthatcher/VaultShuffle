-- Drain the existing shared enrichment outbox directly. Store calls are not
-- keyed Steam API calls and must never be charged against that API's quota.
-- One global Store lease avoids overlapping cron/manual drains. No new queue,
-- catalogue copies, provider payload archive or per-user metadata is introduced.
alter table ops.enrichment_outbox
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column lease_catalog_revision integer,
  add column result_hash bytea check(result_hash is null or octet_length(result_hash)=32),
  add constraint enrichment_lease_bundle check(
    (lease_token is null and lease_expires_at is null and lease_catalog_revision is null)
    or (lease_token is not null and lease_expires_at is not null and lease_catalog_revision is not null));

create function ops.queue_catalogue_metadata(p_limit integer)
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare n integer;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception using errcode='22023',message='catalogue_limit';end if;
  insert into ops.enrichment_outbox(provider,game_id,catalog_revision,kind)
    select 'steam_store',g.id,coalesce(f.feature_revision,0),'metadata'
    from catalog.games g left join catalog.game_metadata m on m.game_id=g.id
    left join catalog.game_features f on f.game_id=g.id
    where g.steam_app_id is not null and g.lifecycle_status='active'
      and (m.fetched_at is null or m.fetched_at<statement_timestamp()-interval '30 days')
      and not exists(select 1 from ops.enrichment_outbox o where o.game_id=g.id
        and (o.status in('pending','enqueued','retryable') or o.completed_at>statement_timestamp()-interval '30 days'))
    order by m.fetched_at nulls first,g.id limit p_limit
    on conflict(provider,game_id,catalog_revision,kind) do nothing;
  get diagnostics n=row_count;return n;
end $$;

create function ops.claim_catalogue_metadata()
returns table(outbox_id bigint,lease_token uuid,steam_app_id bigint,provider_mode text)
language plpgsql security definer set search_path=pg_catalog as $$
declare o ops.enrichment_outbox; v_mode text; v_now timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(61437,2);
  select mode into v_mode from ops.provider_controls where provider='steam_store' for share;
  if v_mode not in('fixture','live') or v_mode is null then return;end if;
  if exists(select 1 from ops.abuse_cooldowns where bucket='catalogue_store_pause' and status='active' and expires_at>v_now) then return;end if;
  if exists(select 1 from ops.enrichment_outbox where lease_expires_at>v_now) then return;end if;
  -- A crash spends an attempt, then resumes after its lease. Five is terminal.
  update ops.enrichment_outbox set status='failed',completed_at=v_now,last_error_code='lease_attempts_exhausted'
    where status='enqueued' and lease_expires_at<=v_now and attempt>=5;
  select q.* into o from ops.enrichment_outbox q join catalog.games g on g.id=q.game_id
    where g.steam_app_id is not null and q.kind in('owned_identity','metadata') and q.attempt<5
      and ((q.status in('pending','retryable') and q.available_at<=v_now)
        or (q.status='enqueued' and q.lease_expires_at<=v_now))
    order by q.available_at,q.id limit 1 for update of q skip locked;
  if not found then return;end if;
  update ops.enrichment_outbox q set status='enqueued',attempt=q.attempt+1,enqueued_at=v_now,
    lease_token=gen_random_uuid(),lease_expires_at=v_now+interval '120 seconds',
    lease_catalog_revision=coalesce((select feature_revision from catalog.game_features where game_id=q.game_id),0),
    result_hash=null,last_error_code=null,last_error_detail=null
    where q.id=o.id returning q.* into o;
  return query select o.id,o.lease_token,g.steam_app_id,v_mode from catalog.games g where g.id=o.game_id;
end $$;

-- p_result is a bounded normalized Steam record, never an arbitrary provider
-- response. Publication is atomic, replayable and fenced by its claimed revision.
create function ops.finish_catalogue_metadata(p_id bigint,p_token uuid,p_result jsonb)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare o ops.enrichment_outbox;g catalog.games;v_now timestamptz:=clock_timestamp();h bytea;
  d jsonb;v_revision integer;v_offer bigint;v_status text;
begin
  if p_result is null or jsonb_typeof(p_result)<>'object' or pg_column_size(p_result)>65536 then
    raise exception using errcode='22023',message='catalogue_result_invalid';end if;
  h:=sha256(convert_to(p_result::text,'UTF8'));
  select * into o from ops.enrichment_outbox where id=p_id for update;
  if not found or o.lease_token is distinct from p_token then return 'stale';end if;
  if o.status='succeeded' then
    if o.result_hash=h then return 'replayed';else return 'stale';end if;
  end if;
  if o.status<>'enqueued' or o.lease_expires_at<=v_now then return 'stale';end if;
  select * into g from catalog.games where id=o.game_id for no key update;
  if g.steam_app_id::text is distinct from p_result->>'appId' then
    raise exception using errcode='22023',message='catalogue_appid_mismatch';end if;
  if coalesce(p_result->>'status','')<>'complete' then
    if coalesce(p_result->>'status','') not in('unavailable','retryable','invalid') then
      raise exception using errcode='22023',message='catalogue_status_invalid';end if;
    v_status:=case when o.attempt>=case when p_result->>'status'='unavailable' then 3 else 5 end then 'failed' else 'retryable' end;
    update ops.enrichment_outbox set status=v_status,last_error_code=p_result->>'status',
      available_at=v_now+case when p_result->>'status'='unavailable' then interval '1 day'
        when p_result->>'rateLimited'='true' then interval '30 minutes' else interval '5 minutes'*power(2,o.attempt) end,
      completed_at=case when v_status='failed' then v_now end,result_hash=h,lease_expires_at=v_now+interval '650 milliseconds' where id=o.id;
    -- Stop all Store work after a 429; other instances cannot bypass this pause.
    if p_result->>'rateLimited'='true' then
      insert into ops.abuse_cooldowns(bucket,key_digest,window_started_at,source_window_seconds,request_count,observed_at,expires_at,algorithm_version,status)
        values('catalogue_store_pause',sha256(convert_to('steam_store','UTF8')),v_now,1800,1,v_now,v_now+interval '30 minutes','store_429_v1','active')
        on conflict(bucket,key_digest) do update set window_started_at=v_now,observed_at=v_now,expires_at=v_now+interval '30 minutes',status='active';
      update ops.enrichment_outbox set available_at=greatest(available_at,v_now+interval '30 minutes') where status in('pending','retryable');
    end if;
    return v_status;
  end if;
  d:=p_result->'details';
  if not coalesce(jsonb_typeof(d)='object' and length(btrim(d->>'title')) between 1 and 500
    and length(btrim(d->>'sortTitle')) between 1 and 500 and jsonb_typeof(d->'genres')='array'
    and jsonb_typeof(d->'categories')='array' and d->>'decision' in('allowed','pending','excluded'),false)
    or jsonb_typeof(d->'genres')<>'array' or jsonb_typeof(d->'categories')<>'array'
    or d->>'decision' not in('allowed','pending','excluded') then
    raise exception using errcode='22023',message='catalogue_details_invalid';end if;
  select coalesce(feature_revision,0) into v_revision from catalog.game_features where game_id=g.id;
  if coalesce(v_revision,0)<>o.lease_catalog_revision then
    update ops.enrichment_outbox set status='failed',completed_at=v_now,last_error_code='catalogue_revision_changed',lease_expires_at=v_now+interval '650 milliseconds' where id=o.id;
    return 'stale';
  end if;
  -- Preserve curated titles and manually retired catalogue identities.
  update catalog.games set title=case when title_source='curated' then title else d->>'title' end,
    normalized_sort_title=case when title_source='curated' then normalized_sort_title else d->>'sortTitle' end,
    title_source=case when title_source='curated' then title_source else 'steam_name' end,updated_at=v_now where id=g.id;
  insert into catalog.game_metadata(game_id,short_description,header_image_url,capsule_image_url,genres,categories,
      developer,publisher,release_date,provider_name,fetched_at,updated_at)
    values(g.id,d->>'shortDescription',d->>'headerUrl',d->>'capsuleUrl',d->'genres',d->'categories',
      d->>'developer',d->>'publisher',(d->>'releaseDate')::date,'steam_store',v_now,v_now)
    on conflict(game_id) do update set short_description=excluded.short_description,header_image_url=excluded.header_image_url,
      capsule_image_url=excluded.capsule_image_url,genres=excluded.genres,categories=excluded.categories,
      developer=excluded.developer,publisher=excluded.publisher,release_date=excluded.release_date,
      provider_name=excluded.provider_name,fetched_at=excluded.fetched_at,updated_at=excluded.updated_at;
  insert into catalog.game_features(game_id,feature_revision,windows_compatibility,mac_compatibility,linux_compatibility,family_compatibility,updated_at)
    values(g.id,1,d->>'windows',d->>'mac',d->>'linux',
      case when d->'categories' @> '["Family Sharing"]'::jsonb and d->>'isFree'='false' then 'supported'
        when jsonb_array_length(d->'categories')=0 then 'unknown' else 'unsupported' end,v_now)
    on conflict(game_id) do update set feature_revision=catalog.game_features.feature_revision+1,
      windows_compatibility=excluded.windows_compatibility,mac_compatibility=excluded.mac_compatibility,
      linux_compatibility=excluded.linux_compatibility,family_compatibility=excluded.family_compatibility,updated_at=v_now;
  -- No duration/HLTB or tag fields are part of this metadata update.
  if not exists(select 1 from catalog.review_decisions where game_id=g.id and decision_kind='quarantine' and source='manual')
    and d->>'decision' in('pending','excluded') then
    insert into catalog.review_decisions(game_id,steam_app_id,decision_kind,source_relation,source_record_key,source,precedence_rank,
      decision_status,name,steam_type,matched_rule,reason,genres,categories,created_at,updated_at)
      values(g.id,g.steam_app_id,'quarantine','catalog_game_quarantine',g.steam_app_id::text,'automatic',10,
        d->>'decision',d->>'title',d->>'steamType',d->>'matchedRule',d->>'reason',d->'genres',d->'categories',v_now,v_now)
      on conflict(source_relation,source_record_key) do update set decision_status=excluded.decision_status,name=excluded.name,
        steam_type=excluded.steam_type,matched_rule=excluded.matched_rule,reason=excluded.reason,
        genres=excluded.genres,categories=excluded.categories,updated_at=v_now
      where catalog.review_decisions.source<>'manual' and
        (catalog.review_decisions.decision_status<>'excluded' or excluded.decision_status='excluded');
  end if;
  insert into catalog.offers(game_id,provider,region_code,is_free,first_observed_at,last_observed_at)
    values(g.id,'steam','US',(d->>'isFree')::boolean,v_now,v_now)
    on conflict(game_id,provider,region_code) do update set is_free=excluded.is_free,last_observed_at=v_now returning id into v_offer;
  if d->>'currency'='USD' then
    update catalog.offer_prices set is_current=false where offer_id=v_offer and is_current;
    insert into catalog.offer_prices(offer_id,observed_at,price_initial_cents,price_final_cents,discount_percent,is_free,retention_until)
      values(v_offer,v_now,(d->>'priceInitial')::integer,(d->>'priceFinal')::integer,(d->>'discountPercent')::smallint,
        (d->>'isFree')::boolean,v_now+interval '30 days');
    delete from catalog.offer_prices where offer_id=v_offer and not is_current and retention_until<=v_now;
  end if;
  insert into catalog.provider_state(game_id,provider,evidence_kind,status,fetched_at,updated_at)
    values(g.id,'steam_store','metadata','ready',v_now,v_now)
    on conflict(game_id,provider,evidence_kind) do update set status='ready',fetched_at=v_now,updated_at=v_now,
      processing_started_at=null,next_attempt_at=null,last_error=null,last_error_code=null,failure_count=0;
  update ops.enrichment_outbox set status='succeeded',completed_at=v_now,result_hash=h,lease_expires_at=v_now+interval '650 milliseconds' where id=o.id;
  return 'published';
end $$;
revoke all on function ops.queue_catalogue_metadata(integer),ops.claim_catalogue_metadata(),ops.finish_catalogue_metadata(bigint,uuid,jsonb)
  from public,vault_app,vault_worker;
grant execute on function ops.queue_catalogue_metadata(integer),ops.claim_catalogue_metadata(),ops.finish_catalogue_metadata(bigint,uuid,jsonb) to vault_worker;

-- Use the existing bounded worker run relation, with counts only. No private
-- library rows or raw upstream/SQL failures are retained in these summaries.
create function ops.record_worker_run(p_name text,p_started_at timestamptz,p_summary jsonb,p_failed boolean)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare v_now timestamptz:=clock_timestamp();
begin
  if p_name not in('nightly-metadata','catalogue-metadata','steam-tags','genre-preferences','pinned-playtime')
    or p_started_at is null or p_started_at>v_now or p_started_at<v_now-interval '10 minutes'
    or p_summary is null or jsonb_typeof(p_summary)<>'object' or pg_column_size(p_summary)>8192 then
    raise exception using errcode='22023',message='worker_summary_invalid';end if;
  insert into ops.legacy_worker_runs(legacy_id,worker_name,status,run_class,started_at,finished_at,duration_ms,counts,summary,retention_until)
    values(gen_random_uuid(),p_name,case when p_failed then 'failed' else 'succeeded' end,
      case when p_failed then 'failure' else 'routine' end,p_started_at,v_now,
      floor(extract(epoch from(v_now-p_started_at))*1000)::integer,p_summary,p_summary,
      p_started_at+case when p_failed then interval '30 days' else interval '14 days' end);
end $$;
revoke all on function ops.record_worker_run(text,timestamptz,jsonb,boolean) from public,vault_app,vault_worker;
grant execute on function ops.record_worker_run(text,timestamptz,jsonb,boolean) to vault_worker;
