-- VaultShuffle v2 M2: fenced owned-library jobs, token-bucket quota, and
-- complete-snapshot publication. This migration is additive to the immutable
-- M1 foundation. It contains no credentials, network calls, or raw provider
-- bodies.

-- PGMQ is installed at the target's default available version. Do not pin a
-- version: Supabase manages extension versions independently of migrations.
create extension if not exists pgmq;

-- Queue creation is idempotent and runs as the migration owner (postgres on
-- the target). Queue names never cross a runtime API boundary.
do $$
begin
  perform pg_catalog.pg_advisory_xact_lock(hashtextextended('vaultshuffle:m2:queues', 0));
  perform pgmq.create('vault_interactive');
  perform pgmq.create('vault_background');
end
$$;

create table ops.provider_controls (
  provider text primary key check (provider in ('steam', 'steam_store')),
  mode text not null default 'disabled'
    check (mode in ('disabled', 'fixture', 'live')),
  reason text not null default 'preview provider calls are disabled'
    check (length(btrim(reason)) between 1 and 500),
  updated_at timestamptz not null default clock_timestamp()
);
insert into ops.provider_controls (provider, mode, reason)
values
  ('steam', 'disabled', 'preview provider calls are disabled'),
  ('steam_store', 'disabled', 'catalogue Store enrichment is not enabled in M2')
on conflict (provider) do nothing;

create table ops.jobs (
  id uuid primary key default gen_random_uuid(),
  job_kind text not null
    check (job_kind in ('owned_snapshot', 'catalog_enrichment')),
  lane text not null check (lane in ('interactive', 'background')),
  account_id integer references app.accounts(id) on delete cascade,
  game_id integer references catalog.games(id) on delete cascade,
  provider text not null check (provider in ('steam', 'steam_store')),
  generation bigint check (generation is null or generation >= 0),
  catalog_revision bigint check (catalog_revision is null or catalog_revision >= 0),
  first_request_key uuid,
  dedupe_key text not null check (length(btrim(dedupe_key)) between 1 and 256),
  status text not null default 'queued'
    check (status in (
      'queued', 'enqueued', 'leased', 'fetching', 'publishing',
      'succeeded', 'unavailable', 'invalid', 'retryable', 'failed', 'cancelled'
    )),
  attempt smallint not null default 0 check (attempt between 0 and 5),
  max_attempts smallint not null default 5 check (max_attempts between 1 and 5),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  fetch_started_at timestamptz,
  attempt_id uuid,
  attempt_token uuid,
  charged_at timestamptz,
  provider_mode text check (provider_mode is null or provider_mode in ('disabled', 'fixture', 'live')),
  queue_name text check (queue_name is null or queue_name in ('vault_interactive', 'vault_background')),
  message_id bigint,
  queue_acknowledged boolean not null default false,
  result_hash bytea check (result_hash is null or octet_length(result_hash) = 32),
  protocol_version smallint check (protocol_version is null or protocol_version between 1 and 32),
  observed_count integer check (observed_count is null or observed_count >= 0),
  result_code text check (result_code is null or length(btrim(result_code)) between 1 and 120),
  result_detail text check (result_detail is null or length(result_detail) <= 2000),
  retry_policy text not null default 'none'
    check (retry_policy in ('none', 'retryable', 'deferred', 'non_retryable')),
  provider_retry_at timestamptz,
  library_changed_count integer not null default 0 check (library_changed_count >= 0),
  activity_changed_count integer not null default 0 check (activity_changed_count >= 0),
  retired_count integer not null default 0 check (retired_count >= 0),
  sweep_deferred_count integer not null default 0 check (sweep_deferred_count >= 0),
  enrichment_enqueued_count integer not null default 0 check (enrichment_enqueued_count >= 0),
  applied_library_revision bigint check (applied_library_revision is null or applied_library_revision >= 0),
  applied_state_revision bigint check (applied_state_revision is null or applied_state_revision >= 0),
  applied_generation bigint check (applied_generation is null or applied_generation >= 0),
  completed_lease_token uuid,
  body_observed_at timestamptz,
  -- Cleanup is scheduled after M2. Successful summaries remain replayable for
  -- fourteen days; terminal outcomes remain inspectable for thirty.
  retain_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (account_id, id),
  check (
    (job_kind = 'owned_snapshot'
      and provider = 'steam'
      and account_id is not null and game_id is null
      and generation is not null and catalog_revision is null)
    or
    (job_kind = 'catalog_enrichment'
      and provider = 'steam_store'
      and account_id is null and game_id is not null
      and generation is null and catalog_revision is not null)
  ),
  check (
    (lease_token is null and lease_expires_at is null and fetch_started_at is null
      and attempt_id is null and attempt_token is null and charged_at is null)
    or
    (lease_token is not null and lease_expires_at is not null and fetch_started_at is not null
      and attempt_id is not null and attempt_token is not null and charged_at is not null)
  ),
  check (
    queue_name is null
    or (lane = 'interactive' and queue_name = 'vault_interactive')
    or (lane = 'background' and queue_name = 'vault_background')
  )
);

create unique index jobs_owned_active_account_uq
  on ops.jobs (account_id)
  where job_kind = 'owned_snapshot'
    and status in ('queued', 'enqueued', 'leased', 'fetching', 'publishing', 'retryable');
create unique index jobs_request_key_uq
  on ops.jobs (account_id, first_request_key)
  where first_request_key is not null;
create unique index jobs_shared_active_dedupe_uq
  on ops.jobs (dedupe_key)
  where job_kind = 'catalog_enrichment'
    and status in ('queued', 'enqueued', 'leased', 'fetching', 'publishing', 'retryable');
create index jobs_due_idx on ops.jobs (lane, available_at, id)
  where status in ('queued', 'enqueued', 'retryable');
create index jobs_lease_expiry_idx on ops.jobs (lease_expires_at, id)
  where status in ('leased', 'fetching', 'publishing');
create index jobs_account_generation_idx on ops.jobs (account_id, generation desc);
create index jobs_catalog_revision_idx on ops.jobs (provider, game_id, catalog_revision);

-- Every coalesced request UUID is retained as a small alias, including after
-- the first job reaches a terminal state. This prevents request B from
-- starting a new refresh after it was coalesced into active request A.
create table ops.job_requests (
  request_key uuid primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  job_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (account_id, request_key),
  foreign key (account_id, job_id)
    references ops.jobs(account_id, id) on delete cascade
);
create index job_requests_job_idx on ops.job_requests (job_id);

-- Daily UTC ceilings are counters; burst shaping is done by the token buckets
-- below rather than a fixed minute window.
create table ops.provider_quota_daily (
  provider text not null check (provider in ('steam')),
  usage_date date not null,
  lane_scope text not null check (lane_scope in ('all', 'background')),
  daily_limit bigint not null check (daily_limit > 0),
  charged_units bigint not null default 0 check (charged_units >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (provider, usage_date, lane_scope),
  check (charged_units <= daily_limit)
);

create table ops.provider_token_buckets (
  provider text not null check (provider in ('steam')),
  bucket_scope text not null check (bucket_scope in ('global', 'background')),
  capacity numeric(20, 6) not null check (capacity > 0),
  refill_per_second numeric(20, 6) not null check (refill_per_second > 0),
  tokens numeric(20, 6) not null check (tokens >= 0 and tokens <= capacity),
  last_refilled_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (provider, bucket_scope)
);
insert into ops.provider_token_buckets
  (provider, bucket_scope, capacity, refill_per_second, tokens)
values
  ('steam', 'global', 120, 2, 120),
  ('steam', 'background', 60, 1, 60)
on conflict (provider, bucket_scope) do nothing;

-- One row is the irrevocable charge for one provider attempt. It carries only
-- bounded correlation/provenance and an ephemeral DB-issued token.
create table ops.provider_call_charges (
  attempt_id uuid primary key,
  attempt_token uuid not null unique,
  job_id uuid,
  account_id integer references app.accounts(id) on delete cascade,
  scope_game_id integer references catalog.games(id) on delete cascade,
  provider text not null check (provider in ('steam')),
  endpoint text not null check (endpoint in (
    'owned_snapshot', 'profile', 'vanity', 'public_owned_lookup',
    'recent', 'pinned'
  )),
  lane text not null check (lane in ('interactive', 'background')),
  units integer not null check (units between 1 and 100),
  status text not null default 'charged'
    check (status in ('charged', 'applied', 'rejected', 'expired')),
  provider_mode text not null check (provider_mode in ('fixture', 'live')),
  provider_subject bigint,
  fetch_started_at timestamptz not null,
  charged_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > charged_at),
  completed_at timestamptz,
  check (provider_subject is null or provider_subject > 0),
  check ((endpoint = 'pinned') = (scope_game_id is not null)),
  check (job_id is null or account_id is not null),
  check (endpoint <> 'owned_snapshot' or job_id is not null),
  check (endpoint <> 'pinned' or account_id is not null),
  check (endpoint not in ('owned_snapshot', 'recent') or account_id is not null),
  check (endpoint not in ('profile', 'vanity', 'public_owned_lookup') or lane = 'interactive')
);
alter table ops.provider_call_charges
  add constraint provider_call_charges_job_account_fk
  foreign key (account_id, job_id)
  references ops.jobs(account_id, id) on delete cascade;
create index provider_call_charges_account_idx
  on ops.provider_call_charges (account_id, endpoint, fetch_started_at desc);
create index provider_call_charges_job_idx
  on ops.provider_call_charges (job_id, attempt_id);

create table ops.enrichment_outbox (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('steam_store')),
  game_id integer not null references catalog.games(id) on delete cascade,
  catalog_revision bigint not null check (catalog_revision >= 0),
  kind text not null check (length(btrim(kind)) between 1 and 80),
  status text not null default 'pending'
    check (status in ('pending', 'enqueued', 'succeeded', 'retryable', 'failed')),
  attempt smallint not null default 0 check (attempt between 0 and 5),
  available_at timestamptz not null default clock_timestamp(),
  last_error_code text check (last_error_code is null or length(btrim(last_error_code)) between 1 and 120),
  last_error_detail text check (last_error_detail is null or length(last_error_detail) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  enqueued_at timestamptz,
  completed_at timestamptz,
  unique (provider, game_id, catalog_revision, kind)
);
create index enrichment_outbox_due_idx on ops.enrichment_outbox (available_at, id)
  where status in ('pending', 'retryable');

create table app.library_observation_anomalies (
  id bigint generated always as identity primary key,
  event_key uuid not null default gen_random_uuid() unique,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id) on delete cascade,
  job_id uuid references ops.jobs(id) on delete set null,
  attempt_id uuid,
  reason text not null check (reason in (
    'provider_decrease', 'newer_observation_defers_removal',
    'pinned_superseded', 'invalid_pinned_result'
  )),
  prior_minutes integer check (prior_minutes is null or prior_minutes >= 0),
  incoming_minutes integer check (incoming_minutes is null or incoming_minutes >= 0),
  observed_at timestamptz not null default clock_timestamp(),
  source text not null check (length(btrim(source)) between 1 and 80),
  detail text check (detail is null or length(detail) <= 500)
);
create index library_observation_anomalies_account_idx
  on app.library_observation_anomalies (account_id, observed_at desc);

-- A pinned AppID can be a valid confirmation even when both playtime and
-- last-played are unknown.  Keep that sparse fence separate from
-- game_activity so unknown never becomes a fabricated zero measurement and
-- unchanged full imports do not stamp one activity row per game.
create table app.library_observation_fences (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id) on delete cascade,
  observation_scope text not null check (observation_scope = 'pinned_owned'),
  last_confirmed_at timestamptz not null,
  attempt_id uuid,
  primary key (account_id, game_id)
);
create index library_observation_fences_recent_idx
  on app.library_observation_fences (account_id, last_confirmed_at desc);

-- Additive provenance/fence columns to the immutable M1 relations.
alter table app.library_sync_state
  add column last_full_fetch_started_at timestamptz,
  add column last_full_authoritative_at timestamptz,
  add column active_request_key uuid;

alter table app.game_activity
  add column observation_scope text not null default 'full_owned',
  add column last_played_source text not null default 'not_provided';
alter table app.game_activity
  add constraint game_activity_observation_scope_chk
    check (observation_scope in ('full_owned', 'pinned_owned', 'user')),
  add constraint game_activity_last_played_source_chk
    check (last_played_source in (
      'steam.rtime_last_played', 'steam.rtime_last_played_unknown',
      'not_provided', 'user'
    ));

alter table catalog.games
  add column title_source text not null default 'existing';
alter table catalog.games
  add constraint games_title_source_chk
    check (title_source in ('steam_name', 'catalog_stub', 'curated', 'existing'));

alter table app.library_sync_state
  add constraint library_sync_active_job_fk
  foreign key (account_id, in_flight_job_id)
    references ops.jobs(account_id, id) on delete set null (in_flight_job_id);

create index game_activity_observation_idx
  on app.game_activity (account_id, observation_scope, observed_at desc);

-- M2 function layer.  Every definer function below names its private schemas
-- explicitly and obtains lease/quota timestamps from a fresh database clock.
-- The functions never perform network I/O and never store a provider body.

create or replace function ops._m2_authorized_profile(p_account_id integer)
returns table (
  account_id integer,
  account_kind text,
  provider_subject bigint,
  profile_verified boolean
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select a.id, a.account_kind, sp.steam_id, sp.verified
    from app.accounts as a
    join app.steam_profiles as sp on sp.account_id = a.id
   where a.id = p_account_id
     and a.lifecycle_status = 'active'
     and (
       (a.account_kind = 'manual')
       or (a.account_kind = 'steam' and sp.verified)
     )
$$;

create or replace function ops._m2_queue_name(p_lane text)
returns text
language sql
immutable
security invoker
set search_path = pg_catalog
as $$
  select case p_lane
    when 'interactive' then 'vault_interactive'
    when 'background' then 'vault_background'
    else null
  end
$$;

-- PGMQ read/delete/set-vt operations lock queue rows.  Every M2 path that
-- touches a queue takes this lane-specific transaction lock before it can
-- acquire an account/sync/job lock.  That gives request, claim, retry,
-- publish, renew, acknowledgement, and enqueue one queue -> tenant order and
-- prevents a worker response from deadlocking a queue reader.
create or replace function ops._m2_queue_lock(p_queue text)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if p_queue is null or p_queue not in ('vault_interactive', 'vault_background') then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'M2 queue is not allowlisted';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('vaultshuffle:m2:queue:' || p_queue, 0)
  );
end
$$;

-- A generic endpoint boundary is intentionally reusable by later profile,
-- vanity, recent, pinned, and catalogue callers.  The optional TTL is only a
-- bounded lease duration; callers cannot supply an expiry timestamp.
create or replace function ops.consume_provider_attempt(
  p_endpoint text,
  p_job_id uuid default null,
  p_scope_game_id integer default null,
  p_units integer default 1,
  p_attempt_id uuid default null,
  p_ttl_seconds integer default 120
)
returns table (
  allowed boolean,
  block_code text,
  attempt_id uuid,
  attempt_token uuid,
  account_id integer,
  provider_subject bigint,
  provider_mode text,
  fetch_started_at timestamptz,
  expires_at timestamptz,
  retry_at timestamptz,
  global_daily_remaining bigint,
  background_daily_remaining bigint,
  global_tokens numeric,
  background_tokens numeric
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_account_id integer;
  v_lane text := 'interactive';
  v_provider text := 'steam';
  v_provider_subject bigint;
  v_profile_verified boolean;
  v_mode text;
  v_now timestamptz;
  v_attempt_id uuid := coalesce(p_attempt_id, gen_random_uuid());
  v_attempt_token uuid;
  v_fetch_started_at timestamptz;
  v_expires_at timestamptz;
  v_job ops.jobs%rowtype;
  v_sync app.library_sync_state%rowtype;
  v_daily_date date;
  v_global_daily ops.provider_quota_daily%rowtype;
  v_background_daily ops.provider_quota_daily%rowtype;
  v_global_bucket ops.provider_token_buckets%rowtype;
  v_background_bucket ops.provider_token_buckets%rowtype;
  v_elapsed numeric;
  v_global_after numeric;
  v_background_after numeric;
  v_global_retry timestamptz;
  v_background_retry timestamptz;
  v_daily_retry timestamptz;
  v_retry_at timestamptz;
  v_current_account integer;
  v_endpoint text := btrim(coalesce(p_endpoint, ''));
  v_requested_attempt_id uuid := coalesce(p_attempt_id, gen_random_uuid());
  v_existing_charge ops.provider_call_charges%rowtype;
  v_replay boolean := false;
  v_inserted integer;
  v_fresh_date date;
begin
  if v_endpoint not in (
    'owned_snapshot', 'profile', 'vanity', 'public_owned_lookup',
    'recent', 'pinned'
  ) then
    return query select false, 'endpoint_not_allowed', v_attempt_id, null::uuid,
      null::integer, null::bigint, null::text, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  if p_units is null or p_units < 1 or p_units > 100 then
    return query select false, 'units_out_of_range', v_attempt_id, null::uuid,
      null::integer, null::bigint, null::text, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 15 or p_ttl_seconds > 300 then
    return query select false, 'ttl_out_of_range', v_attempt_id, null::uuid,
      null::integer, null::bigint, null::text, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;

  v_attempt_id := v_requested_attempt_id;
  if p_attempt_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_attempt_id::text, 0));
    select c.* into v_existing_charge
      from ops.provider_call_charges as c
     where c.attempt_id = p_attempt_id;
    v_replay := found;
  end if;

  if p_job_id is not null then
    select j.* into v_job
      from ops.jobs as j
     where j.id = p_job_id
     ;
    if not found then
      return query select false, 'job_not_found', v_attempt_id, null::uuid,
        null::integer, null::bigint, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz, null::bigint, null::bigint,
        null::numeric, null::numeric;
      return;
    end if;
    if v_job.provider <> v_provider or
       (v_job.job_kind = 'owned_snapshot' and v_endpoint <> 'owned_snapshot') or
       (v_job.job_kind = 'catalog_enrichment' and v_endpoint <> 'catalog_enrichment') or
       v_job.status not in ('queued', 'enqueued', 'retryable', 'leased', 'fetching', 'publishing') then
      return query select false, 'job_endpoint_or_state_invalid', v_attempt_id, null::uuid,
        v_job.account_id, null::bigint, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz, null::bigint, null::bigint,
        null::numeric, null::numeric;
      return;
    end if;
    v_account_id := v_job.account_id;
    v_lane := v_job.lane;
    -- Keep the same account/sync/job order as claim and publish.  The first
    -- read above only discovers the lock key; this second read is the
    -- authoritative job snapshot used for the charge.
    if v_job.job_kind = 'owned_snapshot' then
      insert into app.library_sync_state(account_id)
      values (v_job.account_id)
      on conflict on constraint library_sync_state_pkey do nothing;
      select s.* into v_sync
        from app.library_sync_state as s
       where s.account_id = v_job.account_id
       for update;
      select j.* into v_job
        from ops.jobs as j
       where j.id = p_job_id
       for update;
      if not found
         or v_job.provider <> v_provider
         or v_job.job_kind <> 'owned_snapshot'
         or v_job.status not in ('queued', 'enqueued', 'retryable', 'leased', 'fetching', 'publishing') then
        return query select false, 'job_endpoint_or_state_invalid', v_attempt_id, null::uuid,
          v_account_id, null::bigint, null::text, null::timestamptz,
          null::timestamptz, null::timestamptz, null::bigint, null::bigint,
          null::numeric, null::numeric;
        return;
      end if;
      v_account_id := v_job.account_id;
      v_lane := v_job.lane;
    end if;
  else
    v_current_account := app.current_account_id();
    v_account_id := v_current_account;
    if v_endpoint not in ('profile', 'vanity', 'public_owned_lookup') then
      if v_account_id is null then
        return query select false, 'account_required', v_attempt_id, null::uuid,
          null::integer, null::bigint, null::text, null::timestamptz,
          null::timestamptz, null::timestamptz, null::bigint, null::bigint,
          null::numeric, null::numeric;
        return;
      end if;
    elsif v_account_id is not null then
      v_lane := 'interactive';
    end if;
    if p_scope_game_id is not null and v_endpoint <> 'pinned' then
      return query select false, 'scope_not_allowed', v_attempt_id, null::uuid,
        v_account_id, null::bigint, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz, null::bigint, null::bigint,
        null::numeric, null::numeric;
      return;
    end if;
  end if;

  if v_lane not in ('interactive', 'background') then
    return query select false, 'lane_not_allowed', v_attempt_id, null::uuid,
      v_account_id, null::bigint, null::text, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  if v_account_id is not null then
    v_current_account := app.current_account_id();
    if v_current_account is not null
       and v_current_account <> v_account_id then
      return query select false, 'tenant_mismatch', v_attempt_id, null::uuid,
        v_account_id, null::bigint, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz, null::bigint, null::bigint,
        null::numeric, null::numeric;
      return;
    end if;
    select ap.provider_subject, ap.profile_verified
      into v_provider_subject, v_profile_verified
      from ops._m2_authorized_profile(v_account_id) as ap;
    if not found then
      return query select false, 'active_profile_required', v_attempt_id, null::uuid,
        v_account_id, null::bigint, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz, null::bigint, null::bigint,
        null::numeric, null::numeric;
      return;
    end if;
  elsif v_endpoint not in ('profile', 'vanity', 'public_owned_lookup') then
    return query select false, 'account_required', v_attempt_id, null::uuid,
      null::integer, null::bigint, null::text, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;

  if v_endpoint = 'pinned' then
    if v_account_id is null or p_scope_game_id is null then
      return query select false, 'pinned_scope_required', v_attempt_id, null::uuid,
        v_account_id, v_provider_subject, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz, null::bigint, null::bigint,
        null::numeric, null::numeric;
      return;
    end if;
    if not exists (
      select 1 from app.pins as pin
       where pin.account_id = v_account_id
         and pin.game_id = p_scope_game_id
         and pin.scope in ('library', 'all')
    ) then
      return query select false, 'pin_scope_not_authorized', v_attempt_id, null::uuid,
        v_account_id, v_provider_subject, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz, null::bigint, null::bigint,
        null::numeric, null::numeric;
      return;
    end if;
  elsif p_scope_game_id is not null then
    return query select false, 'scope_not_allowed', v_attempt_id, null::uuid,
      v_account_id, v_provider_subject, null::text, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;

  select pc.mode into v_mode
    from ops.provider_controls as pc
   where pc.provider = v_provider
   for update;
  if not found or v_mode = 'disabled' then
    return query select false, 'provider_disabled', v_attempt_id, null::uuid,
      v_account_id, v_provider_subject, coalesce(v_mode, 'disabled'),
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;
  if v_mode = 'fixture' and current_setting('app.m2_fixture', true) is distinct from 'on' then
    return query select false, 'fixture_not_enabled', v_attempt_id, null::uuid,
      v_account_id, v_provider_subject, v_mode, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;

  -- An attempt UUID is an idempotency key, never a bearer capability.  All
  -- caller, endpoint, pin, provider-mode, and fixture checks above run before
  -- this branch.  A replay returns no token or provider subject, so it cannot
  -- authorize a second HTTP call or disclose another tenant's identity.
  if v_replay then
    if v_existing_charge.endpoint <> v_endpoint
       or v_existing_charge.job_id is distinct from p_job_id
       or v_existing_charge.scope_game_id is distinct from p_scope_game_id
       or v_existing_charge.units <> p_units
       or v_existing_charge.lane <> v_lane
       or v_existing_charge.account_id is distinct from v_account_id
       or v_existing_charge.provider_mode is distinct from v_mode then
      return query select false, 'attempt_context_mismatch', v_attempt_id, null::uuid,
        v_account_id, null::bigint, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz, null::bigint, null::bigint,
        null::numeric, null::numeric;
      return;
    end if;
    if v_existing_charge.status = 'charged' then
      if v_existing_charge.expires_at <= clock_timestamp() then
        return query select false, 'attempt_expired', v_attempt_id, null::uuid,
          v_account_id, null::bigint, null::text, null::timestamptz,
          null::timestamptz, v_existing_charge.expires_at,
          null::bigint, null::bigint, null::numeric, null::numeric;
      else
        return query select false, 'attempt_already_charged', v_attempt_id, null::uuid,
          v_account_id, null::bigint, null::text, null::timestamptz,
          null::timestamptz, null::timestamptz,
          null::bigint, null::bigint, null::numeric, null::numeric;
      end if;
      return;
    end if;
    if v_existing_charge.status = 'applied' then
      return query select false, 'attempt_already_applied', v_attempt_id, null::uuid,
        v_account_id, null::bigint, null::text, null::timestamptz,
        null::timestamptz, null::timestamptz,
        null::bigint, null::bigint, null::numeric, null::numeric;
      return;
    end if;
    return query select false, 'attempt_not_reusable', v_attempt_id, null::uuid,
      v_account_id, null::bigint, null::text, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;

  -- Create and lock quota rows.  The provider control row is already held
  -- above.  Recheck the UTC date after every row-lock wait so a call crossing
  -- midnight cannot debit yesterday's counter.  The ordered daily/bucket
  -- locks prevent background/global inversion when lanes race.
  loop
    v_daily_date := (clock_timestamp() at time zone 'UTC')::date;
    insert into ops.provider_quota_daily(provider, usage_date, lane_scope, daily_limit)
    values (v_provider, v_daily_date, 'all', 80000),
           (v_provider, v_daily_date, 'background', 50000)
    on conflict (provider, usage_date, lane_scope) do nothing;
    select q.* into v_global_daily
      from ops.provider_quota_daily as q
     where q.provider = v_provider and q.usage_date = v_daily_date and q.lane_scope = 'all'
     for update;
    select q.* into v_background_daily
      from ops.provider_quota_daily as q
     where q.provider = v_provider and q.usage_date = v_daily_date and q.lane_scope = 'background'
     for update;
    select b.* into v_global_bucket
      from ops.provider_token_buckets as b
     where b.provider = v_provider and b.bucket_scope = 'global'
     for update;
    select b.* into v_background_bucket
      from ops.provider_token_buckets as b
     where b.provider = v_provider and b.bucket_scope = 'background'
     for update;
    v_now := clock_timestamp();
    v_fresh_date := (v_now at time zone 'UTC')::date;
    exit when v_fresh_date = v_daily_date;
  end loop;

  v_elapsed := greatest(0, extract(epoch from (v_now - v_global_bucket.last_refilled_at)));
  v_global_bucket.tokens := least(v_global_bucket.capacity,
    v_global_bucket.tokens + v_elapsed * v_global_bucket.refill_per_second);
  v_elapsed := greatest(0, extract(epoch from (v_now - v_background_bucket.last_refilled_at)));
  v_background_bucket.tokens := least(v_background_bucket.capacity,
    v_background_bucket.tokens + v_elapsed * v_background_bucket.refill_per_second);
  v_global_after := v_global_bucket.tokens - p_units;
  v_background_after := v_background_bucket.tokens
    - case when v_lane = 'background' then p_units else 0 end;
  v_global_retry := null;
  v_background_retry := null;
  v_daily_retry := null;
  if v_global_after < 0 then
    v_global_retry := v_now + ((-v_global_after) / v_global_bucket.refill_per_second) * interval '1 second';
  end if;
  if v_lane = 'background' and v_background_after < 0 then
    v_background_retry := v_now + ((-v_background_after) / v_background_bucket.refill_per_second) * interval '1 second';
  end if;
  if v_global_daily.charged_units + p_units > v_global_daily.daily_limit
     or (v_lane = 'background' and v_background_daily.charged_units + p_units > v_background_daily.daily_limit) then
    v_daily_retry := ((v_daily_date + 1)::timestamp at time zone 'UTC');
  end if;
  v_retry_at := greatest(coalesce(v_global_retry, v_now),
                         coalesce(v_background_retry, v_now),
                         coalesce(v_daily_retry, v_now));
  if v_global_after < 0 or (v_lane = 'background' and v_background_after < 0)
     or v_daily_retry is not null then
    return query select false, 'quota_exhausted', v_attempt_id, null::uuid,
      v_account_id, v_provider_subject, v_mode, null::timestamptz,
      null::timestamptz, v_retry_at, v_global_daily.daily_limit - v_global_daily.charged_units,
      v_background_daily.daily_limit - v_background_daily.charged_units,
      v_global_bucket.tokens, v_background_bucket.tokens;
    return;
  end if;

  v_global_bucket.tokens := v_global_after;
  if v_lane = 'background' then
    v_background_bucket.tokens := v_background_after;
  end if;
  update ops.provider_token_buckets
     set tokens = v_global_bucket.tokens, last_refilled_at = v_now, updated_at = v_now
   where provider = v_provider and bucket_scope = 'global';
  update ops.provider_token_buckets
     set tokens = v_background_bucket.tokens, last_refilled_at = v_now, updated_at = v_now
   where provider = v_provider and bucket_scope = 'background';
  update ops.provider_quota_daily
     set charged_units = charged_units + p_units, updated_at = v_now
   where provider = v_provider and usage_date = v_daily_date and lane_scope = 'all';
  if v_lane = 'background' then
    update ops.provider_quota_daily
       set charged_units = charged_units + p_units, updated_at = v_now
     where provider = v_provider and usage_date = v_daily_date and lane_scope = 'background';
  end if;

  v_fetch_started_at := v_now;
  v_expires_at := v_now + p_ttl_seconds * interval '1 second';
  v_attempt_token := gen_random_uuid();
  insert into ops.provider_call_charges(
    attempt_id, attempt_token, job_id, account_id, scope_game_id, provider,
    endpoint, lane, units, status, provider_mode, provider_subject,
    fetch_started_at, charged_at, expires_at
  ) values (
    v_attempt_id, v_attempt_token, p_job_id, v_account_id, p_scope_game_id,
    v_provider, v_endpoint, v_lane, p_units, 'charged', v_mode,
    v_provider_subject, v_fetch_started_at, v_now, v_expires_at
  ) on conflict on constraint provider_call_charges_pkey do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    -- This branch is defensive; callers supplying an attempt UUID are
    -- serialized by the advisory lock above.
    select c.attempt_token, c.account_id, c.provider_subject, c.provider_mode,
           c.fetch_started_at, c.expires_at
      into v_attempt_token, v_account_id, v_provider_subject, v_mode,
           v_fetch_started_at, v_expires_at
      from ops.provider_call_charges as c where c.attempt_id = v_attempt_id;
  end if;
  return query select true, null::text, v_attempt_id, v_attempt_token,
    v_account_id, v_provider_subject, v_mode, v_fetch_started_at, v_expires_at,
    null::timestamptz, v_global_daily.daily_limit - v_global_daily.charged_units - p_units,
    v_background_daily.daily_limit - v_background_daily.charged_units
      - case when v_lane = 'background' then p_units else 0 end,
    v_global_bucket.tokens, v_background_bucket.tokens;
end
$$;

-- Browser-facing quota reservation has no job or game parameters.  It is
-- deliberately limited to the pre-session/public lookup endpoints; owned and
-- pinned calls use their account/job wrappers below.  This keeps the generic
-- worker helper from becoming an arbitrary job-ID capability.
create or replace function app.consume_provider_attempt(
  p_endpoint text,
  p_units integer default 1,
  p_attempt_id uuid default null,
  p_ttl_seconds integer default 120
)
returns table (
  allowed boolean,
  block_code text,
  attempt_id uuid,
  attempt_token uuid,
  account_id integer,
  provider_subject bigint,
  provider_mode text,
  fetch_started_at timestamptz,
  expires_at timestamptz,
  retry_at timestamptz,
  global_daily_remaining bigint,
  background_daily_remaining bigint,
  global_tokens numeric,
  background_tokens numeric
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if btrim(coalesce(p_endpoint, '')) not in ('profile', 'vanity', 'public_owned_lookup') then
    return query select false, 'endpoint_not_allowed', coalesce(p_attempt_id, gen_random_uuid()),
      null::uuid, app.current_account_id(), null::bigint, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;
  -- This wrapper is the principal-free reservation boundary used before a
  -- manual account/session exists.  An authenticated caller may only replay
  -- an already-recorded attempt (which still goes through the raw helper's
  -- account/context comparison); it cannot create a fresh pre-session charge.
  if app.current_account_id() is not null
     and (p_attempt_id is null or not exists (
       select 1 from ops.provider_call_charges as c where c.attempt_id = p_attempt_id
     )) then
    return query select false, 'pre_session_only', coalesce(p_attempt_id, gen_random_uuid()),
      null::uuid, null::integer, null::bigint, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz,
      null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;
  return query select * from ops.consume_provider_attempt(
    p_endpoint => p_endpoint,
    p_job_id => null,
    p_scope_game_id => null,
    p_units => p_units,
    p_attempt_id => p_attempt_id,
    p_ttl_seconds => p_ttl_seconds
  );
end
$$;


create or replace function ops._m2_request_owned_snapshot(
  p_account_id integer,
  p_request_key uuid,
  p_lane text
)
returns table (
  job_id uuid,
  status text,
  generation bigint,
  coalesced boolean,
  quota_retry_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_profile record;
  v_mode text;
  v_sync app.library_sync_state%rowtype;
  v_existing ops.jobs%rowtype;
  v_job_id uuid;
  v_message_id bigint;
  v_queue text;
begin
  if p_account_id is null then
    return query select null::uuid, 'account_required'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;
  if p_request_key is null then
    return query select null::uuid, 'request_key_required'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;
  if p_lane is null or p_lane not in ('interactive', 'background') then
    return query select null::uuid, 'lane_not_allowed'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;
  v_queue := ops._m2_queue_name(p_lane);
  perform ops._m2_queue_lock(v_queue);
  select * into v_profile from ops._m2_authorized_profile(p_account_id);
  if not found then
    return query select null::uuid, 'active_profile_required'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;
  select pc.mode into v_mode
    from ops.provider_controls as pc where pc.provider = 'steam';
  if v_mode is null or v_mode = 'disabled' then
    return query select null::uuid, 'provider_disabled'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;
  if v_mode = 'fixture' and current_setting('app.m2_fixture', true) is distinct from 'on' then
    return query select null::uuid, 'fixture_not_enabled'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;

  insert into app.library_sync_state(account_id)
  values (p_account_id)
  on conflict on constraint library_sync_state_pkey do nothing;
  select s.* into v_sync
    from app.library_sync_state as s
   where s.account_id = p_account_id
   for update;

  -- The profile read before the fence only discovers whether this request can
  -- proceed.  Re-read it after taking the account sync lock so a concurrent
  -- profile/lifecycle change cannot create a job for a replaced identity.
  select * into v_profile from ops._m2_authorized_profile(p_account_id);
  if not found then
    return query select null::uuid, 'active_profile_required'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;

  select j.* into v_existing
    from ops.job_requests as r
    join ops.jobs as j on j.id = r.job_id
   where r.request_key = p_request_key
     and r.account_id = p_account_id;
  if found then
    return query select v_existing.id, v_existing.status, v_existing.generation,
      true, v_existing.provider_retry_at;
    return;
  end if;
  if exists (select 1 from ops.job_requests where request_key = p_request_key) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'request key belongs to another account';
  end if;

  select j.* into v_existing
    from ops.jobs as j
   where j.account_id = p_account_id
     and j.job_kind = 'owned_snapshot'
     and j.status in ('queued', 'enqueued', 'leased', 'fetching', 'publishing', 'retryable')
   order by j.created_at desc
   limit 1
   for update;
  if found then
    insert into ops.job_requests(request_key, account_id, job_id)
    values (p_request_key, p_account_id, v_existing.id);
    return query select v_existing.id, v_existing.status, v_existing.generation,
      true, v_existing.provider_retry_at;
    return;
  end if;

  v_job_id := gen_random_uuid();
  insert into ops.jobs(
    id, job_kind, lane, account_id, provider, generation, first_request_key,
    dedupe_key, status, max_attempts, available_at, protocol_version,
    queue_name
  ) values (
    v_job_id, 'owned_snapshot', p_lane, p_account_id, 'steam',
    v_sync.generation + 1, p_request_key,
    'owned_snapshot:' || p_account_id::text, 'queued', 5,
    clock_timestamp(), 1, v_queue
  );
  insert into ops.job_requests(request_key, account_id, job_id)
  values (p_request_key, p_account_id, v_job_id);
  update app.library_sync_state
     set generation = v_sync.generation + 1,
         in_flight_job_id = v_job_id,
         active_request_key = p_request_key,
         updated_at = clock_timestamp()
   where app.library_sync_state.account_id = p_account_id;
  select s.message_id into v_message_id
    from pgmq.send(v_queue, jsonb_build_object(
      'job_id', v_job_id::text,
      'protocolVersion', 1
    )) as s(message_id);
  update ops.jobs
     set status = 'enqueued', message_id = v_message_id, updated_at = clock_timestamp()
   where id = v_job_id;
  return query select v_job_id, 'enqueued'::text, v_sync.generation + 1,
    false, null::timestamptz;
end
$$;

create or replace function app.request_owned_snapshot(
  p_request_key uuid,
  p_lane text default 'interactive'
)
returns table (
  job_id uuid,
  status text,
  generation bigint,
  coalesced boolean,
  quota_retry_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_account_id integer;
begin
  v_account_id := app.current_account_id();
  if v_account_id is null then
    return query select null::uuid, 'account_required'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;
  if p_lane is distinct from 'interactive' then
    return query select null::uuid, 'lane_not_allowed'::text, null::bigint,
      false, null::timestamptz;
    return;
  end if;
  return query select * from ops._m2_request_owned_snapshot(
    v_account_id, p_request_key, 'interactive'
  );
end
$$;

create or replace function ops.request_owned_snapshot_for_account(
  p_account_id integer,
  p_request_key uuid
)
returns table (
  job_id uuid,
  status text,
  generation bigint,
  coalesced boolean,
  quota_retry_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  return query select * from ops._m2_request_owned_snapshot(
    p_account_id, p_request_key, 'background'
  );
end
$$;

create or replace function app.get_owned_snapshot_status(p_job_id uuid)
returns table (
  job_id uuid,
  status text,
  generation bigint,
  applied_generation bigint,
  snapshot_hash bytea,
  observed_count integer,
  result_code text,
  result_detail text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select j.id, j.status, j.generation, s.applied_generation, j.result_hash,
         j.observed_count, j.result_code, j.result_detail, j.updated_at
    from ops.jobs as j
    join app.library_sync_state as s on s.account_id = j.account_id
    join app.accounts as a on a.id = j.account_id
   where j.id = p_job_id
     and j.job_kind = 'owned_snapshot'
     and j.account_id = app.current_account_id()
     and a.lifecycle_status = 'active'
     and (
       a.account_kind = 'manual'
       or (a.account_kind = 'steam' and exists (
         select 1 from app.steam_profiles as sp
          where sp.account_id = a.id and sp.verified
       ))
     )
$$;

create or replace function ops.enqueue_job(p_job_id uuid)
returns table (message_id bigint, queue_name text)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job ops.jobs%rowtype;
  v_message_id bigint;
  v_queue text;
  v_ack boolean;
begin
  select j.* into v_job from ops.jobs as j where j.id = p_job_id;
  if not found then
    return query select null::bigint, null::text;
    return;
  end if;
  v_queue := ops._m2_queue_name(v_job.lane);
  perform ops._m2_queue_lock(v_queue);
  select j.* into v_job from ops.jobs as j where j.id = p_job_id for update;
  if not found then
    return query select null::bigint, null::text;
    return;
  end if;
  if v_job.queue_acknowledged then
    -- The stored message id is historical correlation only.  A deleted or
    -- deferred message must never be presented as a live enqueue result.
    return query select null::bigint, v_job.queue_name;
    return;
  end if;
  if v_job.retry_policy = 'deferred' then
    -- Deferred provider responses are operator/policy work.  They never
    -- become an automatic short-backoff queue retry.
    return query select null::bigint, v_job.queue_name;
    return;
  end if;
  if v_job.status in ('succeeded', 'unavailable', 'invalid', 'failed', 'cancelled') then
    if v_job.message_id is not null then
      v_ack := pgmq.delete(v_queue, v_job.message_id);
    else
      v_ack := true;
    end if;
    update ops.jobs
       set queue_acknowledged = true, updated_at = clock_timestamp()
     where id = v_job.id;
    return query select null::bigint, v_queue;
    return;
  end if;
  if v_job.message_id is not null and v_job.queue_name = v_queue
     and v_job.status in ('enqueued', 'leased', 'fetching', 'publishing', 'retryable') then
    return query select v_job.message_id, v_queue;
    return;
  end if;
  select s.message_id into v_message_id
    from pgmq.send(v_queue, jsonb_build_object(
      'job_id', v_job.id::text,
      'protocolVersion', coalesce(v_job.protocol_version, 1)
    )) as s(message_id);
  update ops.jobs
     set status = case when v_job.status = 'retryable' then 'enqueued' else status end,
         queue_name = v_queue, message_id = v_message_id,
         available_at = clock_timestamp(), updated_at = clock_timestamp()
   where id = p_job_id;
  return query select v_message_id, v_queue;
end
$$;

create or replace function ops.claim_job(
  p_lane text,
  p_visibility_seconds integer default 120
)
returns table (
  claimed boolean,
  block_code text,
  retry_at timestamptz,
  job_id uuid,
  message_id bigint,
  job_kind text,
  account_id integer,
  game_id integer,
  provider text,
  provider_subject bigint,
  provider_mode text,
  generation bigint,
  catalog_revision bigint,
  lease_token uuid,
  attempt integer,
  attempt_id uuid,
  attempt_token uuid,
  charged_at timestamptz,
  fetch_started_at timestamptz,
  lease_expires_at timestamptz,
  global_daily_remaining bigint,
  background_daily_remaining bigint,
  global_tokens numeric,
  background_tokens numeric
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_queue text;
  v_message pgmq.message_record;
  v_job ops.jobs%rowtype;
  v_sync app.library_sync_state%rowtype;
  v_charge record;
  v_job_id uuid;
  v_now timestamptz;
  v_lease_token uuid;
  v_attempt_id uuid;
  v_seconds integer;
  v_ack boolean := false;
begin
  if p_lane is null or p_lane not in ('interactive', 'background') then
    return query select false, 'lane_not_allowed', null::timestamptz,
      null::uuid, null::bigint, null::text, null::integer, null::integer,
      null::text, null::bigint, null::text, null::bigint, null::bigint,
      null::uuid, null::integer, null::uuid, null::uuid, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  if p_visibility_seconds is null or p_visibility_seconds < 15 or p_visibility_seconds > 300 then
    return query select false, 'visibility_out_of_range', null::timestamptz,
      null::uuid, null::bigint, null::text, null::integer, null::integer,
      null::text, null::bigint, null::text, null::bigint, null::bigint,
      null::uuid, null::integer, null::uuid, null::uuid, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  v_queue := ops._m2_queue_name(p_lane);
  perform ops._m2_queue_lock(v_queue);
  select m.* into v_message
    from pgmq.read(v_queue, p_visibility_seconds, 1, '{}'::jsonb) as m
   limit 1;
  if not found then
    return query select false, 'no_message', null::timestamptz,
      null::uuid, null::bigint, null::text, null::integer, null::integer,
      null::text, null::bigint, null::text, null::bigint, null::bigint,
      null::uuid, null::integer, null::uuid, null::uuid, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  if v_message.message->>'job_id' is null
     or v_message.message->>'job_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    perform pgmq.delete(v_queue, v_message.msg_id);
    return query select false, 'malformed_message', null::timestamptz,
      null::uuid, v_message.msg_id, null::text, null::integer, null::integer,
      null::text, null::bigint, null::text, null::bigint, null::bigint,
      null::uuid, null::integer, null::uuid, null::uuid, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  v_job_id := (v_message.message->>'job_id')::uuid;
  -- Read the immutable account/lane identity first.  Account-scoped workers
  -- then take the sync-row lock before the job lock, matching request and
  -- publish lock order and preventing refresh/coalesce deadlocks.
  select j.* into v_job from ops.jobs as j where j.id = v_job_id;
  if not found then
    perform pgmq.delete(v_queue, v_message.msg_id);
    return query select false, 'job_not_found', null::timestamptz,
      v_job_id, v_message.msg_id, null::text, null::integer, null::integer,
      null::text, null::bigint, null::text, null::bigint, null::bigint,
      null::uuid, null::integer, null::uuid, null::uuid, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  if v_job.lane <> p_lane or v_job.queue_name <> v_queue then
    perform pgmq.delete(v_queue, v_message.msg_id);
    return query select false, 'lane_mismatch', null::timestamptz,
      v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
      v_job.provider, null::bigint, v_job.provider_mode, v_job.generation,
      v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
      null::uuid, v_job.charged_at, v_job.fetch_started_at,
      v_job.lease_expires_at, null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;
  if v_job.job_kind = 'owned_snapshot' then
    select s.* into v_sync from app.library_sync_state as s
     where s.account_id = v_job.account_id for update;
    if not found then
      insert into app.library_sync_state(account_id) values (v_job.account_id)
        on conflict on constraint library_sync_state_pkey do nothing;
      select s.* into v_sync from app.library_sync_state as s
       where s.account_id = v_job.account_id for update;
    end if;
  end if;
  v_now := clock_timestamp();
  -- Re-read and lock the job after the account lock.  A crash leaves an
  -- expired lease recoverable; changing the lease token fences the old
  -- worker before the replacement attempt is charged.
  select j.* into v_job from ops.jobs as j where j.id = v_job_id for update;
  if not found then
    perform pgmq.delete(v_queue, v_message.msg_id);
    return query select false, 'job_not_found', null::timestamptz,
      v_job_id, v_message.msg_id, null::text, null::integer, null::integer,
      null::text, null::bigint, null::text, null::bigint, null::bigint,
      null::uuid, null::integer, null::uuid, null::uuid, null::timestamptz,
      null::timestamptz, null::timestamptz, null::bigint, null::bigint,
      null::numeric, null::numeric;
    return;
  end if;
  -- The sync row is the generation fence.  A malformed or manually stale
  -- delivery must be terminalized before any provider charge; otherwise a
  -- worker could spend quota for an obsolete account generation.
  v_now := clock_timestamp();
  if v_job.job_kind = 'owned_snapshot'
     and v_job.status in ('queued', 'enqueued', 'retryable', 'leased', 'fetching', 'publishing')
     and (v_sync.in_flight_job_id is distinct from v_job.id
       or v_sync.generation is distinct from v_job.generation) then
    update ops.provider_call_charges as c
       set status = 'expired', completed_at = v_now
     where c.attempt_id = v_job.attempt_id and c.status = 'charged';
    v_ack := pgmq.delete(v_queue, v_message.msg_id);
    update ops.jobs as j
       set status = 'cancelled', retry_policy = 'non_retryable',
           result_code = 'stale_generation',
           result_detail = 'owned job no longer matches the account sync fence',
           lease_token = null, lease_expires_at = null, fetch_started_at = null,
           attempt_id = null, attempt_token = null, charged_at = null,
           completed_at = v_now, retain_until = v_now + interval '30 days',
           queue_acknowledged = v_ack, updated_at = v_now
     where j.id = v_job.id;
    update app.library_sync_state as s
       set in_flight_job_id = null, active_request_key = null,
           last_result = 'error', updated_at = v_now
     where s.account_id = v_job.account_id
       and s.in_flight_job_id = v_job.id;
    return query select false, 'generation_stale', null::timestamptz,
      v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
      v_job.provider, null::bigint, v_job.provider_mode, v_job.generation,
      v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
      null::uuid, null::timestamptz, null::timestamptz, null::timestamptz,
      null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;
  if v_job.status in ('leased', 'fetching', 'publishing') then
    if v_job.lease_expires_at is not null and v_job.lease_expires_at <= v_now then
      update ops.provider_call_charges
         set status = 'expired', completed_at = v_now
       where ops.provider_call_charges.attempt_id = v_job.attempt_id
         and ops.provider_call_charges.status = 'charged';
      update ops.jobs
         set status = 'enqueued', lease_token = null, lease_expires_at = null,
             fetch_started_at = null, attempt_id = null, attempt_token = null,
             charged_at = null, available_at = v_now, queue_acknowledged = false,
             updated_at = v_now
       where id = v_job.id;
      v_job.status := 'enqueued';
      v_job.available_at := v_now;
    else
      perform pgmq.set_vt(v_queue, v_message.msg_id, p_visibility_seconds);
      return query select false, 'job_not_claimable', null::timestamptz,
        v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
        v_job.provider, null::bigint, v_job.provider_mode, v_job.generation,
        v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
        null::uuid, v_job.charged_at, v_job.fetch_started_at,
        v_job.lease_expires_at, null::bigint, null::bigint, null::numeric, null::numeric;
      return;
    end if;
  elsif v_job.status in ('succeeded', 'unavailable', 'invalid', 'failed', 'cancelled') then
    -- This is a stale delivery of a terminal job.  Consume it and persist
    -- the acknowledgement marker so an operator calling enqueue_job cannot
    -- recreate a terminal message after the queue row is gone.
    v_ack := pgmq.delete(v_queue, v_message.msg_id);
    update ops.jobs
       set queue_acknowledged = true, updated_at = v_now
     where id = v_job.id;
    return query select false, 'job_not_claimable', null::timestamptz,
      v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
      v_job.provider, null::bigint, v_job.provider_mode, v_job.generation,
      v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
      null::uuid, v_job.charged_at, v_job.fetch_started_at,
      v_job.lease_expires_at, null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  elsif v_job.status not in ('queued', 'enqueued', 'retryable') then
    perform pgmq.set_vt(v_queue, v_message.msg_id, p_visibility_seconds);
    return query select false, 'job_not_claimable', null::timestamptz,
      v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
      v_job.provider, null::bigint, v_job.provider_mode, v_job.generation,
      v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
      null::uuid, v_job.charged_at, v_job.fetch_started_at,
      v_job.lease_expires_at, null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;
  if v_job.retry_policy = 'deferred' then
    v_ack := pgmq.delete(v_queue, v_message.msg_id);
    update ops.jobs
       set queue_acknowledged = v_ack, updated_at = v_now
     where id = v_job.id;
    -- Deferred work retains its sync fence for explicit operator/policy
    -- handling.  It is acknowledged and never automatically re-enqueued.
    return query select false, 'deferred', v_job.available_at,
      v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
      v_job.provider, null::bigint, v_job.provider_mode, v_job.generation,
      v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
      null::uuid, null::timestamptz, null::timestamptz, v_job.lease_expires_at,
      null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;
  if v_job.available_at > v_now then
    v_seconds := greatest(1, least(2147483647,
      ceil(extract(epoch from (v_job.available_at - v_now)))::integer));
    perform pgmq.set_vt(v_queue, v_message.msg_id, v_seconds);
    return query select false, 'not_due', v_job.available_at,
      v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
      v_job.provider, null::bigint, v_job.provider_mode, v_job.generation,
      v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
      null::uuid, v_job.charged_at, v_job.fetch_started_at,
      v_job.lease_expires_at, null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;
  if v_job.attempt >= v_job.max_attempts then
    update ops.jobs
       set status = 'failed', retry_policy = 'non_retryable',
           result_code = 'max_attempts', result_detail = 'maximum provider attempts reached',
           retain_until = v_now + interval '30 days',
           completed_at = v_now, updated_at = v_now
     where id = v_job.id;
    v_ack := pgmq.delete(v_queue, v_message.msg_id);
    update ops.jobs
       set queue_acknowledged = v_ack, updated_at = v_now
     where id = v_job.id;
    if v_job.job_kind = 'owned_snapshot' then
      update app.library_sync_state
         set in_flight_job_id = null, active_request_key = null,
             last_result = 'error', updated_at = v_now
       where app.library_sync_state.account_id = v_job.account_id;
    end if;
    return query select false, 'max_attempts', null::timestamptz,
      v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
      v_job.provider, null::bigint, v_job.provider_mode, v_job.generation,
      v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
      null::uuid, null::timestamptz, null::timestamptz, null::timestamptz,
      null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;

  -- Store enrichment has its own disabled control and is transported durably,
  -- but is not charged against the keyed Steam Web API budget in M2.
  if v_job.job_kind = 'catalog_enrichment' then
    perform pgmq.set_vt(v_queue, v_message.msg_id, 3600);
    return query select false, 'steam_store_disabled', v_now + interval '1 hour',
      v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
      v_job.provider, null::bigint, 'disabled'::text, v_job.generation,
      v_job.catalog_revision, null::uuid, v_job.attempt::integer, null::uuid,
      null::uuid, null::timestamptz, null::timestamptz, null::timestamptz,
      null::bigint, null::bigint, null::numeric, null::numeric;
    return;
  end if;

  if v_job.job_kind = 'owned_snapshot' and v_sync.account_id is null then
    select s.* into v_sync
      from app.library_sync_state as s
     where s.account_id = v_job.account_id for update;
  end if;

  v_attempt_id := gen_random_uuid();
  select c.* into v_charge
    from ops.consume_provider_attempt(
      'owned_snapshot', v_job.id, null, 1, v_attempt_id, p_visibility_seconds
    ) as c;
  if not coalesce(v_charge.allowed, false) then
    if v_charge.block_code = 'active_profile_required' then
      update ops.jobs
         set status = 'invalid', retry_policy = 'non_retryable',
             result_code = 'profile_unavailable',
             result_detail = 'active linked Steam profile is required',
             retain_until = v_now + interval '30 days',
             queue_acknowledged = true,
             completed_at = v_now, updated_at = v_now
       where id = v_job.id;
      v_ack := pgmq.delete(v_queue, v_message.msg_id);
      update ops.jobs set queue_acknowledged = v_ack, updated_at = v_now
       where id = v_job.id;
      update app.library_sync_state
         set in_flight_job_id = null, active_request_key = null,
             last_result = 'invalid', updated_at = v_now
       where app.library_sync_state.account_id = v_job.account_id;
    else
      v_seconds := greatest(1, least(2147483647,
        ceil(extract(epoch from (coalesce(v_charge.retry_at, v_now + interval '1 minute') - clock_timestamp())))::integer));
      perform pgmq.set_vt(v_queue, v_message.msg_id, v_seconds);
      update ops.jobs
         set status = 'enqueued', available_at = coalesce(v_charge.retry_at, v_now + interval '1 minute'),
             updated_at = clock_timestamp()
       where id = v_job.id;
    end if;
    return query select false, coalesce(v_charge.block_code, 'quota_exhausted'),
      v_charge.retry_at, v_job.id, v_message.msg_id, v_job.job_kind,
      v_job.account_id, v_job.game_id, v_job.provider, v_charge.provider_subject,
      v_charge.provider_mode, v_job.generation, v_job.catalog_revision,
      null::uuid, v_job.attempt::integer, v_attempt_id, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz,
      v_charge.global_daily_remaining, v_charge.background_daily_remaining,
      v_charge.global_tokens, v_charge.background_tokens;
    return;
  end if;

  v_lease_token := gen_random_uuid();
  update ops.jobs
     set status = 'fetching', attempt = v_job.attempt + 1,
         lease_token = v_lease_token, lease_expires_at = v_charge.expires_at,
         fetch_started_at = v_charge.fetch_started_at,
         attempt_id = v_charge.attempt_id, attempt_token = v_charge.attempt_token,
         charged_at = v_charge.fetch_started_at, provider_mode = v_charge.provider_mode,
         message_id = v_message.msg_id, queue_name = v_queue,
         updated_at = clock_timestamp()
   where id = v_job.id;
  update app.library_sync_state
     set last_full_fetch_started_at = v_charge.fetch_started_at,
         updated_at = clock_timestamp()
   where app.library_sync_state.account_id = v_job.account_id;
  return query select true, null::text, null::timestamptz,
    v_job.id, v_message.msg_id, v_job.job_kind, v_job.account_id, v_job.game_id,
    v_job.provider, v_charge.provider_subject, v_charge.provider_mode,
    v_job.generation, v_job.catalog_revision, v_lease_token, v_job.attempt + 1,
    v_charge.attempt_id, v_charge.attempt_token, v_charge.fetch_started_at,
    v_charge.fetch_started_at, v_charge.expires_at,
    v_charge.global_daily_remaining, v_charge.background_daily_remaining,
    v_charge.global_tokens, v_charge.background_tokens;
end
$$;

create or replace function ops.renew_job_lease(
  p_job_id uuid,
  p_lease_token uuid,
  p_visibility_seconds integer
)
returns table (ok boolean, lease_expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job ops.jobs%rowtype;
  v_sync app.library_sync_state%rowtype;
  v_profile record;
  v_charged_subject bigint;
  v_queue text;
  v_now timestamptz;
  v_expires timestamptz;
begin
  if p_visibility_seconds is null or p_visibility_seconds < 15 or p_visibility_seconds > 300 then
    return query select false, null::timestamptz;
    return;
  end if;
  select j.* into v_job from ops.jobs as j where j.id = p_job_id;
  if not found then
    return query select false, null::timestamptz;
    return;
  end if;
  v_queue := ops._m2_queue_name(v_job.lane);
  perform ops._m2_queue_lock(v_queue);
  -- Queue -> sync -> job is the common account-scoped order.  Deferred and
  -- terminal transitions must clear (or deliberately retain) the sync fence
  -- in the same transaction as the job transition.
  if v_job.job_kind = 'owned_snapshot' then
    insert into app.library_sync_state(account_id)
    values (v_job.account_id)
    on conflict on constraint library_sync_state_pkey do nothing;
    select s.* into v_sync
      from app.library_sync_state as s
     where s.account_id = v_job.account_id
     for update;
  end if;
  select j.* into v_job from ops.jobs as j where j.id = p_job_id for update;
  if not found or p_lease_token is null or v_job.lease_token is distinct from p_lease_token
     or v_job.status not in ('fetching', 'publishing') then
    return query select false, case when found then v_job.lease_expires_at else null::timestamptz end;
    return;
  end if;
  v_now := clock_timestamp();
  if v_job.job_kind = 'owned_snapshot' then
    if v_sync.in_flight_job_id is distinct from v_job.id
       or v_sync.generation is distinct from v_job.generation then
      return query select false, v_job.lease_expires_at;
      return;
    end if;
    select ap.* into v_profile
      from ops._m2_authorized_profile(v_job.account_id) as ap;
    if not found then
      return query select false, v_job.lease_expires_at;
      return;
    end if;
    select c.provider_subject into v_charged_subject
      from ops.provider_call_charges as c
     where c.attempt_id = v_job.attempt_id
       and c.attempt_token = v_job.attempt_token
       and c.job_id = v_job.id
       and c.account_id = v_job.account_id
       and c.provider = 'steam'
       and c.endpoint = 'owned_snapshot'
       and c.status = 'charged'
     for update;
    if not found or v_profile.provider_subject is distinct from v_charged_subject then
      return query select false, v_job.lease_expires_at;
      return;
    end if;
  end if;
  if v_job.lease_expires_at <= v_now then
    return query select false, v_job.lease_expires_at;
    return;
  end if;
  v_expires := v_now + p_visibility_seconds * interval '1 second';
  update ops.jobs
     set lease_expires_at = v_expires, updated_at = v_now
   where id = p_job_id and lease_token = p_lease_token;
  update ops.provider_call_charges
     set expires_at = v_expires
   where attempt_id = v_job.attempt_id
     and attempt_token = v_job.attempt_token
     and status = 'charged'
     and expires_at > v_now;
  if v_job.message_id is not null then
    perform pgmq.set_vt(v_queue, v_job.message_id, p_visibility_seconds);
  end if;
  return query select true, v_expires;
end
$$;

create or replace function ops.ack_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_message_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job ops.jobs%rowtype;
  v_queue text;
  v_deleted boolean;
begin
  select j.* into v_job from ops.jobs as j where j.id = p_job_id;
  if not found then
    return false;
  end if;
  v_queue := ops._m2_queue_name(v_job.lane);
  perform ops._m2_queue_lock(v_queue);
  select j.* into v_job from ops.jobs as j where j.id = p_job_id for update;
  if not found or p_lease_token is null
     or (v_job.lease_token is distinct from p_lease_token
       and v_job.completed_lease_token is distinct from p_lease_token) then
    return false;
  end if;
  if p_message_id is not null and v_job.message_id is distinct from p_message_id then
    return false;
  end if;
  if v_job.queue_acknowledged then
    return true;
  end if;
  if v_job.status not in ('succeeded', 'unavailable', 'invalid', 'failed', 'cancelled') then
    return false;
  end if;
  if v_job.message_id is not null then
    v_deleted := pgmq.delete(v_queue, coalesce(p_message_id, v_job.message_id));
    if not coalesce(v_deleted, false) then
      -- A successful publish may have deleted the message before a response
      -- was lost.  The committed terminal marker makes this idempotent.
      if not v_job.queue_acknowledged then
        return false;
      end if;
    end if;
  end if;
  update ops.jobs
     set queue_acknowledged = true, updated_at = clock_timestamp()
   where id = p_job_id;
  return true;
end
$$;

create or replace function ops.retry_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_error_detail text,
  p_provider_retry_at timestamptz default null,
  p_retry_policy text default 'retryable',
  p_message_id bigint default null
)
returns table (status text, retry_at timestamptz, attempt integer, acknowledged boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job ops.jobs%rowtype;
  v_sync app.library_sync_state%rowtype;
  v_profile record;
  v_charged_subject bigint;
  v_queue text;
  v_now timestamptz;
  v_retry_at timestamptz;
  v_base numeric;
  v_delay numeric;
  v_seconds integer;
  v_message_id bigint;
  v_ack boolean := false;
begin
  select j.* into v_job from ops.jobs as j where j.id = p_job_id;
  if not found then
    return query select 'stale'::text, null::timestamptz, null::integer, false;
    return;
  end if;
  v_queue := ops._m2_queue_name(v_job.lane);
  perform ops._m2_queue_lock(v_queue);
  -- Queue -> sync -> job is the common account-scoped order.  A terminal
  -- retry clears the owned sync fence in the same transaction as the job.
  if v_job.job_kind = 'owned_snapshot' then
    insert into app.library_sync_state(account_id)
    values (v_job.account_id)
    on conflict on constraint library_sync_state_pkey do nothing;
    select s.* into v_sync
      from app.library_sync_state as s
     where s.account_id = v_job.account_id
     for update;
  end if;
  select j.* into v_job from ops.jobs as j where j.id = p_job_id for update;
  if not found or p_lease_token is null or v_job.lease_token is distinct from p_lease_token
     or v_job.status not in ('fetching', 'publishing')
     or (p_message_id is not null and v_job.message_id is distinct from p_message_id) then
    return query select 'stale'::text, null::timestamptz,
      case when found then v_job.attempt::integer else null::integer end, false;
    return;
  end if;
  if p_retry_policy is null or p_retry_policy not in ('retryable', 'deferred', 'non_retryable') then
    return query select 'stale'::text, null::timestamptz, v_job.attempt::integer, false;
    return;
  end if;
  v_now := clock_timestamp();
  if v_job.job_kind = 'owned_snapshot' then
    if v_sync.in_flight_job_id is distinct from v_job.id
       or v_sync.generation is distinct from v_job.generation then
      return query select 'stale'::text, null::timestamptz, v_job.attempt::integer, false;
      return;
    end if;
    select ap.* into v_profile
      from ops._m2_authorized_profile(v_job.account_id) as ap;
    if not found then
      return query select 'stale'::text, null::timestamptz, v_job.attempt::integer, false;
      return;
    end if;
    select c.provider_subject into v_charged_subject
      from ops.provider_call_charges as c
     where c.attempt_id = v_job.attempt_id
       and c.attempt_token = v_job.attempt_token
       and c.job_id = v_job.id
       and c.account_id = v_job.account_id
       and c.provider = 'steam'
       and c.endpoint = 'owned_snapshot'
       and c.status = 'charged'
     for update;
    if not found or v_profile.provider_subject is distinct from v_charged_subject then
      return query select 'stale'::text, null::timestamptz, v_job.attempt::integer, false;
      return;
    end if;
  end if;
  if v_job.lease_expires_at is null or v_job.lease_expires_at <= v_now then
    return query select 'stale'::text, null::timestamptz, v_job.attempt::integer, false;
    return;
  end if;
  -- PGMQ visibility is an integer number of seconds.  A valid provider
  -- minimum beyond that scheduler horizon becomes an explicit deferred
  -- outcome so it is preserved rather than overflowing or being shortened.
  if p_retry_policy = 'retryable'
     and p_provider_retry_at is not null
     and p_provider_retry_at > v_now + 2147483647 * interval '1 second' then
    p_retry_policy := 'deferred';
  end if;
  v_message_id := coalesce(p_message_id, v_job.message_id);
  if p_retry_policy = 'non_retryable' or v_job.attempt >= v_job.max_attempts then
    update ops.provider_call_charges
       set status = 'expired', completed_at = v_now
     where ops.provider_call_charges.attempt_id = v_job.attempt_id
       and ops.provider_call_charges.attempt_token = v_job.attempt_token
       and ops.provider_call_charges.status = 'charged';
    if v_message_id is not null then
      v_ack := pgmq.delete(v_queue, v_message_id);
    else
      v_ack := true;
    end if;
    update ops.jobs
       set status = 'failed', retry_policy = 'non_retryable',
           result_code = left(coalesce(nullif(btrim(p_error_code), ''), 'provider_failure'), 120),
           result_detail = left(coalesce(p_error_detail, ''), 2000),
           queue_acknowledged = v_ack, lease_token = null, lease_expires_at = null,
           fetch_started_at = null, attempt_id = null, attempt_token = null,
           charged_at = null, completed_lease_token = p_lease_token,
           retain_until = v_now + interval '30 days',
           completed_at = v_now, updated_at = v_now
     where id = p_job_id;
    if v_job.job_kind = 'owned_snapshot' then
      update app.library_sync_state as s
         set in_flight_job_id = null, active_request_key = null,
             last_result = 'error', updated_at = v_now
       where s.account_id = v_job.account_id
         and s.in_flight_job_id = v_job.id;
    end if;
    return query select 'non_retryable'::text, null::timestamptz, v_job.attempt::integer, v_ack;
    return;
  end if;

  if p_retry_policy = 'deferred' then
    v_retry_at := greatest(coalesce(p_provider_retry_at, v_now), v_now);
    if v_message_id is not null then
      v_ack := pgmq.delete(v_queue, v_message_id);
      if not v_ack then
        raise exception using errcode = 'serialization_failure', message = 'matching queue message was not found';
      end if;
    else
      v_ack := true;
    end if;
    update ops.provider_call_charges
       set status = 'expired', completed_at = v_now
     where ops.provider_call_charges.attempt_id = v_job.attempt_id
       and ops.provider_call_charges.attempt_token = v_job.attempt_token
       and ops.provider_call_charges.status = 'charged';
    update ops.jobs
       set status = 'retryable', retry_policy = 'deferred',
           provider_retry_at = p_provider_retry_at, available_at = v_retry_at,
           result_code = left(coalesce(nullif(btrim(p_error_code), ''), 'provider_deferred'), 120),
           result_detail = left(coalesce(p_error_detail, ''), 2000),
           queue_acknowledged = v_ack, lease_token = null, lease_expires_at = null,
           fetch_started_at = null, attempt_id = null, attempt_token = null,
           charged_at = null, retain_until = v_now + interval '30 days',
           updated_at = v_now
     where id = p_job_id;
    return query select 'deferred'::text, v_retry_at, v_job.attempt::integer, v_ack;
    return;
  end if;

  v_base := least(300::numeric, power(2::numeric, greatest(0, v_job.attempt - 1)));
  v_delay := v_base + random() * least(30::numeric, v_base * 0.25);
  v_retry_at := greatest(
    v_now + v_delay * interval '1 second',
    coalesce(p_provider_retry_at, v_now)
  );
  v_seconds := greatest(1, least(2147483647,
    ceil(extract(epoch from (v_retry_at - clock_timestamp())))::integer));
  if v_message_id is not null then
    perform pgmq.set_vt(v_queue, v_message_id, v_seconds);
  end if;
  update ops.provider_call_charges
     set status = 'expired', completed_at = v_now
   where ops.provider_call_charges.attempt_id = v_job.attempt_id
     and ops.provider_call_charges.attempt_token = v_job.attempt_token
     and ops.provider_call_charges.status = 'charged';
  update ops.jobs
     set status = 'retryable', retry_policy = p_retry_policy,
         provider_retry_at = p_provider_retry_at, available_at = v_retry_at,
         result_code = left(coalesce(nullif(btrim(p_error_code), ''), 'provider_failure'), 120),
         result_detail = left(coalesce(p_error_detail, ''), 2000),
         lease_token = null, lease_expires_at = null, fetch_started_at = null,
         attempt_id = null, attempt_token = null, charged_at = null,
         updated_at = v_now
   where id = p_job_id;
  return query select 'retryable'::text, v_retry_at, v_job.attempt::integer, false;
end
$$;

create or replace function ops.enqueue_enrichment(
  p_provider text,
  p_game_id integer,
  p_catalog_revision bigint,
  p_kind text
)
returns table (outbox_id bigint, coalesced boolean)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_id bigint;
  v_count integer;
begin
  if p_provider is distinct from 'steam_store' or p_game_id is null
     or p_catalog_revision is null or p_catalog_revision < 0
     or p_kind is null or length(btrim(p_kind)) not between 1 and 80 then
    return query select null::bigint, false;
    return;
  end if;
  if not exists (select 1 from catalog.games where id = p_game_id) then
    return query select null::bigint, false;
    return;
  end if;
  insert into ops.enrichment_outbox(provider, game_id, catalog_revision, kind)
  values (p_provider, p_game_id, p_catalog_revision, btrim(p_kind))
  on conflict (provider, game_id, catalog_revision, kind) do nothing
  returning id into v_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then
    select o.id into v_id
      from ops.enrichment_outbox as o
     where o.provider = p_provider and o.game_id = p_game_id
       and o.catalog_revision = p_catalog_revision and o.kind = btrim(p_kind);
  end if;
  return query select v_id, v_count = 0;
end
$$;

create or replace function app.begin_pinned_owned_refresh(p_game_id integer)
returns table (
  allowed boolean,
  block_code text,
  attempt_id uuid,
  attempt_token uuid,
  provider_subject bigint,
  provider_mode text,
  fetch_started_at timestamptz,
  expires_at timestamptz,
  retry_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_account_id integer := app.current_account_id();
  v_charge record;
begin
  if v_account_id is null then
    return query select false, 'account_required', null::uuid, null::uuid,
      null::bigint, null::text, null::timestamptz, null::timestamptz,
      null::timestamptz;
    return;
  end if;
  if p_game_id is null then
    return query select false, 'game_required', null::uuid, null::uuid,
      null::bigint, null::text, null::timestamptz, null::timestamptz,
      null::timestamptz;
    return;
  end if;
  select c.* into v_charge
    from ops.consume_provider_attempt('pinned', null, p_game_id, 1, null, 120) as c;
  if not found then
    return query select false, 'attempt_unavailable', null::uuid, null::uuid,
      null::bigint, null::text, null::timestamptz, null::timestamptz,
      null::timestamptz;
    return;
  end if;
  return query select v_charge.allowed, v_charge.block_code, v_charge.attempt_id,
    v_charge.attempt_token, v_charge.provider_subject, v_charge.provider_mode,
    v_charge.fetch_started_at, v_charge.expires_at, v_charge.retry_at;
end
$$;

create or replace function app.record_pinned_owned_observation(
  p_attempt_id uuid,
  p_attempt_token uuid,
  p_result jsonb
)
returns table (
  accepted boolean,
  game_id integer,
  observed_at timestamptz,
  minutes integer,
  current_library boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_account_id integer := app.current_account_id();
  v_charge ops.provider_call_charges%rowtype;
  v_sync app.library_sync_state%rowtype;
  v_game_id integer;
  v_expected_app bigint;
  v_app_id bigint;
  v_minutes integer;
  v_last_played timestamptz;
  v_epoch bigint;
  v_last_source text;
  v_now timestamptz;
  v_current integer;
  v_retired integer;
  v_effective integer;
  v_have_current boolean := false;
  v_have_retired boolean := false;
  v_library_changed boolean := false;
  v_activity_changed boolean := false;
  v_old_activity app.game_activity%rowtype;
  v_have_old_activity boolean := false;
  v_profile record;
  v_effective_played timestamptz;
  v_effective_source text;
begin
  if v_account_id is null or p_attempt_id is null or p_attempt_token is null
     or p_result is null or jsonb_typeof(p_result) <> 'object'
     or pg_column_size(p_result) > 32768 then
    return query select false, null::integer, null::timestamptz, null::integer, false;
    return;
  end if;
  select c.* into v_charge
    from ops.provider_call_charges as c
   where c.attempt_id = p_attempt_id
     and c.attempt_token = p_attempt_token
     and c.account_id = v_account_id
     and c.endpoint = 'pinned'
   ;
  if not found then
    return query select false, null::integer, null::timestamptz, null::integer, false;
    return;
  end if;
  v_game_id := v_charge.scope_game_id;
  select s.* into v_sync
    from app.library_sync_state as s
   where s.account_id = v_account_id
   for update;
  if not found then
    insert into app.library_sync_state(account_id) values (v_account_id)
      on conflict on constraint library_sync_state_pkey do nothing;
    select s.* into v_sync from app.library_sync_state as s
     where s.account_id = v_account_id for update;
  end if;
  -- Re-lock the charge after the account fence.  A profile deletion or a
  -- competing full snapshot cannot slip between authorization and apply.
  select c.* into v_charge
    from ops.provider_call_charges as c
   where c.attempt_id = p_attempt_id
     and c.attempt_token = p_attempt_token
     and c.account_id = v_account_id
     and c.endpoint = 'pinned'
   for update;
  if not found then
    return query select false, v_game_id, clock_timestamp(), null::integer, false;
    return;
  end if;
  v_now := clock_timestamp();
  if v_charge.status <> 'charged' or v_charge.expires_at <= v_now then
    update ops.provider_call_charges
       set status = 'expired', completed_at = v_now
     where attempt_id = p_attempt_id and status = 'charged';
    return query select false, v_game_id, v_now, null::integer, false;
    return;
  end if;
  select ap.* into v_profile from ops._m2_authorized_profile(v_account_id) as ap;
  if not found or v_profile.provider_subject is distinct from v_charge.provider_subject then
    insert into app.library_observation_anomalies(
      account_id, game_id, attempt_id, reason, observed_at, source, detail
    ) values (
      v_account_id, v_game_id, p_attempt_id, 'invalid_pinned_result', v_now,
      'pinned_owned', 'profile authorization changed while the attempt was in flight'
    );
    update ops.provider_call_charges
       set status = 'rejected', completed_at = v_now
     where attempt_id = p_attempt_id;
    return query select false, v_game_id, v_now, null::integer, false;
    return;
  end if;
  if not exists (
    select 1 from app.pins as pin
     where pin.account_id = v_account_id
       and pin.game_id = v_game_id
       and pin.scope in ('library', 'all')
  ) then
    insert into app.library_observation_anomalies(
      account_id, game_id, attempt_id, reason, observed_at, source, detail
    ) values (
      v_account_id, v_game_id, p_attempt_id, 'invalid_pinned_result', v_now,
      'pinned_owned', 'pin scope was revoked while the attempt was in flight'
    );
    update ops.provider_call_charges
       set status = 'rejected', completed_at = v_now
     where attempt_id = p_attempt_id;
    return query select false, v_game_id, v_now, null::integer, false;
    return;
  end if;
  if v_sync.last_full_fetch_started_at is not null
     and v_sync.last_full_fetch_started_at > v_charge.fetch_started_at then
    insert into app.library_observation_anomalies(
      account_id, game_id, attempt_id, reason, observed_at, source, detail
    ) values (
      v_account_id, v_game_id, p_attempt_id, 'pinned_superseded', v_now,
      'pinned_owned', 'a newer full-authority fetch has started'
    );
    update ops.provider_call_charges
       set status = 'rejected', completed_at = v_now
     where attempt_id = p_attempt_id;
    return query select false, v_game_id, v_now, null::integer, false;
    return;
  end if;

  if p_result->>'status' is distinct from 'complete'
     or p_result->>'provider' is distinct from 'steam'
     or p_result->>'appId' is null
     or p_result->>'appId' !~ '^[1-9][0-9]*$'
     or not pg_input_is_valid(p_result->>'appId', 'bigint') then
    insert into app.library_observation_anomalies(
      account_id, game_id, attempt_id, reason, observed_at, source, detail
    ) values (
      v_account_id, v_game_id, p_attempt_id, 'invalid_pinned_result', v_now,
      'pinned_owned', 'result must be complete and contain the authorized AppID'
    );
    update ops.provider_call_charges
       set status = 'rejected', completed_at = v_now
     where attempt_id = p_attempt_id;
    return query select false, v_game_id, v_now, null::integer, false;
    return;
  end if;
  v_app_id := (p_result->>'appId')::bigint;
  if v_app_id < 1 or v_app_id > 4294967295 then
    insert into app.library_observation_anomalies(
      account_id, game_id, attempt_id, reason, observed_at, source, detail
    ) values (
      v_account_id, v_game_id, p_attempt_id, 'invalid_pinned_result', v_now,
      'pinned_owned', 'AppID is outside uint32'
    );
    update ops.provider_call_charges
       set status = 'rejected', completed_at = v_now
     where attempt_id = p_attempt_id;
    return query select false, v_game_id, v_now, null::integer, false;
    return;
  end if;
  select g.steam_app_id into v_expected_app
    from catalog.games as g where g.id = v_game_id;
  if v_expected_app is null or v_app_id <> v_expected_app then
    insert into app.library_observation_anomalies(
      account_id, game_id, attempt_id, reason, observed_at, source, detail
    ) values (
      v_account_id, v_game_id, p_attempt_id, 'invalid_pinned_result', v_now,
      'pinned_owned', 'AppID does not match the charged pin scope'
    );
    update ops.provider_call_charges
       set status = 'rejected', completed_at = v_now
     where attempt_id = p_attempt_id;
    return query select false, v_game_id, v_now, null::integer, false;
    return;
  end if;
  if p_result ? 'playtimeMinutes' then
    if p_result->>'playtimeMinutes' is null then
      v_minutes := null;
    elsif p_result->>'playtimeMinutes' !~ '^(0|[1-9][0-9]*)$'
       or not pg_input_is_valid(p_result->>'playtimeMinutes', 'integer') then
      v_minutes := null;
      insert into app.library_observation_anomalies(
        account_id, game_id, attempt_id, reason, observed_at, source, detail
      ) values (
        v_account_id, v_game_id, p_attempt_id, 'invalid_pinned_result', v_now,
        'pinned_owned', 'playtimeMinutes is outside the nonnegative integer range'
      );
      update ops.provider_call_charges set status = 'rejected', completed_at = v_now
       where attempt_id = p_attempt_id;
      return query select false, v_game_id, v_now, null::integer, false;
      return;
    else
      v_minutes := (p_result->>'playtimeMinutes')::integer;
    end if;
  end if;
  if p_result ? 'lastPlayedAtEpochSeconds' and p_result->>'lastPlayedAtEpochSeconds' is not null then
    if p_result->>'lastPlayedAtEpochSeconds' !~ '^[1-9][0-9]*$'
       or not pg_input_is_valid(p_result->>'lastPlayedAtEpochSeconds', 'bigint') then
      update ops.provider_call_charges set status = 'rejected', completed_at = v_now
       where attempt_id = p_attempt_id;
      return query select false, v_game_id, v_now, null::integer, false;
      return;
    end if;
    v_epoch := (p_result->>'lastPlayedAtEpochSeconds')::bigint;
    if v_epoch > 9223372036854 then
      update ops.provider_call_charges set status = 'rejected', completed_at = v_now
       where attempt_id = p_attempt_id;
      return query select false, v_game_id, v_now, null::integer, false;
      return;
    end if;
    v_last_played := to_timestamp(v_epoch::double precision);
    if v_last_played > v_now + interval '5 minutes' then
      update ops.provider_call_charges set status = 'rejected', completed_at = v_now
       where attempt_id = p_attempt_id;
      return query select false, v_game_id, v_now, null::integer, false;
      return;
    end if;
  end if;
  v_last_source := coalesce(p_result->>'lastPlayedSource',
    case when v_last_played is null then 'not_provided' else 'steam.rtime_last_played' end);
  if v_last_source is null
     or v_last_source not in ('steam.rtime_last_played', 'steam.rtime_last_played_unknown', 'not_provided')
     or (v_last_played is null and v_last_source = 'steam.rtime_last_played')
     or (v_last_played is not null and v_last_source <> 'steam.rtime_last_played') then
    update ops.provider_call_charges set status = 'rejected', completed_at = v_now
     where attempt_id = p_attempt_id;
    return query select false, v_game_id, v_now, null::integer, false;
    return;
  end if;

  select lg.playtime_minutes into v_current
    from app.library_games as lg
   where lg.account_id = v_account_id and lg.game_id = v_game_id;
  v_have_current := found;
  select rg.last_personal_minutes into v_retired
    from app.retired_library_games as rg
   where rg.account_id = v_account_id and rg.game_id = v_game_id;
  v_have_retired := found;
  select a.* into v_old_activity
    from app.game_activity as a
   where a.account_id = v_account_id and a.game_id = v_game_id
   for update;
  v_have_old_activity := found;
  v_effective := v_minutes;
  if v_current is not null then v_effective := greatest(coalesce(v_effective, v_current), v_current); end if;
  if v_retired is not null then v_effective := greatest(coalesce(v_effective, v_retired), v_retired); end if;
  if v_old_activity.last_observed_minutes is not null then
    v_effective := greatest(coalesce(v_effective, v_old_activity.last_observed_minutes),
      v_old_activity.last_observed_minutes);
  end if;
  if not v_have_current then
    insert into app.library_games(account_id, game_id, playtime_minutes)
    values (v_account_id, v_game_id, v_effective);
    v_library_changed := true;
  elsif v_current is distinct from v_effective then
    update app.library_games set playtime_minutes = v_effective
     where app.library_games.account_id = v_account_id
       and app.library_games.game_id = v_game_id;
    v_library_changed := true;
  end if;
  if v_have_retired then
    delete from app.retired_library_games
     where app.retired_library_games.account_id = v_account_id
       and app.retired_library_games.game_id = v_game_id;
  end if;
  if v_minutes is not null and v_current is not null and v_minutes < v_current then
    insert into app.library_observation_anomalies(
      account_id, game_id, attempt_id, reason, prior_minutes, incoming_minutes,
      observed_at, source, detail
    ) values (v_account_id, v_game_id, p_attempt_id, 'provider_decrease',
      v_current, v_minutes, v_now, 'pinned_owned', 'greatest known minutes retained');
  end if;

  -- A valid AppID is itself a sparse confirmation, including null/null
  -- measurements.  This row is the fence consulted by a later full sweep.
  insert into app.library_observation_fences(
    account_id, game_id, observation_scope, last_confirmed_at, attempt_id
  ) values (v_account_id, v_game_id, 'pinned_owned', v_now, p_attempt_id)
  on conflict on constraint library_observation_fences_pkey do update
    set observation_scope = excluded.observation_scope,
        last_confirmed_at = excluded.last_confirmed_at,
        attempt_id = excluded.attempt_id;
  if v_have_old_activity then
    v_effective_played := v_old_activity.last_played_at;
    if v_last_played is not null then
      v_effective_played := greatest(coalesce(v_effective_played, v_last_played), v_last_played);
    end if;
    v_effective_source := case
      when v_effective_played is not distinct from v_old_activity.last_played_at
        then v_old_activity.last_played_source
      else v_last_source
    end;
    v_activity_changed := v_old_activity.last_observed_minutes is distinct from v_effective
      or v_old_activity.last_played_at is distinct from v_effective_played;
     update app.game_activity
       set last_observed_minutes = coalesce(v_effective, last_observed_minutes),
           last_played_at = v_effective_played,
           observed_at = v_now, evidence_source = 'steam_api',
           observation_scope = 'pinned_owned', last_played_source = v_effective_source
     where app.game_activity.account_id = v_account_id
       and app.game_activity.game_id = v_game_id;
  elsif v_effective is not null or v_last_played is not null then
    insert into app.game_activity(
      account_id, game_id, last_observed_minutes, last_played_at, observed_at,
      evidence_source, observation_scope, last_played_source
    ) values (
      v_account_id, v_game_id, v_effective, v_last_played, v_now,
      'steam_api', 'pinned_owned', v_last_source
    );
    v_activity_changed := true;
  end if;
  if v_library_changed or v_activity_changed then
    update app.accounts set library_revision = library_revision + 1,
      last_seen_at = v_now where id = v_account_id;
  end if;
  update ops.provider_call_charges
     set status = 'applied', completed_at = v_now
   where attempt_id = p_attempt_id;
  return query select true, v_game_id, v_now, v_effective, true;
end
$$;

create or replace function ops.publish_owned_snapshot(
  p_job_id uuid,
  p_lease_token uuid,
  p_result jsonb,
  p_canonical_json text default null,
  p_content_hash bytea default null,
  p_body_observed_at timestamptz default null,
  p_message_id bigint default null
)
returns table (
  result text,
  job_id uuid,
  account_id integer,
  generation bigint,
  applied_generation bigint,
  snapshot_hash bytea,
  observed_count integer,
  library_changed integer,
  activity_changed integer,
  retired_count integer,
  sweep_deferred_count integer,
  enrichment_enqueued integer,
  acknowledged boolean
)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_job ops.jobs%rowtype;
  v_sync app.library_sync_state%rowtype;
  v_profile record;
  v_now timestamptz;
  v_result_status text;
  v_result_code text;
  v_game jsonb;
  v_doc jsonb;
  v_game_count integer;
  v_count integer := 0;
  v_app_text text;
  v_minutes_text text;
  v_epoch_text text;
  v_name text;
  v_name_source text;
  v_last_source text;
  v_app bigint;
  v_minutes integer;
  v_epoch bigint;
  v_last_played timestamptz;
  v_body_bytes integer;
  v_ack boolean := false;
  v_message_id bigint;
  v_queue text;
  v_library_changed integer := 0;
  v_activity_changed integer := 0;
  v_retired_count integer := 0;
  v_deferred_count integer := 0;
  v_enrichment_count integer := 0;
  v_state_changed boolean := false;
  v_fact_changed boolean := false;
  v_old_minutes integer;
  v_retired_minutes integer;
  v_have_retired boolean;
  v_effective_minutes integer;
  v_old_activity app.game_activity%rowtype;
  v_have_activity boolean;
  v_activity_row_changed boolean;
  v_effective_played timestamptz;
  v_effective_source text;
  v_old_game_id integer;
  v_old_state_revision bigint;
  v_title_source text;
  v_charged_subject bigint;
  v_last_observed_at timestamptz;
  v_has_playtime_evidence boolean := false;
  v_has_last_played_evidence boolean := false;
begin
  -- Account-scoped functions all serialize in account/sync/job order.  Read
  -- the job identity first, take the sync row, then lock and re-read the job
  -- so a request/claim/publish race cannot deadlock or use stale generation.
  select j.* into v_job from ops.jobs as j where j.id = p_job_id;
  if not found then
    return query select 'not_found'::text, p_job_id, null::integer, null::bigint,
      null::bigint, null::bytea, null::integer, 0, 0, 0, 0, 0, false;
    return;
  end if;
  if v_job.job_kind <> 'owned_snapshot' or v_job.account_id is null then
    return query select 'stale'::text, v_job.id, v_job.account_id, v_job.generation,
      v_job.applied_generation, v_job.result_hash, v_job.observed_count,
      v_job.library_changed_count, v_job.activity_changed_count, v_job.retired_count,
      v_job.sweep_deferred_count, v_job.enrichment_enqueued_count, false;
    return;
  end if;
  v_queue := ops._m2_queue_name(v_job.lane);
  perform ops._m2_queue_lock(v_queue);
  insert into app.library_sync_state(account_id)
  values (v_job.account_id)
  on conflict on constraint library_sync_state_pkey do nothing;
  select s.* into v_sync
    from app.library_sync_state as s
   where s.account_id = v_job.account_id
   for update;
  select j.* into v_job from ops.jobs as j where j.id = p_job_id for update;
  if not found then
    return query select 'not_found'::text, p_job_id, null::integer, null::bigint,
      null::bigint, null::bytea, null::integer, 0, 0, 0, 0, 0, false;
    return;
  end if;
  v_now := clock_timestamp();
  v_result_status := case when p_result is null then null else p_result->>'status' end;
  -- Keep terminal response-loss replay account-bound as well as lease-bound.
  -- The latest attempt ledger row retains the Steam subject after the job's
  -- active attempt fields are cleared; a deleted, merged, or replaced profile
  -- therefore cannot read or replay the old private outcome.
  select ap.* into v_profile
    from ops._m2_authorized_profile(v_job.account_id) as ap;
  if not found then
    return query select 'stale'::text, v_job.id, v_job.account_id, v_job.generation,
      v_job.applied_generation, v_job.result_hash, v_job.observed_count,
      v_job.library_changed_count, v_job.activity_changed_count, v_job.retired_count,
      v_job.sweep_deferred_count, v_job.enrichment_enqueued_count, false;
    return;
  end if;
  select c.provider_subject into v_charged_subject
    from ops.provider_call_charges as c
   where c.job_id = v_job.id
     and c.provider = 'steam'
     and c.endpoint = 'owned_snapshot'
   order by c.charged_at desc
   limit 1
   for update;
  if v_charged_subject is null
     or v_profile.provider_subject is distinct from v_charged_subject then
    return query select 'stale'::text, v_job.id, v_job.account_id, v_job.generation,
      v_job.applied_generation, v_job.result_hash, v_job.observed_count,
      v_job.library_changed_count, v_job.activity_changed_count, v_job.retired_count,
      v_job.sweep_deferred_count, v_job.enrichment_enqueued_count, false;
    return;
  end if;
  if v_job.status in ('succeeded', 'unavailable', 'invalid', 'failed', 'cancelled') then
    if p_lease_token is distinct from v_job.completed_lease_token
       or (p_message_id is not null and v_job.message_id is distinct from p_message_id) then
      return query select 'stale'::text, v_job.id, v_job.account_id, v_job.generation,
        v_job.applied_generation, v_job.result_hash, v_job.observed_count,
        v_job.library_changed_count, v_job.activity_changed_count, v_job.retired_count,
        v_job.sweep_deferred_count, v_job.enrichment_enqueued_count, false;
      return;
    end if;
    if p_result is null or jsonb_typeof(p_result) <> 'object'
       or p_result->>'provider' is distinct from 'steam' then
      raise exception using errcode = 'invalid_parameter_value', message = 'terminal replay result is invalid';
    end if;
    if (v_job.status = 'succeeded' and v_result_status is distinct from 'complete')
       or (v_job.status = 'unavailable' and v_result_status is distinct from 'unavailable')
       or (v_job.status = 'invalid' and v_result_status is distinct from 'invalid')
       or (v_job.status = 'failed' and v_result_status is distinct from 'failure') then
      raise exception using errcode = 'serialization_failure', message = 'terminal replay status does not match';
    end if;
    if v_result_status = 'complete' and p_content_hash is distinct from v_job.result_hash then
      raise exception using errcode = 'serialization_failure', message = 'terminal replay has a different result hash';
    end if;
    if v_result_status = 'complete'
       and p_result->>'gameCount' is distinct from v_job.observed_count::text then
      raise exception using errcode = 'serialization_failure', message = 'terminal replay has a different game count';
    end if;
    if v_result_status <> 'complete' and p_content_hash is not null then
      raise exception using errcode = 'serialization_failure', message = 'terminal replay unexpectedly carries a hash';
    end if;
    if v_job.result_code is distinct from (
       case when v_result_status = 'complete' then 'complete'
            else left(coalesce(nullif(btrim(p_result->>'reason'), ''), v_result_status), 120) end
    ) then
      raise exception using errcode = 'serialization_failure', message = 'terminal replay reason does not match';
    end if;
    return query select 'already_applied'::text, v_job.id, v_job.account_id,
      v_job.generation, v_job.applied_generation, v_job.result_hash,
      v_job.observed_count, v_job.library_changed_count, v_job.activity_changed_count,
      v_job.retired_count, v_job.sweep_deferred_count, v_job.enrichment_enqueued_count,
      v_job.queue_acknowledged;
    return;
  end if;
  if p_lease_token is null or v_job.lease_token is distinct from p_lease_token
     or v_job.status not in ('fetching', 'publishing')
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= v_now then
    return query select 'stale'::text, v_job.id, v_job.account_id, v_job.generation,
      null::bigint, v_job.result_hash, v_job.observed_count, 0, 0, 0, 0, 0, false;
    return;
  end if;
  if p_message_id is not null and v_job.message_id is distinct from p_message_id then
    return query select 'stale'::text, v_job.id, v_job.account_id, v_job.generation,
      null::bigint, v_job.result_hash, v_job.observed_count, 0, 0, 0, 0, 0, false;
    return;
  end if;
  -- The active lease must still be backed by the exact charged attempt and
  -- the same stored Steam subject.  A profile replacement cannot publish the
  -- response that was fetched for the old identity.
  select c.provider_subject into v_charged_subject
    from ops.provider_call_charges as c
   where c.attempt_id = v_job.attempt_id
     and c.attempt_token = v_job.attempt_token
     and c.job_id = v_job.id
     and c.account_id = v_job.account_id
     and c.provider = 'steam'
     and c.endpoint = 'owned_snapshot'
     and c.status = 'charged'
   for update;
  if not found or v_charged_subject is null
     or v_profile.provider_subject is distinct from v_charged_subject then
    -- Account deletion/profile revocation/identity replacement wins over a
    -- worker response.
    return query select 'stale'::text, v_job.id, v_job.account_id, v_job.generation,
      null::bigint, v_job.result_hash, v_job.observed_count, 0, 0, 0, 0, 0, false;
    return;
  end if;
  if v_sync.in_flight_job_id is distinct from v_job.id
     or v_sync.generation is distinct from v_job.generation then
    return query select 'stale'::text, v_job.id, v_job.account_id, v_job.generation,
      v_sync.applied_generation, v_job.result_hash, v_job.observed_count,
      v_job.library_changed_count, v_job.activity_changed_count, v_job.retired_count,
      v_job.sweep_deferred_count, v_job.enrichment_enqueued_count, false;
    return;
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 32768 then
    raise exception using errcode = 'invalid_parameter_value', message = 'bounded publish result is invalid';
  end if;
  if p_result->>'provider' is distinct from 'steam'
     or v_result_status is null
     or v_result_status not in ('complete', 'unavailable', 'invalid', 'failure') then
    raise exception using errcode = 'invalid_parameter_value', message = 'publish result status/provider is invalid';
  end if;
  if v_result_status <> 'complete' then
    if p_canonical_json is not null or p_content_hash is not null or p_body_observed_at is not null then
      raise exception using errcode = 'invalid_parameter_value', message = 'non-complete publish cannot carry canonical fields';
    end if;
    v_result_code := left(coalesce(nullif(btrim(p_result->>'reason'), ''), v_result_status), 120);
    v_message_id := coalesce(p_message_id, v_job.message_id);
    if v_message_id is not null then
      v_ack := pgmq.delete(v_job.queue_name, v_message_id);
      if not v_ack then
        raise exception using errcode = 'serialization_failure', message = 'matching queue message was not found';
      end if;
    else
      v_ack := true;
    end if;
    update ops.provider_call_charges
       set status = 'applied', completed_at = v_now
     where attempt_id = v_job.attempt_id and attempt_token = v_job.attempt_token
       and status = 'charged';
    update app.library_sync_state
       set last_result = case when v_result_status = 'invalid' then 'invalid' else 'error' end,
           updated_at = v_now, in_flight_job_id = null, active_request_key = null
     where app.library_sync_state.account_id = v_job.account_id;
    insert into app.account_capabilities as ac(
      account_id, library_visibility, playtime_visibility,
      last_played_visibility, status, checked_at
    )
    values (
      v_job.account_id,
      case when v_result_status = 'unavailable' and p_result->>'reason' = 'private'
        then 'hidden' else 'unknown' end,
      'unknown',
      'unknown',
      case when v_result_status = 'unavailable' and p_result->>'reason' = 'private'
        then 'private' else 'error' end,
      v_now
    )
  on conflict on constraint account_capabilities_pkey do update
    set library_visibility = case
          when v_result_status = 'unavailable' and p_result->>'reason' = 'private'
            then excluded.library_visibility
          else ac.library_visibility
        end,
        playtime_visibility = case
          when v_result_status = 'unavailable' and p_result->>'reason' = 'private'
            then excluded.playtime_visibility
          else ac.playtime_visibility
        end,
        last_played_visibility = case
          when v_result_status = 'unavailable' and p_result->>'reason' = 'private'
            then excluded.last_played_visibility
          else ac.last_played_visibility
        end,
        status = excluded.status, checked_at = excluded.checked_at;
    update ops.jobs
       set status = case when v_result_status = 'invalid' then 'invalid'
                         when v_result_status = 'unavailable' then 'unavailable'
                         else 'failed' end,
           retry_policy = 'non_retryable', result_code = v_result_code,
           result_detail = left(coalesce(p_result->>'detail', ''), 2000),
           queue_acknowledged = v_ack, completed_at = v_now, updated_at = v_now,
           retain_until = v_now + interval '30 days',
           applied_generation = v_sync.applied_generation,
           applied_library_revision = (select a.library_revision from app.accounts as a where a.id = v_job.account_id),
           applied_state_revision = (select a.state_revision from app.accounts as a where a.id = v_job.account_id),
           completed_lease_token = p_lease_token,
           lease_token = null, lease_expires_at = null, fetch_started_at = null,
           attempt_id = null, attempt_token = null, charged_at = null
     where id = v_job.id;
    return query select 'applied'::text,
      v_job.id, v_job.account_id, v_job.generation, v_sync.applied_generation,
      null::bytea, null::integer, 0, 0, 0, 0, 0, v_ack;
    return;
  end if;

  if p_canonical_json is null or octet_length(convert_to(p_canonical_json, 'UTF8')) > 8388608
     or p_content_hash is null or octet_length(p_content_hash) <> 32
     or p_body_observed_at is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'complete publish canonical fields are missing or too large';
  end if;
  if p_result ? 'games' then
    raise exception using errcode = 'invalid_parameter_value', message = 'publish metadata must not contain a game array';
  end if;
  if (select count(*) from jsonb_object_keys(p_result)) <> 10
     or exists (
       select 1 from jsonb_object_keys(p_result) as k(key_name)
        where key_name not in (
          'status', 'provider', 'protocolVersion', 'gameCount', 'scope',
          'includeAppInfo', 'includePlayedFreeGames', 'skipUnvettedApps',
          'httpStatus', 'bodyBytes'
        )
     )
     or jsonb_typeof(p_result->'status') is distinct from 'string'
     or jsonb_typeof(p_result->'provider') is distinct from 'string'
     or jsonb_typeof(p_result->'protocolVersion') is distinct from 'number'
     or jsonb_typeof(p_result->'gameCount') is distinct from 'number'
     or jsonb_typeof(p_result->'scope') is distinct from 'string'
     or jsonb_typeof(p_result->'includeAppInfo') is distinct from 'boolean'
     or jsonb_typeof(p_result->'includePlayedFreeGames') is distinct from 'boolean'
     or jsonb_typeof(p_result->'skipUnvettedApps') is distinct from 'boolean'
     or jsonb_typeof(p_result->'httpStatus') is distinct from 'number'
     or jsonb_typeof(p_result->'bodyBytes') is distinct from 'number'
     or p_result->>'scope' is distinct from 'complete_owned'
     or p_result->>'includeAppInfo' is distinct from 'true'
     or p_result->>'includePlayedFreeGames' is distinct from 'true'
     or p_result->>'skipUnvettedApps' is distinct from 'false'
     or p_result->>'httpStatus' is distinct from '200'
     or p_result->>'protocolVersion' is distinct from '1'
     or not pg_input_is_valid(coalesce(p_result->>'gameCount', ''), 'integer')
     or not pg_input_is_valid(coalesce(p_result->>'bodyBytes', ''), 'integer') then
    raise exception using errcode = 'invalid_parameter_value', message = 'complete publish provenance is not the fixed full scope';
  end if;
  v_game_count := (p_result->>'gameCount')::integer;
  v_body_bytes := (p_result->>'bodyBytes')::integer;
  if v_game_count < 0 or v_game_count > 10000 or v_body_bytes < 0 or v_body_bytes > 8388608 then
    raise exception using errcode = 'invalid_parameter_value', message = 'complete publish bounds are invalid';
  end if;
  if p_content_hash is distinct from sha256(convert_to(p_canonical_json, 'UTF8')) then
    raise exception using errcode = 'invalid_parameter_value', message = 'canonical text digest does not match';
  end if;
  if p_body_observed_at < v_job.fetch_started_at - interval '1 second'
     or p_body_observed_at > v_now + interval '5 minutes' then
    raise exception using errcode = 'invalid_parameter_value', message = 'body observation time is outside the fetch fence';
  end if;
  begin
    v_doc := p_canonical_json::jsonb;
  exception when others then
    raise exception using errcode = 'invalid_parameter_value', message = 'canonical text is not valid JSON';
  end;
  if jsonb_typeof(v_doc) <> 'object' then
    raise exception using errcode = 'invalid_parameter_value', message = 'canonical top-level value is not an object';
  end if;
  if (select count(*) from jsonb_object_keys(v_doc)) <> 4
     or exists (
       select 1 from jsonb_object_keys(v_doc) as k(key_name)
        where key_name not in ('provider', 'protocolVersion', 'gameCount', 'games')
     )
     or jsonb_typeof(v_doc->'provider') is distinct from 'string'
     or jsonb_typeof(v_doc->'protocolVersion') is distinct from 'number'
     or jsonb_typeof(v_doc->'gameCount') is distinct from 'number'
     or v_doc->>'provider' is distinct from 'steam'
     or v_doc->>'protocolVersion' is distinct from '1'
     or not pg_input_is_valid(coalesce(v_doc->>'gameCount', ''), 'integer') then
    raise exception using errcode = 'invalid_parameter_value', message = 'canonical top-level shape is invalid';
  end if;
  if (v_doc->>'gameCount')::integer <> v_game_count
     or jsonb_typeof(v_doc->'games') is distinct from 'array'
     or jsonb_array_length(v_doc->'games') <> v_game_count then
    raise exception using errcode = 'invalid_parameter_value', message = 'canonical game count is inconsistent';
  end if;

  drop table if exists pg_temp.m2_publish_games;
  create temporary table pg_temp.m2_publish_games (
    steam_app_id bigint primary key,
    name text not null,
    name_source text not null,
    playtime_minutes integer,
    last_played_at timestamptz,
    last_played_source text not null,
    game_id integer,
    have_current boolean not null default false,
    old_minutes integer,
    have_retired boolean not null default false,
    retired_minutes integer,
    have_activity boolean not null default false,
    old_activity_minutes integer,
    old_activity_played_at timestamptz,
    old_activity_observed_at timestamptz,
    old_activity_scope text,
    old_activity_source text,
    pinned_newer boolean not null default false,
    effective_minutes integer,
    effective_played_at timestamptz,
    effective_played_source text
  ) on commit drop;
  for v_game in select value from jsonb_array_elements(v_doc->'games') as e(value) loop
    if jsonb_typeof(v_game) <> 'object' then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical game row is not an object';
    end if;
    if (select count(*) from jsonb_object_keys(v_game)) <> 6
       or exists (
         select 1 from jsonb_object_keys(v_game) as k(key_name)
          where key_name not in (
            'appId', 'playtimeMinutes', 'name', 'nameSource',
            'lastPlayedAtEpochSeconds', 'lastPlayedSource'
          )
       )
       or jsonb_typeof(v_game->'appId') is distinct from 'string'
       or jsonb_typeof(v_game->'name') is distinct from 'string'
       or jsonb_typeof(v_game->'nameSource') is distinct from 'string'
       or jsonb_typeof(v_game->'lastPlayedSource') is distinct from 'string' then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical game row shape is invalid';
    end if;
    v_app_text := v_game->>'appId';
    if v_app_text is null or v_app_text !~ '^[1-9][0-9]*$'
       or not pg_input_is_valid(v_app_text, 'bigint') then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical AppID is invalid';
    end if;
    v_app := v_app_text::bigint;
    if v_app < 1 or v_app > 4294967295 then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical AppID is outside uint32';
    end if;
    if jsonb_typeof(v_game->'name') is distinct from 'string' then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical title is invalid';
    end if;
    v_name := v_game->>'name';
    v_name_source := v_game->>'nameSource';
    if length(v_name) not between 1 and 500
       or btrim(v_name) <> v_name
       or v_name ~ '[[:cntrl:]]'
       or v_name_source is null
       or v_name_source not in ('steam.name', 'catalog_stub')
       or (v_name_source = 'catalog_stub' and v_name <> 'Steam App ' || v_app_text) then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical title provenance is invalid';
    end if;
    v_minutes := null;
    if jsonb_typeof(v_game->'playtimeMinutes') not in ('null', 'number') then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical minutes type is invalid';
    end if;
    if v_game->>'playtimeMinutes' is not null then
      v_minutes_text := v_game->>'playtimeMinutes';
      if v_minutes_text !~ '^(0|[1-9][0-9]*)$'
         or not pg_input_is_valid(v_minutes_text, 'integer') then
        raise exception using errcode = 'invalid_parameter_value', message = 'canonical minutes range is invalid';
      end if;
      v_minutes := v_minutes_text::integer;
    end if;
    v_epoch := null;
    v_last_played := null;
    if jsonb_typeof(v_game->'lastPlayedAtEpochSeconds') not in ('null', 'number') then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical last-played type is invalid';
    end if;
    if v_game->>'lastPlayedAtEpochSeconds' is not null then
      v_epoch_text := v_game->>'lastPlayedAtEpochSeconds';
      if v_epoch_text !~ '^[1-9][0-9]*$'
         or not pg_input_is_valid(v_epoch_text, 'bigint') then
        raise exception using errcode = 'invalid_parameter_value', message = 'canonical last-played range is invalid';
      end if;
      v_epoch := v_epoch_text::bigint;
      if v_epoch > 9223372036854 then
        raise exception using errcode = 'invalid_parameter_value', message = 'canonical last-played timestamp is outside PostgreSQL range';
      end if;
      v_last_played := to_timestamp(v_epoch::double precision);
      if v_last_played > v_now + interval '5 minutes' then
        raise exception using errcode = 'invalid_parameter_value', message = 'canonical last-played timestamp is in the future';
      end if;
    end if;
    v_last_source := v_game->>'lastPlayedSource';
    if v_last_source not in ('steam.rtime_last_played', 'steam.rtime_last_played_unknown', 'not_provided')
       or (v_epoch is null and v_last_source = 'steam.rtime_last_played')
       or (v_epoch is not null and v_last_source <> 'steam.rtime_last_played') then
      raise exception using errcode = 'invalid_parameter_value', message = 'canonical last-played provenance is invalid';
    end if;
    insert into pg_temp.m2_publish_games(
      steam_app_id, name, name_source, playtime_minutes, last_played_at,
      last_played_source
    ) values (
      v_app, v_name, v_name_source, v_minutes, v_last_played, v_last_source
    );
    v_count := v_count + 1;
  end loop;
  if v_count <> v_game_count then
    raise exception using errcode = 'invalid_parameter_value', message = 'canonical game count did not stage completely';
  end if;
  select exists (
           select 1 from pg_temp.m2_publish_games
            where playtime_minutes is not null
         ),
         exists (
           select 1 from pg_temp.m2_publish_games
            where last_played_at is not null
              and last_played_source = 'steam.rtime_last_played'
         )
    into v_has_playtime_evidence, v_has_last_played_evidence;

  -- Minimal identities are safe to seed here; richer catalogue data is owned
  -- by the separate Store enrichment outbox and cannot be overwritten by a stub.
  insert into catalog.games(steam_app_id, title, normalized_sort_title, title_source)
  select s.steam_app_id, s.name, lower(btrim(s.name)),
    case when s.name_source = 'steam.name' then 'steam_name' else 'catalog_stub' end
    from pg_temp.m2_publish_games as s
  on conflict (steam_app_id) do update
    set title = case when catalog.games.title_source in ('existing', 'catalog_stub')
                     and excluded.title_source = 'steam_name'
                    then excluded.title else catalog.games.title end,
        normalized_sort_title = case when catalog.games.title_source in ('existing', 'catalog_stub')
                     and excluded.title_source = 'steam_name'
                    then excluded.normalized_sort_title else catalog.games.normalized_sort_title end,
        title_source = case when catalog.games.title_source in ('existing', 'catalog_stub')
                     and excluded.title_source = 'steam_name'
                    then excluded.title_source else catalog.games.title_source end,
        updated_at = case when catalog.games.title_source in ('existing', 'catalog_stub')
                     and excluded.title_source = 'steam_name'
                    then v_now else catalog.games.updated_at end;
  update pg_temp.m2_publish_games as s
     set game_id = g.id
    from catalog.games as g
   where g.steam_app_id = s.steam_app_id;

  -- Stage the account facts in bulk before changing any tenant rows.  The
  -- previous row-at-a-time implementation performed four indexed lookups and
  -- often two writes per game; these joins keep the same monotonic/fenced
  -- semantics while keeping a 10,000-game publish inside the measured M2
  -- transaction budget.
  update pg_temp.m2_publish_games as s
     set have_current = true, old_minutes = lg.playtime_minutes
    from app.library_games as lg
   where lg.account_id = v_job.account_id and lg.game_id = s.game_id;
  update pg_temp.m2_publish_games as s
     set have_retired = true, retired_minutes = rg.last_personal_minutes
    from app.retired_library_games as rg
   where rg.account_id = v_job.account_id and rg.game_id = s.game_id;
  update pg_temp.m2_publish_games as s
     set have_activity = true,
         old_activity_minutes = a.last_observed_minutes,
         old_activity_played_at = a.last_played_at,
         old_activity_observed_at = a.observed_at,
         old_activity_scope = a.observation_scope,
         old_activity_source = a.last_played_source,
         pinned_newer = a.observation_scope = 'pinned_owned'
           and a.observed_at > v_job.fetch_started_at
    from app.game_activity as a
   where a.account_id = v_job.account_id and a.game_id = s.game_id;
  update pg_temp.m2_publish_games as s
     set effective_minutes = greatest(
           s.playtime_minutes, s.old_minutes, s.retired_minutes,
           s.old_activity_minutes
         ),
         effective_played_at = case
           when s.have_activity and s.old_activity_played_at is not null
             then greatest(coalesce(s.last_played_at, s.old_activity_played_at), s.old_activity_played_at)
           else s.last_played_at
         end;
  update pg_temp.m2_publish_games as s
     set effective_played_source = case
       when s.have_activity
        and s.effective_played_at is not distinct from s.old_activity_played_at
         then s.old_activity_source
       else s.last_played_source
     end;

  insert into app.library_observation_anomalies(
    account_id, game_id, job_id, reason, prior_minutes, incoming_minutes,
    observed_at, source, detail
  )
  select v_job.account_id, s.game_id, v_job.id, 'provider_decrease',
    s.old_minutes, s.playtime_minutes, v_now, 'steam_api',
    'greatest known minutes retained'
    from pg_temp.m2_publish_games as s
   where s.have_current and s.playtime_minutes is not null
     and s.old_minutes is not null and s.playtime_minutes < s.old_minutes;

  insert into app.library_games(account_id, game_id, playtime_minutes)
  select v_job.account_id, s.game_id, s.effective_minutes
    from pg_temp.m2_publish_games as s
   where not s.have_current;
  get diagnostics v_count = row_count;
  v_library_changed := v_library_changed + v_count;
  if v_count > 0 then v_fact_changed := true; end if;

  update app.library_games as lg
     set playtime_minutes = s.effective_minutes
    from pg_temp.m2_publish_games as s
   where s.have_current and lg.account_id = v_job.account_id
     and lg.game_id = s.game_id
     and lg.playtime_minutes is distinct from s.effective_minutes;
  get diagnostics v_count = row_count;
  v_library_changed := v_library_changed + v_count;
  if v_count > 0 then v_fact_changed := true; end if;

  -- Reacquisition always removes the corresponding retired row, including a
  -- row whose last known minutes are NULL.
  delete from app.retired_library_games as rg
   using pg_temp.m2_publish_games as s
   where s.have_retired and rg.account_id = v_job.account_id
     and rg.game_id = s.game_id;

  -- A pinned observation newer than this full fetch remains authoritative for
  -- sparse activity.  Valid full rows still establish library access above.
  insert into app.game_activity(
    account_id, game_id, last_observed_minutes, last_played_at, observed_at,
    evidence_source, observation_scope, last_played_source
  )
  select v_job.account_id, s.game_id, s.effective_minutes, s.effective_played_at,
    p_body_observed_at, 'steam_api', 'full_owned', s.effective_played_source
    from pg_temp.m2_publish_games as s
   where not s.have_activity and
     (s.effective_minutes is not null or s.effective_played_at is not null);
  get diagnostics v_count = row_count;
  v_activity_changed := v_activity_changed + v_count;
  if v_count > 0 then v_fact_changed := true; end if;

  update app.game_activity as a
     set last_observed_minutes = s.effective_minutes,
         last_played_at = s.effective_played_at,
         observed_at = p_body_observed_at,
         evidence_source = 'steam_api', observation_scope = 'full_owned',
         last_played_source = s.effective_played_source
    from pg_temp.m2_publish_games as s
   where s.have_activity and not s.pinned_newer
     and a.account_id = v_job.account_id and a.game_id = s.game_id
     and (a.last_observed_minutes is distinct from s.effective_minutes
       or a.last_played_at is distinct from s.effective_played_at
       or a.observation_scope is distinct from 'full_owned'
       or a.last_played_source is distinct from s.effective_played_source);
  get diagnostics v_count = row_count;
  v_activity_changed := v_activity_changed + v_count;
  if v_count > 0 then v_fact_changed := true; end if;

  -- The anti-join is intentionally account-leading; the library has no
  -- blanket reverse game index.  Newer pinned evidence defers removal.
  for v_old_game_id in
    select lg.game_id from app.library_games as lg
     where lg.account_id = v_job.account_id
       and not exists (select 1 from pg_temp.m2_publish_games as s where s.game_id = lg.game_id)
  loop
    if exists (
      select 1 from app.game_activity as a
       where a.account_id = v_job.account_id and a.game_id = v_old_game_id
         and a.observation_scope = 'pinned_owned'
         and a.observed_at > v_job.fetch_started_at
    ) or exists (
      select 1 from app.library_observation_fences as f
       where f.account_id = v_job.account_id and f.game_id = v_old_game_id
         and f.last_confirmed_at > v_job.fetch_started_at
    ) or exists (
      select 1 from ops.provider_call_charges as c
       where c.account_id = v_job.account_id and c.scope_game_id = v_old_game_id
         and c.endpoint = 'pinned' and c.status = 'charged'
         and c.expires_at > v_now and c.fetch_started_at > v_job.fetch_started_at
    ) then
      insert into app.library_observation_anomalies(
        account_id, game_id, job_id, reason, observed_at, source, detail
      ) values (v_job.account_id, v_old_game_id, v_job.id,
        'newer_observation_defers_removal', v_now, 'steam_api',
        'newer pinned-owned observation is in flight or already applied');
      v_deferred_count := v_deferred_count + 1;
    else
      select greatest(
        lg.playtime_minutes,
        a.last_observed_minutes,
        rg.last_personal_minutes
      ), greatest(
        coalesce(a.observed_at, p_body_observed_at),
        rg.last_observed_at
      ) into v_effective_minutes, v_last_observed_at
        from app.library_games as lg
        left join app.game_activity as a
          on a.account_id = lg.account_id and a.game_id = lg.game_id
        left join app.retired_library_games as rg
          on rg.account_id = lg.account_id and rg.game_id = lg.game_id
       where lg.account_id = v_job.account_id and lg.game_id = v_old_game_id;
      insert into app.retired_library_games(
        account_id, game_id, last_personal_minutes, last_observed_at,
        access_lost_at, loss_reason
      ) values (
        v_job.account_id, v_old_game_id, v_effective_minutes, v_last_observed_at, v_now,
        'complete_snapshot'
      ) on conflict on constraint retired_library_games_pkey do update
        set last_personal_minutes = case
              when app.retired_library_games.last_personal_minutes is null
               and excluded.last_personal_minutes is null then null
              else greatest(
                coalesce(app.retired_library_games.last_personal_minutes, 0),
                coalesce(excluded.last_personal_minutes, 0)
              )
            end,
            last_observed_at = greatest(
              coalesce(app.retired_library_games.last_observed_at, excluded.last_observed_at),
              excluded.last_observed_at
            ), access_lost_at = excluded.access_lost_at, loss_reason = excluded.loss_reason;
      delete from app.library_games as lg
       where lg.account_id = v_job.account_id and lg.game_id = v_old_game_id;
      v_retired_count := v_retired_count + 1;
      v_fact_changed := true;
    end if;
  end loop;

  -- Clear only unavailable playable commitments.  Wishlist and history/draw
  -- references remain intact, and family access keeps a commitment playable.
  delete from app.pins as p
   where p.account_id = v_job.account_id
     and p.scope in ('library', 'family', 'all')
     and not exists (select 1 from app.library_games as lg
       where lg.account_id = p.account_id and lg.game_id = p.game_id)
     and not exists (select 1 from app.family_game_access as fa
       where fa.account_id = p.account_id and fa.game_id = p.game_id);
  if found then v_state_changed := true; end if;
  select vs.current_game_id, vs.revision into v_old_game_id, v_old_state_revision
    from app.vault_state as vs where vs.account_id = v_job.account_id for update;
  if found and v_old_game_id is not null
     and not exists (select 1 from app.library_games as lg
       where lg.account_id = v_job.account_id and lg.game_id = v_old_game_id)
     and not exists (select 1 from app.family_game_access as fa
       where fa.account_id = v_job.account_id and fa.game_id = v_old_game_id) then
    update app.vault_state
       set current_game_id = null, revision = revision + 1, updated_at = v_now
     where app.vault_state.account_id = v_job.account_id;
    v_state_changed := true;
  end if;
  if v_state_changed then
    update app.accounts set state_revision = state_revision + 1 where id = v_job.account_id;
  end if;
  if v_fact_changed then
    update app.accounts set library_revision = library_revision + 1,
      last_seen_at = v_now where id = v_job.account_id;
  end if;
  insert into app.account_capabilities(account_id, library_visibility, playtime_visibility,
    last_played_visibility, checked_at, status)
  values (
    v_job.account_id,
    'visible',
    case when v_has_playtime_evidence then 'visible' else 'unknown' end,
    case when v_has_last_played_evidence then 'visible' else 'unknown' end,
    v_now, 'ok'
  )
  on conflict on constraint account_capabilities_pkey do update
    set library_visibility = excluded.library_visibility,
    playtime_visibility = excluded.playtime_visibility,
    last_played_visibility = excluded.last_played_visibility,
    checked_at = excluded.checked_at, status = excluded.status;
  insert into ops.enrichment_outbox(provider, game_id, catalog_revision, kind)
  select 'steam_store', s.game_id, 0, 'owned_identity'
    from pg_temp.m2_publish_games as s
  on conflict (provider, game_id, catalog_revision, kind) do nothing;
  get diagnostics v_enrichment_count = row_count;

  v_message_id := coalesce(p_message_id, v_job.message_id);
  if v_message_id is not null then
    v_ack := pgmq.delete(v_job.queue_name, v_message_id);
    if not v_ack then
      raise exception using errcode = 'serialization_failure', message = 'matching queue message was not found';
    end if;
  else
    v_ack := true;
  end if;
  update ops.provider_call_charges
     set status = 'applied', completed_at = v_now
   where attempt_id = v_job.attempt_id and attempt_token = v_job.attempt_token
     and status = 'charged';
  update app.library_sync_state
     set applied_generation = v_job.generation,
         authoritative_snapshot_at = p_body_observed_at,
         last_full_authoritative_at = p_body_observed_at,
         snapshot_hash = p_content_hash,
         observed_count = v_game_count,
         last_result = 'complete',
         in_flight_job_id = null, active_request_key = null, updated_at = v_now
   where app.library_sync_state.account_id = v_job.account_id;
  update ops.jobs
     set status = 'succeeded', retry_policy = 'none', result_code = 'complete',
         result_detail = null, result_hash = p_content_hash,
         protocol_version = 1, observed_count = v_game_count,
         library_changed_count = v_library_changed,
         activity_changed_count = v_activity_changed,
         retired_count = v_retired_count,
         sweep_deferred_count = v_deferred_count,
         enrichment_enqueued_count = v_enrichment_count,
         applied_generation = v_job.generation,
         applied_library_revision = (select a.library_revision from app.accounts as a where a.id = v_job.account_id),
         applied_state_revision = (select a.state_revision from app.accounts as a where a.id = v_job.account_id),
         completed_lease_token = p_lease_token,
         body_observed_at = p_body_observed_at, queue_acknowledged = v_ack,
         retain_until = v_now + interval '14 days',
         completed_at = v_now, updated_at = v_now,
         lease_token = null, lease_expires_at = null, fetch_started_at = null,
         attempt_id = null, attempt_token = null, charged_at = null
   where id = v_job.id;
  return query select 'applied'::text, v_job.id, v_job.account_id, v_job.generation,
    v_job.generation, p_content_hash, v_game_count, v_library_changed,
    v_activity_changed, v_retired_count, v_deferred_count, v_enrichment_count,
    v_ack;
end
$$;

-- M2's operational relations are forced-RLS and have no direct runtime
-- policy. Definer functions owned by the migration role are the only path to
-- quota, lease, queue, job, and outbox state. The two sparse app relations
-- are tenant-readable for diagnostics; their mutation path is function-only.
alter table ops.provider_controls enable row level security;
alter table ops.provider_controls force row level security;
alter table ops.jobs enable row level security;
alter table ops.jobs force row level security;
alter table ops.job_requests enable row level security;
alter table ops.job_requests force row level security;
alter table ops.provider_quota_daily enable row level security;
alter table ops.provider_quota_daily force row level security;
alter table ops.provider_token_buckets enable row level security;
alter table ops.provider_token_buckets force row level security;
alter table ops.provider_call_charges enable row level security;
alter table ops.provider_call_charges force row level security;
alter table ops.enrichment_outbox enable row level security;
alter table ops.enrichment_outbox force row level security;

alter table app.library_observation_anomalies enable row level security;
alter table app.library_observation_anomalies force row level security;
create policy m2_tenant_read on app.library_observation_anomalies
  for select to vault_app
  using (account_id = app.current_account_id());
alter table app.library_observation_fences enable row level security;
alter table app.library_observation_fences force row level security;
create policy m2_tenant_read on app.library_observation_fences
  for select to vault_app
  using (account_id = app.current_account_id());

-- PGMQ is an implementation detail. Even a runtime worker must use the
-- fixed wrappers so queue names, message shape, and acknowledgement order
-- cannot be supplied by an untrusted caller.
revoke all on schema pgmq from public, vault_app, vault_worker;
revoke all on all tables in schema pgmq from public, vault_app, vault_worker;
revoke all on all sequences in schema pgmq from public, vault_app, vault_worker;
revoke all on all functions in schema pgmq from public, vault_app, vault_worker;
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = role_name) then
      execute format('revoke all on schema pgmq from %I', role_name);
      execute format('revoke all on all tables in schema pgmq from %I', role_name);
      execute format('revoke all on all sequences in schema pgmq from %I', role_name);
      execute format('revoke all on all functions in schema pgmq from %I', role_name);
    end if;
  end loop;
end
$$;

-- Explicitly remove the global PUBLIC execute grant from every new function;
-- the M1 default-privilege rule handles future functions created by this
-- migration owner, while these statements also make the boundary auditable.
revoke all on function ops.consume_provider_attempt(text, uuid, integer, integer, uuid, integer)
  from public, vault_app, vault_worker;
revoke all on function app.consume_provider_attempt(text, integer, uuid, integer)
  from public, vault_app, vault_worker;
revoke all on function ops._m2_authorized_profile(integer) from public, vault_app, vault_worker;
revoke all on function ops._m2_queue_name(text) from public, vault_app, vault_worker;
revoke all on function ops._m2_queue_lock(text) from public, vault_app, vault_worker;
revoke all on function ops._m2_request_owned_snapshot(integer, uuid, text) from public, vault_app, vault_worker;
revoke all on function app.request_owned_snapshot(uuid, text) from public, vault_app, vault_worker;
revoke all on function ops.request_owned_snapshot_for_account(integer, uuid) from public, vault_app, vault_worker;
revoke all on function app.get_owned_snapshot_status(uuid) from public, vault_app, vault_worker;
revoke all on function ops.enqueue_job(uuid) from public, vault_app, vault_worker;
revoke all on function ops.claim_job(text, integer) from public, vault_app, vault_worker;
revoke all on function ops.renew_job_lease(uuid, uuid, integer) from public, vault_app, vault_worker;
revoke all on function ops.ack_job(uuid, uuid, bigint) from public, vault_app, vault_worker;
revoke all on function ops.retry_job(uuid, uuid, text, text, timestamptz, text, bigint)
  from public, vault_app, vault_worker;
revoke all on function ops.enqueue_enrichment(text, integer, bigint, text)
  from public, vault_app, vault_worker;
revoke all on function app.begin_pinned_owned_refresh(integer) from public, vault_app, vault_worker;
revoke all on function app.record_pinned_owned_observation(uuid, uuid, jsonb)
  from public, vault_app, vault_worker;
revoke all on function ops.publish_owned_snapshot(uuid, uuid, jsonb, text, bytea, timestamptz, bigint)
  from public, vault_app, vault_worker;
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = role_name) then
      execute format('revoke all on function ops.consume_provider_attempt(text, uuid, integer, integer, uuid, integer) from %I', role_name);
      execute format('revoke all on function app.consume_provider_attempt(text, integer, uuid, integer) from %I', role_name);
      execute format('revoke all on function ops._m2_queue_lock(text) from %I', role_name);
      execute format('revoke all on function ops.request_owned_snapshot_for_account(integer, uuid) from %I', role_name);
      execute format('revoke all on function app.request_owned_snapshot(uuid, text) from %I', role_name);
      execute format('revoke all on function app.get_owned_snapshot_status(uuid) from %I', role_name);
      execute format('revoke all on function app.begin_pinned_owned_refresh(integer) from %I', role_name);
      execute format('revoke all on function app.record_pinned_owned_observation(uuid, uuid, jsonb) from %I', role_name);
      execute format('revoke all on function ops.claim_job(text, integer) from %I', role_name);
      execute format('revoke all on function ops.renew_job_lease(uuid, uuid, integer) from %I', role_name);
      execute format('revoke all on function ops.ack_job(uuid, uuid, bigint) from %I', role_name);
      execute format('revoke all on function ops.retry_job(uuid, uuid, text, text, timestamptz, text, bigint) from %I', role_name);
      execute format('revoke all on function ops.publish_owned_snapshot(uuid, uuid, jsonb, text, bytea, timestamptz, bigint) from %I', role_name);
    end if;
  end loop;
end
$$;

grant usage on schema ops to vault_worker;
-- The raw generic helper is callable only by migration-owned definer code.
-- Workers reach it through claim/pinned/request wrappers, which supply the
-- already-selected job or account and do not expose an arbitrary job-ID RPC.
grant execute on function app.consume_provider_attempt(text, integer, uuid, integer)
  to vault_app;
grant execute on function app.request_owned_snapshot(uuid, text) to vault_app;
grant execute on function app.get_owned_snapshot_status(uuid) to vault_app;
grant execute on function app.begin_pinned_owned_refresh(integer) to vault_app;
grant execute on function app.record_pinned_owned_observation(uuid, uuid, jsonb) to vault_app;
grant execute on function ops.request_owned_snapshot_for_account(integer, uuid) to vault_worker;
grant execute on function ops.enqueue_job(uuid) to vault_worker;
grant execute on function ops.claim_job(text, integer) to vault_worker;
grant execute on function ops.renew_job_lease(uuid, uuid, integer) to vault_worker;
grant execute on function ops.ack_job(uuid, uuid, bigint) to vault_worker;
grant execute on function ops.retry_job(uuid, uuid, text, text, timestamptz, text, bigint)
  to vault_worker;
grant execute on function ops.enqueue_enrichment(text, integer, bigint, text) to vault_worker;
grant execute on function ops.publish_owned_snapshot(uuid, uuid, jsonb, text, bytea, timestamptz, bigint)
  to vault_worker;
grant select on app.library_observation_anomalies, app.library_observation_fences to vault_app;

-- Defaults for future M2 objects remain deny-by-default for the runtime
-- groups. The explicit grants above are the complete callable surface.
alter default privileges in schema app revoke all on tables from vault_app, vault_worker;
alter default privileges in schema app revoke all on sequences from vault_app, vault_worker;
alter default privileges in schema app revoke execute on functions from vault_app, vault_worker;
alter default privileges in schema ops revoke all on tables from vault_app, vault_worker;
alter default privileges in schema ops revoke all on sequences from vault_app, vault_worker;
alter default privileges in schema ops revoke execute on functions from vault_app, vault_worker;
