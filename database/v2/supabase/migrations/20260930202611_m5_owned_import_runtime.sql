-- Bounded current-app status/enqueue surface around the applied M2 engine.
create function app.latest_owned_import()
returns table(job_id uuid,status text,observed_count integer,result_code text,
  started_at timestamptz,completed_at timestamptz,retry_at timestamptz,play_history_missing boolean)
language sql stable security definer set search_path=pg_catalog as $$
  select j.id,j.status,j.observed_count,j.result_code,j.created_at,j.completed_at,
    greatest(j.available_at,j.provider_retry_at),c.playtime_visibility is distinct from 'visible'
  from ops.jobs j join app.accounts a on a.id=j.account_id
    left join app.account_capabilities c on c.account_id=a.id
  where j.account_id=app.current_account_id() and j.job_kind='owned_snapshot'
    and a.lifecycle_status='active' and exists(select 1 from ops._m2_authorized_profile(a.id))
  order by j.generation desc,j.created_at desc,j.id desc limit 1
$$;

create function app.begin_owned_import(p_request_key uuid,p_limit_digest bytea)
returns table(job_id uuid,status text,generation bigint,coalesced boolean,retry_after_seconds integer)
language plpgsql security definer set search_path=pg_catalog as $$
declare a integer:=app.current_account_id(); first_import boolean; gate record; j record; b text;
begin
  if a is null or p_request_key is null or p_limit_digest is null or octet_length(p_limit_digest)<>32 then
    raise exception using errcode='22023',message='owned_import_invalid'; end if;
  if not exists(select 1 from ops._m2_authorized_profile(a)) then
    return query select null::uuid,'active_profile_required',null::bigint,false,0;return; end if;
  -- Preserve nonce replay and coalescing before charging the user's cooldown.
  select jobs.* into j from ops.jobs jobs join ops.job_requests r on r.job_id=jobs.id
    where r.account_id=a and r.request_key=p_request_key;
  if not found then select jobs.* into j from ops.jobs jobs where jobs.account_id=a and jobs.job_kind='owned_snapshot'
    and jobs.status in ('queued','enqueued','leased','fetching','publishing','retryable') order by jobs.generation desc limit 1; end if;
  if j.id is null then
    first_import:=not exists(select 1 from app.library_games where account_id=a)
      and not exists(select 1 from app.library_sync_state where account_id=a and last_full_authoritative_at is not null);
    b:=case when first_import then 'steam_first_import' else 'steam_library_refresh' end;
    select * into gate from app.consume_request_limit(b,p_limit_digest,case when first_import then 10 else 1 end,300);
    if not gate.allowed then
      return query select null::uuid,'rate_limited',null::bigint,false,gate.retry_after_seconds;return; end if;
  end if;
  select * into j from app.request_owned_snapshot(p_request_key,'interactive');
  return query select j.job_id,j.status,j.generation,j.coalesced,
    case when j.quota_retry_at is null then 2 else greatest(2,ceil(extract(epoch from j.quota_retry_at-clock_timestamp())))::integer end;
end $$;
revoke all on function app.latest_owned_import(),app.begin_owned_import(uuid,bytea) from public,vault_app,vault_worker;
grant execute on function app.latest_owned_import(),app.begin_owned_import(uuid,bytea) to vault_app;

-- Complete publication must serialize with current authored decisions/Family
-- writes before touching pins or state. Keep the immutable M2 engine verbatim,
-- behind a narrow queue -> parent -> sync/job wrapper. Capture the existing
-- daily cumulative playtime fact only on a newly applied complete snapshot.
alter function ops.publish_owned_snapshot(uuid,uuid,jsonb,text,bytea,timestamptz,bigint)
  rename to _m2_publish_owned_snapshot;
revoke all on function ops._m2_publish_owned_snapshot(uuid,uuid,jsonb,text,bytea,timestamptz,bigint)
  from public,vault_app,vault_worker;
create function ops.publish_owned_snapshot(p_job_id uuid,p_lease_token uuid,p_result jsonb,
  p_canonical_json text default null,p_content_hash bytea default null,p_body_observed_at timestamptz default null,p_message_id bigint default null)
returns table(result text,job_id uuid,account_id integer,generation bigint,applied_generation bigint,snapshot_hash bytea,
  observed_count integer,library_changed integer,activity_changed integer,retired_count integer,
  sweep_deferred_count integer,enrichment_enqueued integer,acknowledged boolean)
language plpgsql security definer set search_path=pg_catalog as $$
declare j record; published record; known_count integer; coverage_value text;
begin
  select jobs.account_id,jobs.lane into j from ops.jobs jobs where jobs.id=p_job_id;
  if j.account_id is not null then
    perform ops._m2_queue_lock(ops._m2_queue_name(j.lane));
    perform 1 from app.accounts where id=j.account_id for no key update;
  end if;
  select * into published from ops._m2_publish_owned_snapshot(p_job_id,p_lease_token,p_result,
    p_canonical_json,p_content_hash,p_body_observed_at,p_message_id);
  if published.result='applied' and p_result->>'status'='complete' then
    -- The M2 engine has validated canonical input and committed its monotonic
    -- owned facts in this transaction. Family observations never enter this sum.
    select count(*) filter(where x.value->>'playtimeMinutes' is not null)::integer
      into known_count from jsonb_array_elements(p_canonical_json::jsonb->'games') x(value);
    -- A hidden/missing playtime body must not create a false zero observation.
    if known_count>0 or published.observed_count=0 then
      select case when count(*)=known_count then 'complete' else 'partial' end
        into coverage_value from app.library_games l where l.account_id=published.account_id;
      insert into app.playtime_daily as daily
        (account_id,activity_day,observed_minutes,coverage,recorded_at,games_with_playtime)
      select published.account_id,(p_body_observed_at at time zone 'UTC')::date,
        coalesce(sum(l.playtime_minutes),0)::bigint,coverage_value,p_body_observed_at,
        count(*) filter(where l.playtime_minutes>0)::integer
      from app.library_games l where l.account_id=published.account_id
      on conflict on constraint playtime_daily_pkey do update set
        observed_minutes=excluded.observed_minutes,coverage=excluded.coverage,
        recorded_at=excluded.recorded_at,games_with_playtime=excluded.games_with_playtime
      where excluded.recorded_at>=daily.recorded_at
        and (excluded.coverage='complete' or daily.coverage<>'complete');
    end if;
  end if;
  -- Terminal response-loss replay is read-only, including across a UTC midnight.
  return query select published.result,published.job_id,published.account_id,published.generation,
    published.applied_generation,published.snapshot_hash,published.observed_count,published.library_changed,
    published.activity_changed,published.retired_count,published.sweep_deferred_count,
    published.enrichment_enqueued,published.acknowledged;
end $$;
revoke all on function ops.publish_owned_snapshot(uuid,uuid,jsonb,text,bytea,timestamptz,bigint) from public,vault_app,vault_worker;
grant execute on function ops.publish_owned_snapshot(uuid,uuid,jsonb,text,bytea,timestamptz,bigint) to vault_worker;
