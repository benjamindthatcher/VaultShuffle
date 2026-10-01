-- Keep the existing two public tag sources and their precedence. SteamSpy
-- is explicitly attributed; neither source consumes keyed Steam API quota.
alter table ops.enrichment_outbox drop constraint enrichment_outbox_provider_check;
alter table ops.enrichment_outbox add constraint enrichment_outbox_provider_check check(provider in('steam_store','steamspy'));
alter table ops.provider_controls drop constraint provider_controls_provider_check;
alter table ops.provider_controls add constraint provider_controls_provider_check check(provider in('steam','steam_store','steamspy'));
insert into ops.provider_controls(provider,mode,reason) values('steamspy','disabled','V2 tag enrichment is inactive until worker acceptance');

create function ops._claim_catalogue_work(p_kind text,p_provider text)
returns table(outbox_id bigint,lease_token uuid,steam_app_id bigint,provider_mode text)
language plpgsql security definer set search_path=pg_catalog as $$
declare o ops.enrichment_outbox; v_mode text; v_now timestamptz:=clock_timestamp();
begin
  if (p_provider,p_kind) not in (('steam_store','metadata'),('steam_store','tags'),('steamspy','tags')) then return;end if;
  perform pg_advisory_xact_lock(61437,2);
  select mode into v_mode from ops.provider_controls where provider=p_provider for share;
  if v_mode not in('fixture','live') or v_mode is null then return;end if;
  if exists(select 1 from ops.abuse_cooldowns where bucket='catalogue_store_pause' and status='active' and expires_at>v_now) then return;end if;
  if exists(select 1 from ops.enrichment_outbox where lease_expires_at>v_now) then return;end if;
  -- A crash spends an attempt, then resumes after its lease. Five is terminal.
  update ops.enrichment_outbox set status='failed',completed_at=v_now,last_error_code='lease_attempts_exhausted'
    where status='enqueued' and lease_expires_at<=v_now and attempt>=5;
  select q.* into o from ops.enrichment_outbox q join catalog.games g on g.id=q.game_id
    where g.steam_app_id is not null and q.provider=p_provider and (q.kind=p_kind or p_kind='metadata' and q.kind='owned_identity') and q.attempt<5
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

create or replace function ops.claim_catalogue_metadata()
returns table(outbox_id bigint,lease_token uuid,steam_app_id bigint,provider_mode text)
language sql security definer set search_path=pg_catalog as $$
  select * from ops._claim_catalogue_work('metadata','steam_store')
$$;

create function ops.queue_catalogue_tags(p_provider text,p_limit integer)
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare n integer;
begin
  if p_provider is null or p_provider not in('steam_store','steamspy') or p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode='22023',message='tag_queue_invalid';end if;
  insert into ops.enrichment_outbox(provider,game_id,catalog_revision,kind)
    select p_provider,g.id,coalesce(f.feature_revision,0),'tags'
    from catalog.games g left join catalog.game_features f on f.game_id=g.id
    left join catalog.game_metadata m on m.game_id=g.id
    where g.steam_app_id is not null and g.lifecycle_status='active'
      and case when p_provider='steamspy' then (f.tags_source is null or f.tags_source='steamspy')
        and (f.tags_fetched_at is null or f.tags_fetched_at<statement_timestamp()-interval '30 days')
      else (jsonb_array_length(coalesce(m.weighted_tags,'[]'))=0 or f.tags_source in('steam-store','steam_store'))
        and (f.store_tags_checked_at is null or f.store_tags_checked_at<statement_timestamp()-
          case when f.store_tags_state='unavailable' then interval '180 days' else interval '30 days' end) end
      and not exists(select 1 from ops.enrichment_outbox o where o.game_id=g.id and o.provider=p_provider and o.kind='tags'
        and (o.status in('pending','enqueued','retryable') or o.completed_at>statement_timestamp()-interval '30 days'))
    order by case when p_provider='steamspy' then f.tags_fetched_at else f.store_tags_checked_at end nulls first,g.id limit p_limit
    on conflict(provider,game_id,catalog_revision,kind) do nothing;
  get diagnostics n=row_count;return n;
end $$;

create function ops.claim_catalogue_tags(p_provider text)
returns table(outbox_id bigint,lease_token uuid,steam_app_id bigint,provider_mode text,facts jsonb)
language sql security definer set search_path=pg_catalog as $$
  select c.*,jsonb_build_object('genres',coalesce(m.genres,'[]'),'categories',coalesce(m.categories,'[]'),
    'mainStoryMinutes',f.main_duration_minutes,'completionistMinutes',f.completion_duration_minutes,
    'durationKind',f.duration_kind,'durationSource',f.duration_source,'durationManualOverride',f.duration_manual_override,
    'gameType',g.game_type)
  from ops._claim_catalogue_work('tags',p_provider) c join catalog.games g on g.steam_app_id=c.steam_app_id
    left join catalog.game_metadata m on m.game_id=g.id left join catalog.game_features f on f.game_id=g.id
$$;

create function ops.finish_catalogue_tags(p_id bigint,p_token uuid,p_result jsonb)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare o ops.enrichment_outbox;g catalog.games;f catalog.game_features;m catalog.game_metadata;
  h bytea;v_now timestamptz:=clock_timestamp();v_write boolean;v_tags jsonb;
begin
  if p_result is null or jsonb_typeof(p_result)<>'object' or pg_column_size(p_result)>32768 then
    raise exception using errcode='22023',message='tag_result_invalid';end if;
  h:=sha256(convert_to(p_result::text,'UTF8'));
  select * into o from ops.enrichment_outbox where id=p_id for update;
  if not found or o.kind<>'tags' or o.lease_token is distinct from p_token or o.provider is distinct from p_result->>'provider' then return 'stale';end if;
  if o.status='succeeded' then if o.result_hash=h then return 'replayed';else return 'stale';end if;end if;
  if o.status<>'enqueued' or o.lease_expires_at<=v_now then return 'stale';end if;
  if p_result->>'status' is distinct from 'complete' then
    return ops.finish_catalogue_metadata(p_id,p_token,p_result);
  end if;
  if not coalesce(jsonb_typeof(p_result->'tags')='array' and jsonb_array_length(p_result->'tags')<=100
      and p_result->>'state' in('ok','no_tags','age_gated','unavailable'),false) then
    raise exception using errcode='22023',message='tags_invalid';end if;
  select * into g from catalog.games where id=o.game_id for no key update;
  if g.steam_app_id::text is distinct from p_result->>'appId' then raise exception using errcode='22023',message='tag_appid_mismatch';end if;
  select * into f from catalog.game_features where game_id=g.id for update;
  if coalesce(f.feature_revision,0)<>o.lease_catalog_revision then
    update ops.enrichment_outbox set status='failed',completed_at=v_now,last_error_code='catalogue_revision_changed',
      lease_expires_at=v_now+interval '1100 milliseconds' where id=o.id;return 'stale';end if;
  select * into m from catalog.game_metadata where game_id=g.id;
  v_tags:=p_result->'tags';
  -- Same precedence as tagWriteDecision: a blank refresh cannot clear good tags,
  -- and SteamSpy cannot replace another source. Store tags always win when read.
  v_write:=p_result->>'state'='ok' and jsonb_array_length(v_tags)>0 and
    (o.provider='steam_store' or jsonb_array_length(coalesce(m.weighted_tags,'[]'))=0 or f.tags_source is null or f.tags_source='steamspy');
  if v_write then
    insert into catalog.game_metadata(game_id,weighted_tags,updated_at) values(g.id,v_tags,v_now)
      on conflict(game_id) do update set weighted_tags=v_tags,updated_at=v_now;
  end if;
  insert into catalog.game_features(game_id,feature_revision,tags_source,tags_status,tags_fetched_at,
    store_tags_checked_at,store_tags_state,updated_at)
    values(g.id,1,case when v_write then case when o.provider='steam_store' then 'steam-store' else 'steamspy' end end,
      'ready',case when v_write or o.provider='steamspy' then v_now end,case when o.provider='steam_store' then v_now end,case when o.provider='steam_store' then p_result->>'state' end,v_now)
    on conflict(game_id) do update set feature_revision=catalog.game_features.feature_revision+1,
      tags_source=case when v_write then excluded.tags_source else catalog.game_features.tags_source end,
      tags_status='ready',tags_fetched_at=case when v_write or o.provider='steamspy' and (catalog.game_features.tags_source is null or catalog.game_features.tags_source='steamspy')
        then v_now else catalog.game_features.tags_fetched_at end,
      store_tags_checked_at=coalesce(excluded.store_tags_checked_at,catalog.game_features.store_tags_checked_at),
      store_tags_state=coalesce(excluded.store_tags_state,catalog.game_features.store_tags_state),tags_failure_count=0,tags_last_error=null,updated_at=v_now;
  if v_write and p_result->>'promoteEndless'='true' and g.game_type='game' and not coalesce(f.duration_manual_override,false)
    and lower(btrim(coalesce(f.duration_source,''))) not like 'manual%'
    and coalesce(f.duration_kind,'unknown') not in('endless','not-applicable')
    and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id and (d.duration_manual_override or d.decision_kind='quarantine' and d.decision_status='excluded')) then
    update catalog.game_features set duration_kind='endless',duration_source='classification',duration_status='ready',
      duration_confidence_label='medium',duration_source_updated_at=v_now where game_id=g.id;
  end if;
  insert into catalog.provider_state(game_id,provider,evidence_kind,status,fetched_at,updated_at)
    values(g.id,case when o.provider='steam_store' then 'steam-store' else 'steamspy' end,'tags','ready',v_now,v_now)
    on conflict(game_id,provider,evidence_kind) do update set status='ready',fetched_at=v_now,updated_at=v_now,
      next_attempt_at=null,processing_started_at=null,last_error=null,last_error_code=null,failure_count=0;
  update ops.enrichment_outbox set status='succeeded',completed_at=v_now,result_hash=h,
    lease_expires_at=v_now+case when o.provider='steamspy' then interval '1100 milliseconds' else interval '650 milliseconds' end where id=o.id;
  return 'published';
end $$;
revoke all on function ops._claim_catalogue_work(text,text) from public,vault_app,vault_worker;
revoke all on function ops.queue_catalogue_tags(text,integer),ops.claim_catalogue_tags(text),ops.finish_catalogue_tags(bigint,uuid,jsonb)
  from public,vault_app,vault_worker;
grant execute on function ops.queue_catalogue_tags(text,integer),ops.claim_catalogue_tags(text),ops.finish_catalogue_tags(bigint,uuid,jsonb) to vault_worker;

-- Stored HLTB/tag changes made outside this cron also need the existing endless
-- question re-asked. Keyset scan and bounded updates; never demote or erase time.
create function ops.endless_sweep_candidates(p_after integer,p_limit integer)
returns table(game_id integer,feature_revision integer,facts jsonb,weighted_tags jsonb)
language sql stable security definer set search_path=pg_catalog as $$
  select g.id,f.feature_revision,jsonb_build_object('genres',m.genres,'categories',m.categories,
    'mainStoryMinutes',f.main_duration_minutes,'completionistMinutes',f.completion_duration_minutes,
    'durationKind',f.duration_kind,'durationSource',f.duration_source,'durationManualOverride',f.duration_manual_override),m.weighted_tags
  from catalog.game_features f join catalog.games g on g.id=f.game_id join catalog.game_metadata m on m.game_id=g.id
  where p_after>=0 and p_limit between 1 and 250 and g.id>p_after and g.lifecycle_status='active' and g.game_type='game'
    and (f.updated_at>statement_timestamp()-interval '14 days' or m.updated_at>statement_timestamp()-interval '14 days')
    and f.duration_kind not in('endless','not-applicable') and not f.duration_manual_override
    and lower(btrim(coalesce(f.duration_source,''))) not like 'manual%' and jsonb_array_length(m.weighted_tags)>0
    and not exists(select 1 from catalog.review_decisions d where d.game_id=g.id and (d.duration_manual_override or d.decision_kind='quarantine' and d.decision_status='excluded'))
  order by g.id limit greatest(0,least(p_limit,250))
$$;
create function ops.promote_endless_batch(p_games jsonb)
returns integer language plpgsql security definer set search_path=pg_catalog as $$
declare r record;n integer:=0;changed integer;
begin
  if not coalesce(jsonb_typeof(p_games)='array' and jsonb_array_length(p_games)<=250,false) or pg_column_size(p_games)>32768 then
    raise exception using errcode='22023',message='endless_batch_invalid';end if;
  for r in select * from jsonb_to_recordset(p_games) as x(game_id integer,feature_revision integer) order by game_id loop
    update catalog.game_features f set duration_kind='endless',duration_source='classification',duration_status='ready',
      duration_confidence_label='medium',duration_source_updated_at=statement_timestamp(),updated_at=statement_timestamp(),feature_revision=f.feature_revision+1
      where f.game_id=r.game_id and f.feature_revision=r.feature_revision and f.duration_kind not in('endless','not-applicable')
        and not f.duration_manual_override and lower(btrim(coalesce(f.duration_source,''))) not like 'manual%'
        and exists(select 1 from catalog.games g where g.id=f.game_id and g.lifecycle_status='active' and g.game_type='game')
        and not exists(select 1 from catalog.review_decisions d where d.game_id=f.game_id and (d.duration_manual_override or d.decision_kind='quarantine' and d.decision_status='excluded'));
    get diagnostics changed=row_count;n:=n+changed;
  end loop;return n;
end $$;
revoke all on function ops.endless_sweep_candidates(integer,integer),ops.promote_endless_batch(jsonb) from public,vault_app,vault_worker;
grant execute on function ops.endless_sweep_candidates(integer,integer),ops.promote_endless_batch(jsonb) to vault_worker;
