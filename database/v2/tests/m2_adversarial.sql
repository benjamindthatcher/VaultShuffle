-- VaultShuffle v2 M2 adversarial/fence fixture.
--
-- One rollback-only transaction.  It uses no psql variables, no TRUNCATE, and
-- no blanket cleanup.  The synthetic accounts, jobs, queue messages, quota
-- rows, and temporary SET ROLE memberships disappear together at ROLLBACK.
-- Run after the M1+M2 migrations on a disposable PG17 rehearsal database.

begin;
set local app.m2_fixture = 'on';

update ops.provider_controls
   set mode = 'fixture', reason = 'M2 adversarial rollback fixture',
       updated_at = clock_timestamp()
 where provider = 'steam';

create temp table m2_adv_accounts (
  fixture_key text primary key,
  id integer not null
) on commit drop;

with input(fixture_key, public_id, display_name, steam_id) as materialized (
  values
    ('lease', '00000000-0000-0000-0000-000000003001'::uuid,
      'M2 Lease Fixture', 76561198000003001::bigint),
    ('old_pin', '00000000-0000-0000-0000-000000003002'::uuid,
      'M2 Old Pin Fixture', 76561198000003002::bigint),
    ('new_pin', '00000000-0000-0000-0000-000000003003'::uuid,
      'M2 New Pin Fixture', 76561198000003003::bigint)
), inserted as (
  insert into app.accounts(public_id, account_kind, display_name)
  select public_id, 'manual', display_name from input
  returning id, public_id
)
insert into m2_adv_accounts(fixture_key, id)
select input.fixture_key, inserted.id
  from input join inserted using (public_id);

insert into app.steam_profiles(account_id, steam_id, verified, display_name)
select a.id, input.steam_id, false, input.display_name
  from m2_adv_accounts as a
  join (values
    ('lease', 76561198000003001::bigint, 'M2 Lease Fixture'::text),
    ('old_pin', 76561198000003002::bigint, 'M2 Old Pin Fixture'::text),
    ('new_pin', 76561198000003003::bigint, 'M2 New Pin Fixture'::text)
  ) as input(fixture_key, steam_id, display_name)
    on input.fixture_key = a.fixture_key;

create temp table m2_adv_games (
  fixture_key text primary key,
  id integer not null,
  steam_app_id bigint not null
) on commit drop;
with input(fixture_key, steam_app_id, title) as materialized (
  values
    ('old_pin', 3002::bigint, 'M2 Old Pin Game'),
    ('new_pin', 3003::bigint, 'M2 New Pin Game')
), inserted as (
  insert into catalog.games(steam_app_id, title, normalized_sort_title)
  select steam_app_id, title, lower(title) from input
  returning id, steam_app_id
)
insert into m2_adv_games(fixture_key, id, steam_app_id)
select input.fixture_key, inserted.id, inserted.steam_app_id
  from input join inserted using (steam_app_id);

insert into app.library_games(account_id, game_id, playtime_minutes)
values
  ((select id from m2_adv_accounts where fixture_key = 'old_pin'),
   (select id from m2_adv_games where fixture_key = 'old_pin'), 20),
  ((select id from m2_adv_accounts where fixture_key = 'new_pin'),
   (select id from m2_adv_games where fixture_key = 'new_pin'), 30);

insert into app.pins(account_id, scope, slot, game_id, personal_minutes_baseline)
values
  ((select id from m2_adv_accounts where fixture_key = 'old_pin'), 'library', 1,
   (select id from m2_adv_games where fixture_key = 'old_pin'), 20),
  ((select id from m2_adv_accounts where fixture_key = 'new_pin'), 'library', 1,
   (select id from m2_adv_games where fixture_key = 'new_pin'), 30);

-- The test operator receives only transaction-scoped SET ROLE membership.
do $$
begin
  execute format('grant vault_app, vault_worker to %I with set true', current_user);
end
$$;

create temp table m2_adv_request (
  job_id uuid,
  status text,
  generation bigint,
  coalesced boolean,
  quota_retry_at timestamptz
) on commit drop;
create temp table m2_adv_claim (
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
create temp table m2_adv_retry (
  status text,
  retry_at timestamptz,
  attempt integer,
  acknowledged boolean
) on commit drop;
create temp table m2_adv_pinned (
  allowed boolean,
  block_code text,
  attempt_id uuid,
  attempt_token uuid,
  provider_subject bigint,
  provider_mode text,
  fetch_started_at timestamptz,
  expires_at timestamptz,
  retry_at timestamptz
) on commit drop;
create temp table m2_adv_publish (
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
create temp table m2_adv_initial_claim (
  job_id uuid,
  message_id bigint,
  lease_token uuid,
  attempt_id uuid,
  attempt_token uuid
) on commit drop;
create temp table m2_adv_zero_pinned (
  allowed boolean,
  block_code text,
  attempt_id uuid,
  attempt_token uuid,
  provider_subject bigint,
  provider_mode text,
  fetch_started_at timestamptz,
  expires_at timestamptz,
  retry_at timestamptz
) on commit drop;
create temp table m2_adv_cap_account (
  id integer not null
) on commit drop;
grant all on m2_adv_accounts, m2_adv_games, m2_adv_request, m2_adv_claim,
  m2_adv_retry, m2_adv_pinned, m2_adv_publish, m2_adv_initial_claim,
  m2_adv_zero_pinned, m2_adv_cap_account
  to vault_app, vault_worker, postgres;

-- The provider uses zero as "not played". The normalized SQL boundary only
-- accepts a positive known epoch; zero must be represented as null instead.
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'old_pin'), true);
insert into m2_adv_zero_pinned
select * from app.begin_pinned_owned_refresh(
  (select id from m2_adv_games where fixture_key = 'old_pin')
);
do $assert$
declare
  r record;
begin
  select * into r from app.record_pinned_owned_observation(
    (select attempt_id from m2_adv_zero_pinned),
    (select attempt_token from m2_adv_zero_pinned),
    jsonb_build_object('status','complete','provider','steam','appId','3002',
      'playtimeMinutes',20,'lastPlayedAtEpochSeconds',0,
      'lastPlayedSource','steam.rtime_last_played')
  );
  if r.accepted then
    raise exception 'pinned zero last-played epoch was accepted as known time';
  end if;
end
$assert$;
reset role;

-- J1: an expired leased/fetching job is reclaimable, and the old token is
-- fenced from every mutation surface after the replacement claim.
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'lease'), true);
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003101'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
insert into m2_adv_initial_claim
select job_id, message_id, lease_token, attempt_id, attempt_token
  from m2_adv_claim where claimed;

do $assert$
declare
  c m2_adv_claim%rowtype;
begin
  select * into c from m2_adv_claim where claimed;
  if not found or c.job_id is null or c.lease_token is null
     or c.attempt_id is null or c.attempt_token is null then
    raise exception 'initial lease fixture did not claim a job';
  end if;
end
$assert$;

reset role;
do $assert$
declare
  c m2_adv_claim%rowtype;
begin
  select * into c from m2_adv_claim where claimed;
  update ops.jobs
     set lease_expires_at = clock_timestamp() - interval '1 second'
   where id = c.job_id;
  perform pgmq.set_vt('vault_interactive', c.message_id, 0);
end
$assert$;

set local role vault_worker;
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);

reset role;
do $assert$
declare
  new_claim m2_adv_claim%rowtype;
begin
  select * into new_claim from m2_adv_claim where claimed;
  if not found or new_claim.attempt <> 2 or new_claim.lease_token is null then
    raise exception 'expired lease was not reclaimed with a fresh attempt';
  end if;
  if new_claim.attempt_token is null then raise exception 'reclaim has no attempt token'; end if;
  if not exists (
    select 1 from ops.provider_call_charges as c
     where c.job_id = new_claim.job_id and c.attempt_id = new_claim.attempt_id
       and c.status = 'charged'
  ) then raise exception 'replacement attempt was not charged'; end if;
end
$assert$;

set local role vault_worker;

-- Recover the original token from the expired charge's job-independent ledger.
create temp table m2_adv_old_lease as
select c.job_id, c.message_id, c.attempt_id, c.lease_token as old_lease_token,
       c.attempt_token as old_attempt_token
  from m2_adv_initial_claim as c
 limit 1;

do $assert$
declare
  old_row m2_adv_old_lease%rowtype;
  new_claim m2_adv_claim%rowtype;
  r record;
begin
  select * into old_row from m2_adv_old_lease;
  select * into new_claim from m2_adv_claim where claimed;
  select result into r from ops.publish_owned_snapshot(
    old_row.job_id, old_row.old_lease_token,
    '{}'::jsonb, null, null, null, old_row.message_id
  );
  if r.result is distinct from 'stale' then
    raise exception 'old lease token was accepted by publish';
  end if;
  select ok into r from ops.renew_job_lease(old_row.job_id, old_row.old_lease_token, 120);
  if r.ok then
    raise exception 'old lease token renewed the replacement lease';
  end if;
  select * into r from ops.retry_job(
    old_row.job_id, old_row.old_lease_token, 'old_worker',
    'old worker must be fenced', null, 'retryable', old_row.message_id
  );
  if r.status is distinct from 'stale' then
    raise exception 'old lease token retried the replacement job';
  end if;
end
$assert$;

reset role;
do $assert$
declare
  old_row m2_adv_old_lease%rowtype;
  new_claim m2_adv_claim%rowtype;
begin
  select * into old_row from m2_adv_old_lease;
  select * into new_claim from m2_adv_claim where claimed;
  if not exists (
    select 1 from ops.provider_call_charges as c
     where c.job_id = new_claim.job_id and c.attempt_id = new_claim.attempt_id
       and c.status = 'charged'
  ) then raise exception 'replacement attempt was not charged'; end if;
  if not exists (
    select 1 from ops.jobs as j
     where j.id = old_row.job_id and j.lease_token = new_claim.lease_token
       and j.status = 'fetching' and j.attempt = 2
  ) then raise exception 'old lease changed replacement job state'; end if;
end
$assert$;

-- Finish the replacement attempt so later queue tests can use the same
-- synthetic account without leaving an active-job conflict.
delete from m2_adv_retry;
insert into m2_adv_retry
select * from ops.retry_job(
    (select job_id from m2_adv_claim where claimed),
    (select lease_token from m2_adv_claim where claimed),
    'cleanup', 'end J1 fixture', null, 'non_retryable',
    (select message_id from m2_adv_claim where claimed)
  );
do $assert$
begin
  if (select status from m2_adv_retry) is distinct from 'non_retryable'
     or not (select acknowledged from m2_adv_retry) then
    raise exception 'replacement lease cleanup did not ACK terminal job';
  end if;
end
$assert$;

-- J2: deferred provider delay acknowledges the current message and does not
-- turn into an automatic short retry.
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'lease'), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003102'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
delete from m2_adv_retry;
insert into m2_adv_retry
select * from ops.retry_job(
  (select job_id from m2_adv_claim where claimed),
  (select lease_token from m2_adv_claim where claimed),
  'provider_retry_after', 'provider requested operator review',
  clock_timestamp() + interval '2 days', 'deferred',
  (select message_id from m2_adv_claim where claimed)
);
reset role;
do $assert$
declare
  r record;
begin
  if (select status from m2_adv_retry) is distinct from 'deferred'
     or not (select acknowledged from m2_adv_retry) then
    raise exception 'deferred retry was not acknowledged';
  end if;
  if (select retry_policy from ops.jobs where id = (select job_id from m2_adv_request))
       is distinct from 'deferred' then
    raise exception 'deferred retry policy was not retained';
  end if;
  select * into r from ops.enqueue_job((select job_id from m2_adv_request));
  if r.message_id is not null then raise exception 'deferred job was re-enqueued'; end if;
  delete from m2_adv_claim;
  insert into m2_adv_claim select * from ops.claim_job('interactive', 120);
  if (select block_code from m2_adv_claim limit 1) is distinct from 'no_message' then
    raise exception 'deferred message remained claimable';
  end if;
end
$assert$;

-- Use the same account again only after this synthetic deferred row is made
-- terminal by the fixture owner.  The deferred policy itself was asserted
-- above and remains non-requeueable.
update ops.jobs
   set status = 'failed', retry_policy = 'non_retryable',
       completed_at = clock_timestamp(), updated_at = clock_timestamp()
 where id = (select job_id from m2_adv_request);

-- J3: a wrong message ID cannot mutate visibility, retry state, or terminal
-- acknowledgement, even with a current lease token.
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'lease'), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003103'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  r record;
  c m2_adv_claim%rowtype;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.retry_job(
    c.job_id, c.lease_token, 'wrong_message', 'should be rejected', null,
    'retryable', c.message_id + 999999
  );
  if r.status is distinct from 'stale' then raise exception 'wrong message retry was accepted'; end if;
  if ops.ack_job(c.job_id, c.lease_token, c.message_id + 999999) then
    raise exception 'wrong message ACK was accepted';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  c m2_adv_claim%rowtype;
begin
  select * into c from m2_adv_claim where claimed;
  if not exists (
    select 1 from ops.jobs as j
     where j.id = c.job_id and j.status = 'fetching'
       and j.lease_token = c.lease_token and j.message_id = c.message_id
  ) then raise exception 'wrong message changed job lease state'; end if;
end
$assert$;
delete from m2_adv_retry;
insert into m2_adv_retry
select *
  from ops.retry_job(
    (select job_id from m2_adv_claim where claimed),
    (select lease_token from m2_adv_claim where claimed),
    'cleanup', 'end J3 fixture', null, 'non_retryable',
    (select message_id from m2_adv_claim where claimed)
  );

-- S1/S2: provider-private and malformed outcomes commit as the accepted
-- `applied` protocol result while retaining an independently typed terminal
-- job outcome.  A response-loss replay returns the exact stored summary and
-- cannot turn either outcome into a second fetch.
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'lease'), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003106'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
  replay record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','unavailable','provider','steam',
      'reason','private','detail','profile is private'),
    null, null, null, c.message_id
  );
  if r.result is distinct from 'applied' or r.acknowledged is not true then
    raise exception 'private provider outcome did not commit as applied';
  end if;
  select * into replay from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','unavailable','provider','steam',
      'reason','private','detail','profile is private'),
    null, null, null, c.message_id
  );
  if replay.result is distinct from 'already_applied'
     or replay.job_id is distinct from r.job_id
     or replay.account_id is distinct from r.account_id
     or replay.applied_generation is distinct from r.applied_generation
     or replay.snapshot_hash is not null
     or replay.observed_count is not null
     or replay.acknowledged is not true then
    raise exception 'private response-loss replay did not return the stored summary';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  v_job uuid;
begin
  select job_id into v_job from m2_adv_request;
  if (select status from ops.jobs where id = v_job) is distinct from 'unavailable'
     or (select result_code from ops.jobs where id = v_job) is distinct from 'private' then
    raise exception 'private outcome did not retain its typed terminal job status';
  end if;
end
$assert$;

set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'lease'), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003107'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','invalid','provider','steam',
      'reason','malformed','detail','fixture payload rejected'),
    null, null, null, c.message_id
  );
  if r.result is distinct from 'applied' or r.acknowledged is not true then
    raise exception 'invalid provider outcome did not commit as applied';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  v_job uuid;
begin
  select job_id into v_job from m2_adv_request;
  if (select status from ops.jobs where id = v_job) is distinct from 'invalid'
     or (select result_code from ops.jobs where id = v_job) is distinct from 'malformed' then
    raise exception 'invalid outcome did not retain its typed terminal job status';
  end if;
end
$assert$;

-- P1/P2: manual unverified profiles are valid for public-library reads.  A
-- pinned attempt started before a newer full authority cannot recreate access.
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'old_pin'), true);
delete from m2_adv_pinned;
insert into m2_adv_pinned
select * from app.begin_pinned_owned_refresh(
  (select id from m2_adv_games where fixture_key = 'old_pin')
);
do $assert$
begin
  if not (select allowed from m2_adv_pinned)
     or (select provider_subject from m2_adv_pinned) <> 76561198000003002 then
    raise exception 'manual unverified profile could not start pinned read';
  end if;
end
$assert$;
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003104'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);

do $assert$
declare
  c m2_adv_claim%rowtype;
  v_canonical constant text := '{"provider":"steam","protocolVersion":1,"gameCount":0,"games":[]}';
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','complete','provider','steam','protocolVersion',1,
      'scope','complete_owned','includeAppInfo',true,
      'includePlayedFreeGames',true,'skipUnvettedApps',false,'httpStatus',200,
      'gameCount',0,'bodyBytes',octet_length(convert_to(v_canonical,'UTF8'))),
    v_canonical, sha256(convert_to(v_canonical,'UTF8')), clock_timestamp(), c.message_id
  );
  if r.result is distinct from 'applied' or r.observed_count <> 0 then
    raise exception 'newer full authority did not apply empty snapshot';
  end if;
end
$assert$;

set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'old_pin'), true);
do $assert$
declare
  r record;
begin
  select * into r from app.record_pinned_owned_observation(
    (select attempt_id from m2_adv_pinned),
    (select attempt_token from m2_adv_pinned),
    jsonb_build_object('status','complete','provider','steam','appId','3002',
      'playtimeMinutes',20,'lastPlayedAtEpochSeconds',null,
      'lastPlayedSource','not_provided')
  );
  if r.accepted then raise exception 'old pinned observation revived removed access'; end if;
  if exists (select 1 from app.library_games
      where account_id = (select id from m2_adv_accounts where fixture_key = 'old_pin')
        and game_id = (select id from m2_adv_games where fixture_key = 'old_pin')) then
    raise exception 'old pinned rejection recreated library access';
  end if;
end
$assert$;

-- P2/P3: a newer valid pinned confirmation, including null/null measurements,
-- is a sparse freshness fence and defers an older full sweep.  The personal
-- row and its library pin remain playable.
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'new_pin'), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003105'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'new_pin'), true);
delete from m2_adv_pinned;
insert into m2_adv_pinned
select * from app.begin_pinned_owned_refresh(
  (select id from m2_adv_games where fixture_key = 'new_pin')
);
do $assert$
declare
  r record;
begin
  select * into r from app.record_pinned_owned_observation(
    (select attempt_id from m2_adv_pinned),
    (select attempt_token from m2_adv_pinned),
    jsonb_build_object('status','complete','provider','steam','appId','3003',
      'playtimeMinutes',null,'lastPlayedAtEpochSeconds',null,
      'lastPlayedSource','not_provided')
  );
  if not r.accepted then
    raise exception 'null/null pinned confirmation was not accepted as sparse evidence';
  end if;
  if r.minutes is distinct from 30 then
    raise exception 'null/null pin did not preserve greatest known minutes';
  end if;
end
$assert$;
set local role vault_worker;
select set_config('app.account_id', '', true);
do $assert$
declare
  c m2_adv_claim%rowtype;
  v_canonical constant text := '{"provider":"steam","protocolVersion":1,"gameCount":0,"games":[]}';
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','complete','provider','steam','protocolVersion',1,
      'scope','complete_owned','includeAppInfo',true,
      'includePlayedFreeGames',true,'skipUnvettedApps',false,'httpStatus',200,
      'gameCount',0,'bodyBytes',octet_length(convert_to(v_canonical,'UTF8'))),
    v_canonical, sha256(convert_to(v_canonical,'UTF8')), clock_timestamp(), c.message_id
  );
  if r.result is distinct from 'applied' or r.sweep_deferred_count < 1 then
    raise exception 'newer pinned fence did not defer full removal';
  end if;
end
$assert$;
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'new_pin'), true);
do $assert$
begin
  if not exists (select 1 from app.library_games
      where account_id = (select id from m2_adv_accounts where fixture_key = 'new_pin')
        and game_id = (select id from m2_adv_games where fixture_key = 'new_pin')) then
    raise exception 'newer pinned confirmation did not preserve personal access';
  end if;
  if not exists (select 1 from app.pins
      where account_id = (select id from m2_adv_accounts where fixture_key = 'new_pin')
        and scope = 'library' and game_id = (select id from m2_adv_games where fixture_key = 'new_pin')) then
    raise exception 'newer pinned confirmation did not preserve library pin';
  end if;
  if not exists (select 1 from app.library_observation_fences
      where account_id = (select id from m2_adv_accounts where fixture_key = 'new_pin')
        and game_id = (select id from m2_adv_games where fixture_key = 'new_pin')) then
    raise exception 'sparse pinned fence was not retained';
  end if;
end
$assert$;

-- Q3/S3: a job is stale when the sync generation is either newer or older
-- than the job, and a changed active profile fences renew/retry as well as
-- publish.  These calls are all read/reject paths; the enclosing rollback
-- removes the intentionally mismatched fixtures.
set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'lease'), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003108'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
reset role;
update app.library_sync_state
   set generation = generation + 1, updated_at = clock_timestamp()
 where account_id = (select id from m2_adv_accounts where fixture_key = 'lease');
set local role vault_worker;
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token, null, null, null, null, c.message_id
  );
  if r.result is distinct from 'stale' then
    raise exception 'publish accepted a newer sync generation';
  end if;
  select * into r from ops.renew_job_lease(c.job_id, c.lease_token, 120);
  if r.ok then raise exception 'renew accepted a newer sync generation'; end if;
  select * into r from ops.retry_job(
    c.job_id, c.lease_token, 'generation_race', 'must be fenced', null,
    'retryable', c.message_id
  );
  if r.status is distinct from 'stale' then
    raise exception 'retry accepted a newer sync generation';
  end if;
end
$assert$;

reset role;
update app.library_sync_state
   set generation = generation - 2, updated_at = clock_timestamp()
 where account_id = (select id from m2_adv_accounts where fixture_key = 'lease');
set local role vault_worker;
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token, null, null, null, null, c.message_id
  );
  if r.result is distinct from 'stale' then
    raise exception 'publish accepted an older sync generation';
  end if;
end
$assert$;

set local role vault_app;
select set_config('app.account_id',
  (select id::text from m2_adv_accounts where fixture_key = 'new_pin'), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003109'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
reset role;
update app.steam_profiles
   set steam_id = steam_id + 1000, updated_at = clock_timestamp()
 where account_id = (select id from m2_adv_accounts where fixture_key = 'new_pin');
set local role vault_worker;
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.renew_job_lease(c.job_id, c.lease_token, 120);
  if r.ok then raise exception 'renew accepted a changed active profile'; end if;
  select * into r from ops.retry_job(
    c.job_id, c.lease_token, 'profile_race', 'must be fenced', null,
    'retryable', c.message_id
  );
  if r.status is distinct from 'stale' then
    raise exception 'retry accepted a changed active profile';
  end if;
end
$assert$;

-- S4 capability evidence: a complete zero and an all-null snapshot expose
-- library access while leaving field capabilities unknown. A positive-valued
-- snapshot makes those fields visible; private hides the library without
-- deleting facts, and transient provider/invalid outcomes preserve the known
-- visibility. The same account exercises every transition.
reset role;
with inserted as (
  insert into app.accounts(
    public_id, account_kind, display_name
  ) values (
    '00000000-0000-0000-0000-000000003010'::uuid,
    'manual', 'M2 Capability Fixture'
  )
  returning id
)
insert into m2_adv_cap_account(id)
select id from inserted;
insert into app.steam_profiles(account_id, steam_id, verified, display_name)
select id, 76561198000003010, false, 'M2 Capability Fixture'
  from m2_adv_cap_account;
insert into catalog.games(steam_app_id, title, normalized_sort_title)
values (3004, 'M2 Capability Game', 'm2 capability game');

-- A complete zero is explicit evidence of a visible library, not evidence
-- that playtime or last-played fields are available.
set local role vault_app;
select set_config('app.account_id', (select id::text from m2_adv_cap_account), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003110'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
  v_canonical constant text := '{"provider":"steam","protocolVersion":1,"gameCount":0,"games":[]}';
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','complete','provider','steam','protocolVersion',1,
      'scope','complete_owned','includeAppInfo',true,
      'includePlayedFreeGames',true,'skipUnvettedApps',false,'httpStatus',200,
      'gameCount',0,'bodyBytes',octet_length(convert_to(v_canonical,'UTF8'))),
    v_canonical, sha256(convert_to(v_canonical,'UTF8')), clock_timestamp(), c.message_id
  );
  if r.result is distinct from 'applied' or r.observed_count <> 0 then
    raise exception 'complete zero snapshot did not apply';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  r record;
begin
  select * into r from app.account_capabilities
   where account_id = (select id from m2_adv_cap_account);
  if r.library_visibility is distinct from 'visible'
     or r.playtime_visibility is distinct from 'unknown'
     or r.last_played_visibility is distinct from 'unknown'
     or r.status is distinct from 'ok' then
    raise exception 'complete zero capability state is incorrect';
  end if;
end
$assert$;

-- An all-null game row keeps field capabilities unknown as well.
set local role vault_app;
select set_config('app.account_id', (select id::text from m2_adv_cap_account), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003111'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
  v_canonical constant text := '{"provider":"steam","protocolVersion":1,"gameCount":1,"games":[{"appId":"3004","playtimeMinutes":null,"name":"M2 Capability Game","nameSource":"steam.name","lastPlayedAtEpochSeconds":null,"lastPlayedSource":"not_provided"}]}';
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','complete','provider','steam','protocolVersion',1,
      'scope','complete_owned','includeAppInfo',true,
      'includePlayedFreeGames',true,'skipUnvettedApps',false,'httpStatus',200,
      'gameCount',1,'bodyBytes',octet_length(convert_to(v_canonical,'UTF8'))),
    v_canonical, sha256(convert_to(v_canonical,'UTF8')), clock_timestamp(), c.message_id
  );
  if r.result is distinct from 'applied' or r.observed_count <> 1 then
    raise exception 'all-null complete snapshot did not apply';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  r record;
begin
  select * into r from app.account_capabilities
   where account_id = (select id from m2_adv_cap_account);
  if r.library_visibility is distinct from 'visible'
     or r.playtime_visibility is distinct from 'unknown'
     or r.last_played_visibility is distinct from 'unknown' then
    raise exception 'all-null capability state is incorrect';
  end if;
end
$assert$;

-- A zero known epoch is rejected in full publication. The lease survives the
-- subtransaction and the same job then accepts the positive known timestamp.
set local role vault_app;
select set_config('app.account_id', (select id::text from m2_adv_cap_account), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003112'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
  saw_invalid boolean := false;
  v_zero constant text := '{"provider":"steam","protocolVersion":1,"gameCount":1,"games":[{"appId":"3004","playtimeMinutes":10,"name":"M2 Capability Game","nameSource":"steam.name","lastPlayedAtEpochSeconds":0,"lastPlayedSource":"steam.rtime_last_played"}]}';
  v_known constant text := '{"provider":"steam","protocolVersion":1,"gameCount":1,"games":[{"appId":"3004","playtimeMinutes":10,"name":"M2 Capability Game","nameSource":"steam.name","lastPlayedAtEpochSeconds":1700000000,"lastPlayedSource":"steam.rtime_last_played"}]}';
begin
  select * into c from m2_adv_claim where claimed;
  begin
    select * into r from ops.publish_owned_snapshot(
      c.job_id, c.lease_token,
      jsonb_build_object('status','complete','provider','steam','protocolVersion',1,
        'scope','complete_owned','includeAppInfo',true,
        'includePlayedFreeGames',true,'skipUnvettedApps',false,'httpStatus',200,
        'gameCount',1,'bodyBytes',octet_length(convert_to(v_zero,'UTF8'))),
      v_zero, sha256(convert_to(v_zero,'UTF8')), clock_timestamp(), c.message_id
    );
    if found then
      raise exception using errcode = 'P0001', message = 'zero known epoch was accepted';
    end if;
  exception when invalid_parameter_value then
    saw_invalid := true;
  end;
  if not saw_invalid then
    raise exception 'full zero last-played epoch was accepted as known time';
  end if;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','complete','provider','steam','protocolVersion',1,
      'scope','complete_owned','includeAppInfo',true,
      'includePlayedFreeGames',true,'skipUnvettedApps',false,'httpStatus',200,
      'gameCount',1,'bodyBytes',octet_length(convert_to(v_known,'UTF8'))),
    v_known, sha256(convert_to(v_known,'UTF8')), clock_timestamp(), c.message_id
  );
  if r.result is distinct from 'applied' then
    raise exception 'positive known timestamp did not publish after zero rejection';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  r record;
begin
  select * into r from app.account_capabilities
   where account_id = (select id from m2_adv_cap_account);
  if r.library_visibility is distinct from 'visible'
     or r.playtime_visibility is distinct from 'visible'
     or r.last_played_visibility is distinct from 'visible' then
    raise exception 'known complete capability state is incorrect';
  end if;
end
$assert$;

-- Private is an explicit hidden-library result and must retain the personal
-- library fact. The other fields become unknown.
set local role vault_app;
select set_config('app.account_id', (select id::text from m2_adv_cap_account), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003113'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','unavailable','provider','steam',
      'reason','private','detail','capability fixture private'),
    null, null, null, c.message_id
  );
  if r.result is distinct from 'applied' or not r.acknowledged then
    raise exception 'private capability result did not apply';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  r record;
begin
  select * into r from app.account_capabilities
   where account_id = (select id from m2_adv_cap_account);
  if r.library_visibility is distinct from 'hidden'
     or r.playtime_visibility is distinct from 'unknown'
     or r.last_played_visibility is distinct from 'unknown'
     or r.status is distinct from 'private' then
    raise exception 'private capability state is incorrect';
  end if;
  if not exists (
    select 1 from app.library_games
     where account_id = (select id from m2_adv_cap_account)
       and game_id = (select id from catalog.games where steam_app_id = 3004)
       and playtime_minutes = 10
  ) then
    raise exception 'private result erased personal library facts';
  end if;
end
$assert$;

-- Restore known evidence, then ensure provider-error and invalid outcomes do
-- not erase that visibility.
set local role vault_app;
select set_config('app.account_id', (select id::text from m2_adv_cap_account), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003114'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
  v_known constant text := '{"provider":"steam","protocolVersion":1,"gameCount":1,"games":[{"appId":"3004","playtimeMinutes":10,"name":"M2 Capability Game","nameSource":"steam.name","lastPlayedAtEpochSeconds":1700000000,"lastPlayedSource":"steam.rtime_last_played"}]}';
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','complete','provider','steam','protocolVersion',1,
      'scope','complete_owned','includeAppInfo',true,
      'includePlayedFreeGames',true,'skipUnvettedApps',false,'httpStatus',200,
      'gameCount',1,'bodyBytes',octet_length(convert_to(v_known,'UTF8'))),
    v_known, sha256(convert_to(v_known,'UTF8')), clock_timestamp(), c.message_id
  );
  if r.result is distinct from 'applied' then
    raise exception 'known capability restoration did not apply';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  r record;
begin
  select * into r from app.account_capabilities
   where account_id = (select id from m2_adv_cap_account);
  if r.playtime_visibility is distinct from 'visible'
     or r.last_played_visibility is distinct from 'visible' then
    raise exception 'known capability restoration was not visible';
  end if;
end
$assert$;

set local role vault_app;
select set_config('app.account_id', (select id::text from m2_adv_cap_account), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003115'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','unavailable','provider','steam',
      'reason','provider_error','detail','temporary provider failure'),
    null, null, null, c.message_id
  );
  if r.result is distinct from 'applied' then
    raise exception 'provider-error capability result did not apply';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  r record;
begin
  select * into r from app.account_capabilities
   where account_id = (select id from m2_adv_cap_account);
  if r.library_visibility is distinct from 'visible'
     or r.playtime_visibility is distinct from 'visible'
     or r.last_played_visibility is distinct from 'visible'
     or r.status is distinct from 'error' then
    raise exception 'provider-error erased known capability visibility';
  end if;
end
$assert$;

set local role vault_app;
select set_config('app.account_id', (select id::text from m2_adv_cap_account), true);
delete from m2_adv_request;
insert into m2_adv_request
select * from app.request_owned_snapshot(
  '00000000-0000-0000-0000-000000003116'::uuid, 'interactive'
);
set local role vault_worker;
select set_config('app.account_id', '', true);
delete from m2_adv_claim;
insert into m2_adv_claim
select * from ops.claim_job('interactive', 120);
do $assert$
declare
  c m2_adv_claim%rowtype;
  r record;
begin
  select * into c from m2_adv_claim where claimed;
  select * into r from ops.publish_owned_snapshot(
    c.job_id, c.lease_token,
    jsonb_build_object('status','invalid','provider','steam',
      'reason','malformed','detail','temporary normalization failure'),
    null, null, null, c.message_id
  );
  if r.result is distinct from 'applied' then
    raise exception 'invalid capability result did not apply';
  end if;
end
$assert$;
reset role;
do $assert$
declare
  r record;
begin
  select * into r from app.account_capabilities
   where account_id = (select id from m2_adv_cap_account);
  if r.library_visibility is distinct from 'visible'
     or r.playtime_visibility is distinct from 'visible'
     or r.last_played_visibility is distinct from 'visible'
     or r.status is distinct from 'error' then
    raise exception 'invalid result erased known capability visibility';
  end if;
end
$assert$;

rollback;
