-- VaultShuffle v2 M2 management-compatible fixture.
--
-- This is one pure SQL transaction. It creates only synthetic rows, grants
-- SET ROLE membership to the current test operator for the duration of the
-- transaction, and rolls the entire rehearsal back. It deliberately contains
-- no psql variables, dollar-quoted interpolation, TRUNCATE, or blanket
-- cleanup. A target execute_sql transport can submit this file as one query.

begin;
set local app.m2_fixture = 'on';

update ops.provider_controls
   set mode = 'fixture', reason = 'M2 rollback fixture', updated_at = clock_timestamp()
 where provider = 'steam';

create temp table m2_accounts (
  fixture_key text primary key,
  id integer not null,
  public_id uuid not null,
  account_kind text not null
) on commit drop;

with input(fixture_key, public_id, account_kind, display_name) as materialized (
  values
    ('one', '00000000-0000-0000-0000-000000002001'::uuid, 'manual', 'M2 Manual One'),
    ('two', '00000000-0000-0000-0000-000000002002'::uuid, 'manual', 'M2 Manual Two'),
    ('three', '00000000-0000-0000-0000-000000002003'::uuid, 'steam', 'M2 Steam Unverified'),
    ('four', '00000000-0000-0000-0000-000000002004'::uuid, 'manual', 'M2 Manual Duplicate')
), inserted as (
  insert into app.accounts(public_id, account_kind, display_name)
  select public_id, account_kind, display_name from input
  returning id, public_id, account_kind
)
insert into m2_accounts(fixture_key, id, public_id, account_kind)
select input.fixture_key, inserted.id, inserted.public_id, inserted.account_kind
  from input join inserted using (public_id);

insert into app.steam_profiles(
  account_id, steam_id, verified, display_name, steam_display_name
)
select id, steam_id, verified, display_name, display_name
  from (
    select (select id from m2_accounts where fixture_key = 'one') as id,
           76561198000002001::bigint as steam_id, false as verified,
           'M2 Shared Public One'::text as display_name
    union all
    select (select id from m2_accounts where fixture_key = 'two'),
           76561198000002001, false, 'M2 Shared Public Two'
    union all
    select (select id from m2_accounts where fixture_key = 'three'),
           76561198000002003, false, 'M2 Steam Not Verified'
    union all
    select (select id from m2_accounts where fixture_key = 'four'),
           76561198000002001, false, 'M2 Shared Public Four'
  ) as profiles;

create temp table m2_games (
  fixture_key text primary key,
  id integer not null,
  steam_app_id bigint not null
) on commit drop;

with input(fixture_key, steam_app_id, title) as materialized (
  values
    ('one', 1001::bigint, 'M2 Fixture One'),
    ('two', 1002::bigint, 'M2 Fixture Two'),
    ('three', 1003::bigint, 'M2 Fixture Three')
), inserted as (
  insert into catalog.games(steam_app_id, title, normalized_sort_title)
  select steam_app_id, title, lower(title) from input
  returning id, steam_app_id
)
insert into m2_games(fixture_key, id, steam_app_id)
select input.fixture_key, inserted.id, inserted.steam_app_id
  from input join inserted using (steam_app_id);

create temp table m2_jobs (
  request_key uuid primary key,
  job_id uuid not null,
  status text not null,
  generation bigint,
  coalesced boolean,
  quota_retry_at timestamptz
) on commit drop;
create temp table m2_claim (
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
) on commit drop;
create temp table m2_publish (
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
) on commit drop;
create temp table m2_replay (like m2_publish) on commit drop;
create temp table m2_payload (
  canonical_json text not null,
  content_hash bytea not null,
  result jsonb not null,
  body_observed_at timestamptz not null
) on commit drop;

-- Seed private facts that a complete snapshot must reconcile or preserve.
insert into app.library_games(account_id, game_id, playtime_minutes)
values
  ((select id from m2_accounts where fixture_key = 'one'),
   (select id from m2_games where fixture_key = 'one'), 5),
  ((select id from m2_accounts where fixture_key = 'one'),
   (select id from m2_games where fixture_key = 'two'), 12),
  ((select id from m2_accounts where fixture_key = 'one'),
   (select id from m2_games where fixture_key = 'three'), null);

insert into app.game_activity(
  account_id, game_id, last_observed_minutes, last_played_at, observed_at,
  evidence_source, interval_started_at, interval_ended_at
)
values (
  (select id from m2_accounts where fixture_key = 'one'),
  (select id from m2_games where fixture_key = 'one'), 5,
  now() - interval '2 days', now() - interval '2 days', 'steam_api',
  now() - interval '3 days', now() - interval '2 days'
);

insert into app.game_state(
  account_id, game_id, slept_at, previous_active_status,
  restored_from_slept_at, restored_from_previous_active_status
)
values (
  (select id from m2_accounts where fixture_key = 'one'),
  (select id from m2_games where fixture_key = 'three'),
  now() - interval '3 days', 'Sampled', now() - interval '2 days', 'Sampled'
);

insert into app.vault_state(account_id, current_game_id, current_draw_ref)
values (
  (select id from m2_accounts where fixture_key = 'one'),
  (select id from m2_games where fixture_key = 'three'),
  '00000000-0000-0000-0000-000000002099'
);

insert into app.pins(account_id, scope, slot, game_id, personal_minutes_baseline)
values
  ((select id from m2_accounts where fixture_key = 'one'), 'library', 1,
   (select id from m2_games where fixture_key = 'three'), null),
  ((select id from m2_accounts where fixture_key = 'one'), 'wishlist', 1,
   (select id from m2_games where fixture_key = 'two'), 12);

insert into app.family_members(account_id, steam_id, candidate_app_ids, candidate_count, checked_at, error_status)
values (
  (select id from m2_accounts where fixture_key = 'one'),
  76561198100002001, '[1002]'::jsonb, 1, now(), 'ok'
);
insert into app.family_game_access(account_id, member_id, game_id, provenance)
select (select id from m2_accounts where fixture_key = 'one'), fm.id,
       (select id from m2_games where fixture_key = 'two'), 'inferred'
  from app.family_members as fm
 where fm.account_id = (select id from m2_accounts where fixture_key = 'one');

create temp table m2_collection as
select id as collection_id
  from app.collections
 where false;
insert into app.collections(account_id, public_id, collection_kind, name)
values (
  (select id from m2_accounts where fixture_key = 'one'),
  '00000000-0000-0000-0000-000000002088', 'custom', 'M2 Preserved Collection'
)
;
insert into m2_collection(collection_id)
select id from app.collections
 where public_id = '00000000-0000-0000-0000-000000002088'::uuid;
insert into app.collection_games(account_id, collection_id, game_id, position, note)
values (
  (select id from m2_accounts where fixture_key = 'one'),
  (select collection_id from m2_collection),
  (select id from m2_games where fixture_key = 'two'), 0, 'preserve this note'
);
insert into app.snoozes(account_id, game_id, until_at, reason, source)
values (
  (select id from m2_accounts where fixture_key = 'one'),
  (select id from m2_games where fixture_key = 'two'), now() + interval '1 day',
  'preserve this snooze', 'user'
);
insert into app.completion_events(account_id, game_id, occurred_at, source, dedupe_key)
values (
  (select id from m2_accounts where fixture_key = 'one'),
  (select id from m2_games where fixture_key = 'two'), now() - interval '1 hour',
  'user', 'm2-preserved-completion'
);

-- The exact canonical text is supplied independently from metadata. This
-- small SQL payload exercises the same four-key canonical shape; the separate
-- TypeScript 10k harness supplies actual normalizer bytes and digest.
insert into m2_payload(canonical_json, content_hash, result, body_observed_at)
select canonical_json,
       sha256(convert_to(canonical_json, 'UTF8')),
       jsonb_build_object(
         'status', 'complete', 'provider', 'steam', 'protocolVersion', 1,
         'scope', 'complete_owned', 'includeAppInfo', true,
         'includePlayedFreeGames', true, 'skipUnvettedApps', false,
         'httpStatus', 200, 'gameCount', 1,
         'bodyBytes', octet_length(convert_to(canonical_json, 'UTF8'))
       ),
       clock_timestamp()
  from (
    select jsonb_build_object(
      'provider', 'steam', 'protocolVersion', 1, 'gameCount', 1,
      'games', jsonb_build_array(jsonb_build_object(
        'appId', '1001', 'playtimeMinutes', 10, 'name', 'M2 Fixture One',
        'nameSource', 'steam.name', 'lastPlayedAtEpochSeconds', 1700000000,
        'lastPlayedSource', 'steam.rtime_last_played'
      ))
    )::text as canonical_json
  ) as payload;

-- Temporary result/fixture tables are session-owned by the test operator;
-- grant only their transaction-local use before switching to runtime roles.
grant all on m2_accounts, m2_games, m2_jobs, m2_claim, m2_publish,
  m2_replay, m2_payload to vault_app, vault_worker;

-- The fixture operator is temporarily allowed to assume each runtime group.
-- Both memberships and all rows are rolled back by the final ROLLBACK.
do $$
begin
  execute format('grant vault_app, vault_worker to %I with set true', current_user);
end
$$;

set local role vault_app;
select set_config(
  'app.account_id',
  (select id::text from m2_accounts where fixture_key = 'one'),
  true
);

insert into m2_jobs(request_key, job_id, status, generation, coalesced, quota_retry_at)
select request_key, r.job_id, r.status, r.generation, r.coalesced, r.quota_retry_at
  from (values ('00000000-0000-0000-0000-000000002011'::uuid)) as request(request_key)
  cross join lateral app.request_owned_snapshot(request.request_key, 'interactive') as r;

do $assert$
declare
  v_count integer;
begin
  select count(*) into v_count from m2_jobs
   where status = 'enqueued' and coalesced is false and job_id is not null;
  if v_count <> 1 then raise exception 'M2 request did not enqueue one owned job'; end if;
end
$assert$;

insert into m2_jobs(request_key, job_id, status, generation, coalesced, quota_retry_at)
select request_key, r.job_id, r.status, r.generation, r.coalesced, r.quota_retry_at
  from (values ('00000000-0000-0000-0000-000000002012'::uuid)) as request(request_key)
  cross join lateral app.request_owned_snapshot(request.request_key, 'interactive') as r;

do $assert$
declare
  v_job_id uuid;
begin
  select job_id into v_job_id from m2_jobs
   where request_key = '00000000-0000-0000-0000-000000002011'::uuid;
  if not exists (
    select 1 from m2_jobs
     where request_key = '00000000-0000-0000-0000-000000002012'::uuid
       and job_id = v_job_id and coalesced
  ) then raise exception 'coalesced request alias did not retain the original job'; end if;
end
$assert$;

set local role vault_worker;
insert into m2_claim
select * from ops.claim_job('interactive', 120);

do $assert$
declare
  v_claim m2_claim%rowtype;
begin
  select * into v_claim from m2_claim where claimed limit 1;
  if not found then raise exception 'owned job was not claimed'; end if;
  if v_claim.provider_mode <> 'fixture' or v_claim.job_kind <> 'owned_snapshot'
     or v_claim.attempt <> 1 or v_claim.attempt_id is null
     or v_claim.attempt_token is null or v_claim.lease_token is null
     or v_claim.provider_subject <> 76561198000002001 then
    raise exception 'claim did not return the DB-derived fenced identity';
  end if;
end
$assert$;

-- An invalid digest is rejected in a subtransaction and leaves the lease
-- available for the valid publish immediately afterwards.
do $assert$
declare
  c m2_claim%rowtype;
  p m2_payload%rowtype;
  probe record;
  saw_invalid boolean := false;
begin
  select * into c from m2_claim where claimed limit 1;
  select * into p from m2_payload limit 1;
  begin
    select * into probe from ops.publish_owned_snapshot(
      c.job_id, c.lease_token, p.result, p.canonical_json,
      repeat('00', 32)::bytea, p.body_observed_at, c.message_id
    );
    raise exception 'invalid digest was accepted';
  exception when invalid_parameter_value then
    saw_invalid := true;
  end;
  if not saw_invalid then raise exception 'invalid digest did not use the expected assertion path'; end if;
end
$assert$;

insert into m2_publish
select c.*
  from m2_claim as claim
  cross join m2_payload as p
  cross join lateral ops.publish_owned_snapshot(
    claim.job_id, claim.lease_token, p.result, p.canonical_json,
    p.content_hash, p.body_observed_at, claim.message_id
  ) as c
 where claim.claimed;

insert into m2_replay
select c.*
  from m2_claim as claim
  cross join m2_payload as p
  cross join lateral ops.publish_owned_snapshot(
    claim.job_id, claim.lease_token, p.result, p.canonical_json,
    p.content_hash, p.body_observed_at, claim.message_id
  ) as c
 where claim.claimed;

do $assert$
declare
  p m2_publish%rowtype;
  r m2_replay%rowtype;
  expected_hash bytea;
begin
  select * into p from m2_publish limit 1;
  select * into r from m2_replay limit 1;
  select content_hash into expected_hash from m2_payload limit 1;
  if p.result <> 'applied' or p.observed_count <> 1
     or p.library_changed <> 1 or p.retired_count <> 2
     or p.snapshot_hash is distinct from expected_hash or not p.acknowledged then
    raise exception 'complete publication summary is incorrect';
  end if;
  if r.result <> 'already_applied' or r.applied_generation is distinct from p.applied_generation
     or r.snapshot_hash is distinct from p.snapshot_hash
     or r.library_changed <> p.library_changed or not r.acknowledged then
    raise exception 'terminal response-loss replay is not the stored summary';
  end if;
end
$assert$;

set local role vault_app;
select set_config(
  'app.account_id',
  (select id::text from m2_accounts where fixture_key = 'one'),
  true
);

do $assert$
declare
  v_count integer;
  v_draw uuid;
  v_job uuid;
begin
  select job_id into v_job from m2_jobs
   where request_key = '00000000-0000-0000-0000-000000002011'::uuid;
  if (select count(*) from app.library_games
      where account_id = (select id from m2_accounts where fixture_key = 'one')) <> 1
     or not exists (select 1 from app.library_games
      where account_id = (select id from m2_accounts where fixture_key = 'one')
        and game_id = (select id from m2_games where fixture_key = 'one')
        and playtime_minutes = 10) then
    raise exception 'complete library reconciliation did not apply changed access';
  end if;
  select count(*) into v_count from app.retired_library_games
   where account_id = (select id from m2_accounts where fixture_key = 'one');
  if v_count <> 2 then raise exception 'complete snapshot did not retire missing personal rows'; end if;
  if exists (select 1 from app.pins
      where account_id = (select id from m2_accounts where fixture_key = 'one')
        and scope = 'library' and game_id = (select id from m2_games where fixture_key = 'three')) then
    raise exception 'unavailable library pin was retained';
  end if;
  if not exists (select 1 from app.pins
      where account_id = (select id from m2_accounts where fixture_key = 'one')
        and scope = 'wishlist' and game_id = (select id from m2_games where fixture_key = 'two')) then
    raise exception 'wishlist pin was cleared';
  end if;
  if not exists (select 1 from app.family_game_access
      where account_id = (select id from m2_accounts where fixture_key = 'one')
        and game_id = (select id from m2_games where fixture_key = 'two')) then
    raise exception 'family access was swept';
  end if;
  if not exists (select 1 from app.collection_games
      where account_id = (select id from m2_accounts where fixture_key = 'one')
        and game_id = (select id from m2_games where fixture_key = 'two'))
     or not exists (select 1 from app.snoozes
      where account_id = (select id from m2_accounts where fixture_key = 'one')
        and game_id = (select id from m2_games where fixture_key = 'two'))
     or not exists (select 1 from app.completion_events
      where account_id = (select id from m2_accounts where fixture_key = 'one')
        and dedupe_key = 'm2-preserved-completion') then
    raise exception 'authored/history facts were not preserved';
  end if;
  select current_draw_ref into v_draw from app.vault_state
   where account_id = (select id from m2_accounts where fixture_key = 'one');
  if v_draw <> '00000000-0000-0000-0000-000000002099'::uuid
     or exists (select 1 from app.vault_state
      where account_id = (select id from m2_accounts where fixture_key = 'one')
        and current_game_id is not null) then
    raise exception 'current pick invalidation did not preserve draw history';
  end if;
  if (select status from app.get_owned_snapshot_status(v_job)) <> 'succeeded' then
    raise exception 'tenant status helper did not expose the applied job';
  end if;
end
$assert$;

-- Every coalesced request remains an alias after completion.
do $assert$
declare
  v_original uuid;
  v_alias uuid;
begin
  select job_id into v_original from m2_jobs
   where request_key = '00000000-0000-0000-0000-000000002011'::uuid;
  select r.job_id into v_alias
    from app.request_owned_snapshot('00000000-0000-0000-0000-000000002012'::uuid, 'interactive') as r;
  if v_alias is distinct from v_original then raise exception 'completed alias created a new job'; end if;
end
$assert$;

-- Cross-account tenant reads and stored-profile verification rules.
select set_config('app.account_id', (select id::text from m2_accounts where fixture_key = 'two'), true);
do $assert$
declare
  v_count integer;
  v_status text;
begin
  select count(*) into v_count from app.library_games
   where account_id = (select id from m2_accounts where fixture_key = 'one');
  if v_count <> 0 then raise exception 'cross-account library rows leaked'; end if;
  select status into v_status from app.get_owned_snapshot_status(
    (select job_id from m2_jobs where request_key = '00000000-0000-0000-0000-000000002011'::uuid)
  );
  if v_status is not null then raise exception 'cross-account job status leaked'; end if;
end
$assert$;

select set_config('app.account_id', (select id::text from m2_accounts where fixture_key = 'three'), true);
do $assert$
begin
  if (select status from app.request_owned_snapshot('00000000-0000-0000-0000-000000002013'::uuid, 'interactive'))
       is distinct from 'active_profile_required' then
    raise exception 'steam account with unverified profile was authorized';
  end if;
end
$assert$;

-- A missing fixture GUC fails closed. An explicit fixture opt-in permits only
-- the quota-only pre-session lookup wrapper; it cannot name a job or game.
select set_config('app.account_id', '', true);
reset app.m2_fixture;
do $assert$
declare
  v_block text;
begin
  select block_code into v_block from app.consume_provider_attempt(
    'profile', 1, '00000000-0000-0000-0000-000000002014'::uuid, 120
  );
  if v_block is distinct from 'fixture_not_enabled' then
    raise exception 'missing fixture GUC did not fail closed';
  end if;
end
$assert$;
select set_config('app.m2_fixture', 'off', true);
do $assert$
declare
  v_block text;
begin
  select block_code into v_block from app.consume_provider_attempt(
    'profile', 1, '00000000-0000-0000-0000-000000002014'::uuid, 120
  );
  if v_block is distinct from 'fixture_not_enabled' then
    raise exception 'off fixture GUC did not fail closed';
  end if;
end
$assert$;
select set_config('app.m2_fixture', 'on', true);

create temp table m2_pre_attempt (
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
) on commit drop;
insert into m2_pre_attempt select * from app.consume_provider_attempt(
  'profile', 1, '00000000-0000-0000-0000-000000002014'::uuid, 120
);
do $assert$
declare
  a m2_pre_attempt%rowtype;
begin
  select * into a from m2_pre_attempt;
  if not a.allowed or a.attempt_token is null or a.account_id is not null then
    raise exception 'pre-session profile quota wrapper did not remain tenantless';
  end if;
end
$assert$;

create temp table m2_pre_replay (like m2_pre_attempt) on commit drop;
insert into m2_pre_replay select * from app.consume_provider_attempt(
  'profile', 1, '00000000-0000-0000-0000-000000002014'::uuid, 120
);
do $assert$
declare
  a m2_pre_replay%rowtype;
begin
  select * into a from m2_pre_replay;
  if a.allowed or a.block_code <> 'attempt_already_charged' or a.attempt_token is not null then
    raise exception 'duplicate attempt UUID authorized a second HTTP call';
  end if;
end
$assert$;

select set_config('app.account_id', (select id::text from m2_accounts where fixture_key = 'two'), true);
do $assert$
declare
  v_block text;
begin
  select block_code into v_block from app.consume_provider_attempt(
    'profile', 1, null::uuid, 120
  );
  if v_block is distinct from 'pre_session_only' then
    raise exception 'authenticated quota wrapper authorized a fresh pre-session call';
  end if;
end
$assert$;
do $assert$
declare
  v_block text;
begin
  select block_code into v_block from app.consume_provider_attempt(
    'profile', 1, '00000000-0000-0000-0000-000000002014'::uuid, 120
  );
  if v_block is distinct from 'attempt_context_mismatch' then
    raise exception 'attempt replay was not bound to its original tenant context';
  end if;
end
$assert$;
select set_config('app.account_id', '', true);
do $assert$
declare
  v_block text;
begin
  select block_code into v_block from app.consume_provider_attempt(
    'vanity', 1, '00000000-0000-0000-0000-000000002014'::uuid, 120
  );
  if v_block is distinct from 'attempt_context_mismatch' then
    raise exception 'attempt endpoint replay was not rejected';
  end if;
end
$assert$;

-- Interactive debits global capacity only. Background token/counter values
-- are sampled around an actual interactive call and must not decrease.
reset role;
update ops.provider_token_buckets
   set tokens = 20, last_refilled_at = clock_timestamp(), updated_at = clock_timestamp()
 where provider = 'steam' and bucket_scope = 'background';
update ops.provider_quota_daily
   set charged_units = 0, updated_at = clock_timestamp()
 where provider = 'steam' and usage_date = (clock_timestamp() at time zone 'UTC')::date
   and lane_scope = 'background';
create temp table m2_background_before as
select tokens, (select charged_units from ops.provider_quota_daily
  where provider = 'steam' and usage_date = (clock_timestamp() at time zone 'UTC')::date
    and lane_scope = 'background') as charged_units
  from ops.provider_token_buckets
 where provider = 'steam' and bucket_scope = 'background';
set local role vault_app;
select set_config('app.account_id', '', true);
insert into m2_pre_attempt select * from app.consume_provider_attempt(
  'profile', 1, '00000000-0000-0000-0000-000000002015'::uuid, 120
);
reset role;
create temp table m2_background_after as
select tokens, (select charged_units from ops.provider_quota_daily
  where provider = 'steam' and usage_date = (clock_timestamp() at time zone 'UTC')::date
    and lane_scope = 'background') as charged_units
  from ops.provider_token_buckets
 where provider = 'steam' and bucket_scope = 'background';
do $assert$
declare
  before_row record;
  after_row record;
begin
  select * into before_row from m2_background_before;
  select * into after_row from m2_background_after;
  if after_row.tokens < before_row.tokens or after_row.charged_units <> before_row.charged_units then
    raise exception 'interactive quota consumed the background bucket';
  end if;
end
$assert$;

-- Runtime roles have only their wrapper surface. Direct ops reads and the
-- generic worker helper are denied to vault_app, while the marker remains the
-- only narrow environment read.
set local role vault_app;
select set_config('app.account_id', '', true);
do $assert$
declare
  saw_denied boolean := false;
  v_project text;
begin
  begin
    execute 'select count(*) from ops.jobs';
    raise exception 'vault_app can read private ops.jobs';
  exception when insufficient_privilege then
    saw_denied := true;
  end;
  if not saw_denied then raise exception 'ops table ACL is too broad'; end if;
  saw_denied := false;
  begin
    execute $$select count(*) from ops.consume_provider_attempt('profile', null, null, 1, null, 120)$$;
    raise exception 'vault_app can call the worker charge helper';
  exception when insufficient_privilege then
    saw_denied := true;
  end;
  if not saw_denied then raise exception 'worker charge function ACL is too broad'; end if;
  select project_name into v_project from app.read_project_marker();
  if v_project <> 'VaultShuffle2' then raise exception 'marker helper is not readable'; end if;
end
$assert$;

set local role vault_worker;
select set_config('app.account_id', '', true);
do $assert$
declare
  saw_denied boolean := false;
begin
  begin
    execute 'select count(*) from ops.jobs';
    raise exception 'vault_worker can read private ops.jobs';
  exception when insufficient_privilege then
    saw_denied := true;
  end;
  if not saw_denied then raise exception 'worker ops table ACL is too broad'; end if;
  saw_denied := false;
  begin
    execute $$select count(*) from ops.consume_provider_attempt('profile', null, null, 1, null, 120)$$;
    raise exception 'vault_worker can call the raw charge helper';
  exception when insufficient_privilege then
    saw_denied := true;
  end;
  if not saw_denied then raise exception 'worker raw charge helper ACL is too broad'; end if;
  saw_denied := false;
  begin
    execute $$select * from pgmq.list_queues()$$;
    raise exception 'vault_worker can call PGMQ directly';
  exception when insufficient_privilege then
    saw_denied := true;
  end;
  if not saw_denied then raise exception 'PGMQ direct ACL is too broad'; end if;
end
$assert$;

-- A newly-created disposable function has no implicit PUBLIC execute grant.
reset role;
create function app.m2_fixture_default_acl() returns integer
language sql set search_path = pg_catalog as $$ select 1 $$;
do $assert$
begin
  if has_function_privilege('public', 'app.m2_fixture_default_acl()', 'EXECUTE') then
    raise exception 'new private function inherited PUBLIC EXECUTE';
  end if;
  if has_function_privilege('vault_app', 'app.m2_fixture_default_acl()', 'EXECUTE')
     or has_function_privilege('vault_worker', 'app.m2_fixture_default_acl()', 'EXECUTE') then
    raise exception 'new private function inherited runtime EXECUTE';
  end if;
end
$assert$;
drop function app.m2_fixture_default_acl();
reset role;

-- Forced-RLS state is present on every M2 private relation, and the marker
-- remains the M1 schema marker until a later explicit marker migration.
do $assert$
declare
  v_count integer;
begin
  select count(*) into v_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relkind = 'r'
     and c.relname in ('provider_controls', 'jobs', 'job_requests',
       'provider_quota_daily', 'provider_token_buckets',
       'provider_call_charges', 'enrichment_outbox')
     and c.relrowsecurity and c.relforcerowsecurity;
  if v_count <> 7 then raise exception 'M2 ops relations are not all forced RLS'; end if;
end
$assert$;

rollback;
