-- M1 executable assertion fixture for a disposable PostgreSQL 17 database.
--
-- This is intentionally pure SQL: it uses one transaction, temporary lookup
-- tables, and transaction-local fixture settings, so it can run through psql
-- or a management execute-sql endpoint without psql metacommands. No existing
-- rows are truncated or deleted; the final rollback removes every fixture row.
-- Run with psql -X -v ON_ERROR_STOP=1 -f database/v2/tests/m1.sql.

begin;

-- The migration owner may have ADMIN on newly-created group roles without the
-- PG17 SET membership option. These test-only grants are transactional and
-- roll back with the fixture; production role membership is provisioned out
-- of band.
grant vault_app to current_user with set true;
grant vault_worker to current_user with set true;

create temp table m1_accounts (
  fixture_key text primary key,
  id integer not null,
  public_id uuid not null
) on commit drop;

with input(fixture_key, public_id, account_kind, display_name) as materialized (
  values
    ('account1', gen_random_uuid(), 'manual', 'Manual One'),
    ('account2', gen_random_uuid(), 'steam', 'Steam Two'),
    ('account3', gen_random_uuid(), 'manual', 'Manual Three')
), inserted as (
  insert into app.accounts (public_id, account_kind, display_name)
  select public_id, account_kind, display_name from input
  returning id, public_id
)
insert into m1_accounts (fixture_key, id, public_id)
select input.fixture_key, inserted.id, inserted.public_id
  from input
  join inserted using (public_id);

insert into app.steam_profiles (
  account_id, steam_id, verified, display_name, steam_display_name
)
select id, steam_id, verified, display_name, display_name
  from (
    select (select id from m1_accounts where fixture_key = 'account1') as id,
           76561198000000001::bigint as steam_id, false as verified,
           'Manual Steam'::text as display_name
    union all
    select (select id from m1_accounts where fixture_key = 'account2'),
           76561198000000002, true, 'Steam Two'
    union all
    select (select id from m1_accounts where fixture_key = 'account3'),
           76561198000000001, false, 'Duplicate Public'
  ) as profile_rows;

insert into app.account_capabilities (
  account_id, library_visibility, playtime_visibility, last_played_visibility, status
)
select id, 'visible', 'visible', 'visible', 'ok'
  from m1_accounts where fixture_key = 'account1';

insert into app.account_preferences (account_id, version, preferences)
select id, 1, '{"theme":"dark","sessionLength":"evening"}'::jsonb
  from m1_accounts where fixture_key = 'account1';

create temp table m1_sessions (
  fixture_key text primary key,
  id bigint not null,
  account_id integer not null,
  token_digest bytea not null
) on commit drop;

with input(fixture_key, account_id, token_digest, session_kind, created_at, expires_at, revoked_at) as materialized (
  select 'manual', id,
         decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'),
         'manual', now(), now() + interval '1 hour', null::timestamptz
    from m1_accounts where fixture_key = 'account1'
  union all
  select 'verified', id,
         decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'),
         'verified_steam', now(), now() + interval '1 hour', null
    from m1_accounts where fixture_key = 'account2'
  union all
  select 'expired', id,
         decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'),
         'manual', now() - interval '2 hours', now() - interval '1 hour', null
    from m1_accounts where fixture_key = 'account1'
  union all
  select 'revoked', id,
         decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'),
         'manual', now(), now() + interval '1 hour', now()
    from m1_accounts where fixture_key = 'account1'
  union all
  select 'wrong_kind', id,
         decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'),
         'verified_steam', now(), now() + interval '1 hour', null
    from m1_accounts where fixture_key = 'account1'
), inserted as (
  insert into app.sessions (
    account_id, token_digest, session_kind, created_at, expires_at, revoked_at
  )
  select account_id, token_digest, session_kind, created_at, expires_at, revoked_at
    from input
  returning id, account_id, token_digest
)
insert into m1_sessions (fixture_key, id, account_id, token_digest)
select input.fixture_key, inserted.id, inserted.account_id, inserted.token_digest
  from input
  join inserted using (account_id, token_digest);

create temp table m1_games (
  fixture_key text primary key,
  id integer not null
) on commit drop;

with input(fixture_key, title, normalized_sort_title) as materialized (
  values ('game1', 'Fixture Alpha', 'fixture alpha'),
         ('game2', 'Fixture Omega', 'fixture omega')
), inserted as (
  insert into catalog.games (title, normalized_sort_title)
  select title, normalized_sort_title from input
  returning id, title
)
insert into m1_games (fixture_key, id)
select input.fixture_key, inserted.id
  from input
  join inserted on inserted.title = input.title;

-- Make all IDs/digests available to later pure-SQL assertions without relying
-- on psql variable interpolation inside dollar-quoted PL/pgSQL blocks.
select
  set_config('m1.account1_id', (select id::text from m1_accounts where fixture_key = 'account1'), true),
  set_config('m1.account2_id', (select id::text from m1_accounts where fixture_key = 'account2'), true),
  set_config('m1.account3_id', (select id::text from m1_accounts where fixture_key = 'account3'), true),
  set_config('m1.account1_public_id', (select public_id::text from m1_accounts where fixture_key = 'account1'), true),
  set_config('m1.account2_public_id', (select public_id::text from m1_accounts where fixture_key = 'account2'), true),
  set_config('m1.game1_id', (select id::text from m1_games where fixture_key = 'game1'), true),
  set_config('m1.game2_id', (select id::text from m1_games where fixture_key = 'game2'), true),
  set_config('m1.manual_session_id', (select id::text from m1_sessions where fixture_key = 'manual'), true),
  set_config('m1.verified_session_id', (select id::text from m1_sessions where fixture_key = 'verified'), true),
  set_config('m1.manual_digest', (select encode(token_digest, 'hex') from m1_sessions where fixture_key = 'manual'), true),
  set_config('m1.verified_digest', (select encode(token_digest, 'hex') from m1_sessions where fixture_key = 'verified'), true),
  set_config('m1.expired_digest', (select encode(token_digest, 'hex') from m1_sessions where fixture_key = 'expired'), true),
  set_config('m1.revoked_digest', (select encode(token_digest, 'hex') from m1_sessions where fixture_key = 'revoked'), true),
  set_config('m1.wrong_kind_digest', (select encode(token_digest, 'hex') from m1_sessions where fixture_key = 'wrong_kind'), true);

insert into app.library_games (account_id, game_id, playtime_minutes)
values
  (current_setting('m1.account1_id')::integer, current_setting('m1.game1_id')::integer, 120),
  (current_setting('m1.account2_id')::integer, current_setting('m1.game2_id')::integer, 5);

insert into app.game_state (
  account_id, game_id, slept_at, previous_active_status,
  restored_at, restored_from_slept_at, restored_from_previous_active_status,
  manual_progress, completion_dismissed_playtime
)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.game1_id')::integer,
  now() - interval '2 days', 'Sampled',
  now() - interval '1 day', now() - interval '2 days', 'Sampled',
  37.50, 120
);

insert into app.game_activity (
  account_id, game_id, last_observed_minutes, last_played_at,
  observed_at, evidence_source, interval_started_at, interval_ended_at
)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.game1_id')::integer,
  120, now() - interval '3 days', now() - interval '1 day', 'steam_api',
  now() - interval '4 days', now() - interval '3 days'
);

insert into app.retired_library_games (
  account_id, game_id, last_personal_minutes, last_observed_at,
  access_lost_at, loss_reason
)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.game2_id')::integer,
  12, now() - interval '2 days', now() - interval '1 day', 'complete_snapshot'
);

insert into app.library_sync_state (
  account_id, generation, authoritative_snapshot_at, snapshot_hash,
  applied_generation, observed_count, last_result
)
values (
  current_setting('m1.account1_id')::integer, 2, now() - interval '1 day',
  decode(repeat('aa', 32), 'hex'), 1, 1, 'complete'
);

insert into app.playtime_daily (account_id, activity_day, observed_minutes, coverage)
values (current_setting('m1.account1_id')::integer, date '2026-09-04', 2147483648, 'complete');

create temp table m1_family (
  fixture_key text primary key,
  id integer not null
) on commit drop;

with inserted as (
  insert into app.family_members (
    account_id, steam_id, candidate_app_ids, candidate_count, checked_at, error_status
  ) values (
    current_setting('m1.account1_id')::integer, 76561198100000001,
    '[10]'::jsonb, 1, now(), 'ok'
  ) returning id
)
insert into m1_family (fixture_key, id)
select 'member1', id from inserted;

insert into app.family_members (
  account_id, steam_id, candidate_app_ids, candidate_count, checked_at, error_status
)
select current_setting('m1.account1_id')::integer,
       76561198100000000 + n, '[10]'::jsonb, 1, now(), 'ok'
  from generate_series(2, 5) as g(n);

select set_config('m1.family_member_id', (select id::text from m1_family where fixture_key = 'member1'), true);

insert into app.family_game_access (account_id, member_id, game_id, provenance)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.family_member_id')::integer,
  current_setting('m1.game1_id')::integer,
  'inferred'
);

create temp table m1_collections (
  fixture_key text primary key,
  id bigint not null
) on commit drop;

with input(fixture_key, account_id, public_id, collection_kind, name, description, rules) as materialized (
  select 'collection1', id, gen_random_uuid(), 'custom', 'Fixture List',
         'A fixture collection', null::jsonb
    from m1_accounts where fixture_key = 'account1'
  union all
  select 'collection2', id, gen_random_uuid(), 'smart', 'Fixture Smart',
         null, '{"preset":"in-progress"}'::jsonb
    from m1_accounts where fixture_key = 'account2'
), inserted as (
  insert into app.collections (
    account_id, public_id, collection_kind, name, description, rules
  )
  select account_id, public_id, collection_kind, name, description, rules
    from input
  returning id, public_id
)
insert into m1_collections (fixture_key, id)
select input.fixture_key, inserted.id
  from input
  join inserted using (public_id);

select
  set_config('m1.collection1_id', (select id::text from m1_collections where fixture_key = 'collection1'), true),
  set_config('m1.collection2_id', (select id::text from m1_collections where fixture_key = 'collection2'), true);

insert into app.collection_games (account_id, collection_id, game_id, position, note)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.collection1_id')::bigint,
  current_setting('m1.game1_id')::integer,
  0, 'fixture note'
);

insert into app.pins (account_id, scope, slot, game_id, personal_minutes_baseline)
values (
  current_setting('m1.account1_id')::integer, 'wishlist', 1,
  current_setting('m1.game1_id')::integer, 120
);

insert into app.snoozes (account_id, game_id, until_at, reason, source)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.game2_id')::integer,
  now() + interval '1 day', 'fixture pause', 'user'
);

insert into app.vault_state (account_id, current_game_id, current_draw_ref)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.game1_id')::integer,
  '00000000-0000-0000-0000-000000000011'
);

insert into app.completion_events (account_id, game_id, occurred_at, source, dedupe_key)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.game1_id')::integer,
  now() - interval '1 hour', 'user', 'm1-fixture-completion'
);

insert into ops.auth_intents (
  account_id, session_id, intent_kind, nonce_digest, expires_at
)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.manual_session_id')::bigint,
  'promotion', decode(repeat('66', 32), 'hex'), now() + interval '5 minutes'
), (
  null, null, 'openid_nonce', decode(repeat('77', 32), 'hex'), now() + interval '5 minutes'
);

insert into ops.account_aliases (source_account_id, target_account_id, source_public_id)
values (
  current_setting('m1.account1_id')::integer,
  current_setting('m1.account2_id')::integer,
  current_setting('m1.account1_public_id')::uuid
);

insert into ops.account_merges (source_account_id, target_account_id, mode, reason)
values
  (current_setting('m1.account1_id')::integer, current_setting('m1.account1_id')::integer, 'promote', 'fixture in-place promotion'),
  (current_setting('m1.account1_id')::integer, current_setting('m1.account2_id')::integer, 'merge', 'fixture merge audit');

do $assert$
declare
  v_count bigint;
  v_has_slept_until boolean;
  v_daily_type text;
begin
  if current_setting('server_version_num')::integer < 170000 then
    raise exception 'M1 requires PostgreSQL 17 or newer';
  end if;

  select count(*) into v_count
    from ops.project_marker
   where project_name = 'VaultShuffle2'
     and expected_project_ref = 'vbjtbwelnhbbdfrqczyf'
     and schema_version = 'm1';
  if v_count <> 1 then raise exception 'project marker is missing or incorrect'; end if;

  select count(*) into v_count
    from information_schema.columns
   where table_schema = 'app' and table_name = 'game_state'
     and column_name = 'slept_until';
  v_has_slept_until := v_count > 0;
  if v_has_slept_until then
    raise exception 'timed suppression must live in app.snoozes.until_at';
  end if;

  select data_type into v_daily_type
    from information_schema.columns
   where table_schema = 'app' and table_name = 'playtime_daily'
     and column_name = 'observed_minutes';
  if v_daily_type <> 'bigint' then raise exception 'daily observed minutes must be bigint'; end if;

  select count(*) into v_count from app.family_members
   where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 5 then raise exception 'fixture family roster did not reach the cap'; end if;

  select count(*) into v_count from app.game_state
   where account_id = current_setting('m1.account1_id')::integer
     and previous_active_status = 'Sampled'
     and restored_from_previous_active_status = 'Sampled';
  if v_count <> 1 then raise exception 'Sampled state restoration is not represented'; end if;

  select count(*) into v_count from pg_catalog.pg_proc
   where oid = 'app.resolve_session(bytea,text)'::regprocedure;
  if v_count <> 1 then raise exception 'resolver must expose exactly two arguments'; end if;
end
$assert$;

-- Bounds, sparse-state, intent-linkage, and lifecycle checks.
do $assert$
begin
  begin
    insert into catalog.games (steam_app_id, title, normalized_sort_title)
    values (4294967296, 'Overflow', 'overflow');
    raise exception 'AppID overflow was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into catalog.games (steam_app_id, title, normalized_sort_title)
    values (-1, 'Negative', 'negative');
    raise exception 'negative AppID was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into app.game_state (account_id, game_id)
    values (current_setting('m1.account1_id')::integer, current_setting('m1.game2_id')::integer);
    raise exception 'empty sparse game state was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into app.retired_library_games (account_id, game_id, last_personal_minutes, loss_reason)
    values (current_setting('m1.account1_id')::integer, current_setting('m1.game2_id')::integer, 12, 'private');
    raise exception 'private snapshot loss was accepted as retirement';
  exception when check_violation then null;
  end;

  begin
    insert into app.family_members (account_id, steam_id, candidate_app_ids, candidate_count)
    values (current_setting('m1.account1_id')::integer, 76561198100000006, '[]'::jsonb, 0);
    raise exception 'sixth family member was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into app.family_members (account_id, steam_id, candidate_app_ids, candidate_count)
    values (
      current_setting('m1.account2_id')::integer, 76561198200000001,
      (select jsonb_agg(to_jsonb(n)) from generate_series(1, 10001) as g(n)), 0
    );
    raise exception 'unbounded family candidate JSON was accepted';
  exception when check_violation then null;
  end;

  begin
    update app.steam_profiles
       set steam_id = 76561198000000002, verified = true
     where account_id = current_setting('m1.account3_id')::integer;
    raise exception 'duplicate verified Steam identity was accepted';
  exception when unique_violation then null;
  end;

  begin
    insert into ops.auth_intents (account_id, session_id, intent_kind, nonce_digest, expires_at)
    values (
      current_setting('m1.account1_id')::integer,
      current_setting('m1.verified_session_id')::bigint,
      'promotion', decode(repeat('88', 32), 'hex'), now() + interval '5 minutes'
    );
    raise exception 'cross-account session binding was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into ops.auth_intents (account_id, session_id, intent_kind, nonce_digest, expires_at)
    values (
      current_setting('m1.account1_id')::integer, null, 'promotion',
      decode(repeat('89', 32), 'hex'), now() + interval '5 minutes'
    );
    raise exception 'promotion without an exact session was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into ops.account_merges (source_account_id, target_account_id, mode, reason)
    values (
      current_setting('m1.account1_id')::integer,
      current_setting('m1.account2_id')::integer, 'promote', 'invalid fixture'
    );
    raise exception 'in-place promotion accepted distinct accounts';
  exception when check_violation then null;
  end;

  begin
    insert into ops.account_merges (source_account_id, target_account_id, mode, reason)
    values (
      current_setting('m1.account1_id')::integer,
      current_setting('m1.account1_id')::integer, 'merge', 'invalid fixture'
    );
    raise exception 'merge audit accepted identical accounts';
  exception when check_violation then null;
  end;
end
$assert$;

set role vault_app;

-- Runtime tenant isolation, allowed metadata writes, and denied sensitive writes.
select set_config('app.account_id', current_setting('m1.account1_id'), true);
do $assert$
declare
  v_count bigint;
  v_account_id integer;
  v_public_id uuid;
  v_account_kind text;
  v_session_kind text;
  v_identity_verified boolean;
  v_expires_at timestamptz;
begin
  if app.current_account_id() <> current_setting('m1.account1_id')::integer then
    raise exception 'valid transaction principal did not resolve';
  end if;

  select count(*) into v_count from app.accounts;
  if v_count <> 1 then raise exception 'tenant account read leaked or disappeared'; end if;
  select count(*) into v_count from app.library_games
   where account_id = current_setting('m1.account2_id')::integer;
  if v_count <> 0 then raise exception 'cross-account library read leaked'; end if;
  select count(*) into v_count from catalog.games
   where id in (current_setting('m1.game1_id')::integer, current_setting('m1.game2_id')::integer);
  if v_count <> 2 then raise exception 'fixture catalogue read was not available to vault_app'; end if;

  update app.accounts set display_name = 'Manual One Updated'
   where id = current_setting('m1.account1_id')::integer;
  if not found then raise exception 'permitted account metadata update failed'; end if;

  begin
    insert into app.game_state (account_id, game_id, manual_progress)
    values (current_setting('m1.account2_id')::integer, current_setting('m1.game1_id')::integer, 10);
    raise exception 'cross-account state write was accepted';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into app.collection_games (account_id, collection_id, game_id, position)
    values (
      current_setting('m1.account1_id')::integer,
      current_setting('m1.collection2_id')::bigint,
      current_setting('m1.game1_id')::integer, 99
    );
    raise exception 'cross-account compound collection FK was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    update app.steam_profiles set display_name = 'forbidden'
     where account_id = current_setting('m1.account1_id')::integer;
    raise exception 'identity/profile update privilege was granted';
  exception when insufficient_privilege then null;
  end;

  begin
    update app.sessions set token_digest = decode(repeat('90', 32), 'hex')
     where id = current_setting('m1.manual_session_id')::bigint;
    raise exception 'session digest update privilege was granted';
  exception when insufficient_privilege then null;
  end;

  begin
    update app.library_games set playtime_minutes = 999
     where account_id = current_setting('m1.account1_id')::integer
       and game_id = current_setting('m1.game1_id')::integer;
    raise exception 'import-owned library update privilege was granted';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from app.completion_events
     where account_id = current_setting('m1.account1_id')::integer;
    raise exception 'completion event delete privilege undermined undo evidence';
  exception when insufficient_privilege then null;
  end;

  select count(*) into v_count
    from app.resolve_session(decode(current_setting('m1.manual_digest'), 'hex'), 'manual');
  if v_count <> 1 then raise exception 'manual session did not resolve'; end if;
  select account_id, account_public_id, account_kind, session_kind,
         identity_verified, expires_at
    into v_account_id, v_public_id, v_account_kind, v_session_kind,
         v_identity_verified, v_expires_at
    from app.resolve_session(decode(current_setting('m1.manual_digest'), 'hex'), 'manual');
  if v_account_id <> current_setting('m1.account1_id')::integer
     or v_public_id <> current_setting('m1.account1_public_id')::uuid
     or v_account_kind <> 'manual'
     or v_session_kind <> 'manual'
     or v_identity_verified
     or v_expires_at <= statement_timestamp() then
    raise exception 'manual principal DTO is incorrect';
  end if;

  select count(*) into v_count
    from app.resolve_session(decode(current_setting('m1.verified_digest'), 'hex'), 'verified_steam');
  if v_count <> 1 then raise exception 'verified Steam session did not resolve'; end if;
  select identity_verified, account_kind, session_kind
    into v_identity_verified, v_account_kind, v_session_kind
    from app.resolve_session(decode(current_setting('m1.verified_digest'), 'hex'), 'verified_steam');
  if not v_identity_verified or v_account_kind <> 'steam' or v_session_kind <> 'verified_steam' then
    raise exception 'verified Steam principal DTO is incorrect';
  end if;

  select count(*) into v_count from app.resolve_session(decode(current_setting('m1.verified_digest'), 'hex'), 'manual');
  if v_count <> 0 then raise exception 'wrong expected session kind resolved'; end if;
  select count(*) into v_count from app.resolve_session(decode(current_setting('m1.expired_digest'), 'hex'), 'manual');
  if v_count <> 0 then raise exception 'expired session resolved'; end if;
  select count(*) into v_count from app.resolve_session(decode(current_setting('m1.revoked_digest'), 'hex'), 'manual');
  if v_count <> 0 then raise exception 'revoked session resolved'; end if;
  select count(*) into v_count from app.resolve_session(decode(current_setting('m1.wrong_kind_digest'), 'hex'), 'verified_steam');
  if v_count <> 0 then raise exception 'kind/account mismatch session resolved'; end if;
  select count(*) into v_count from app.resolve_session(decode('aa', 'hex'), 'manual');
  if v_count <> 0 then raise exception 'malformed digest resolved'; end if;
  select count(*) into v_count from app.resolve_session(null, 'manual');
  if v_count <> 0 then raise exception 'null digest resolved'; end if;
  select count(*) into v_count from app.resolve_session(decode(current_setting('m1.manual_digest'), 'hex'), 'unexpected');
  if v_count <> 0 then raise exception 'unexpected session kind resolved'; end if;

  -- A failed nested transaction must restore the previous principal on the
  -- same connection, as happens when a pooled transaction is rolled back.
  begin
    perform set_config('app.account_id', current_setting('m1.account2_id'), true);
    if app.current_account_id() <> current_setting('m1.account2_id')::integer then
      raise exception 'nested context did not change before rollback';
    end if;
    raise exception using errcode = 'P0002', message = 'fixture rollback';
  exception when sqlstate 'P0002' then null;
  end;
  if app.current_account_id() <> current_setting('m1.account1_id')::integer then
    raise exception 'nested rollback leaked the account context';
  end if;
end
$assert$;

-- Missing, malformed, negative, and overflowing principals are fail-closed.
savepoint malformed_context;
select set_config('app.account_id', '', true);
do $assert$
declare v_count bigint;
begin
  if app.current_account_id() is not null then raise exception 'empty principal was accepted'; end if;
  select count(*) into v_count from app.accounts;
  if v_count <> 0 then raise exception 'empty principal exposed account rows'; end if;
  select count(*) into v_count from app.library_games;
  if v_count <> 0 then raise exception 'empty principal exposed library rows'; end if;
end
$assert$;
select set_config('app.account_id', 'abc', true);
do $assert$
begin
  if app.current_account_id() is not null then raise exception 'malformed principal was accepted'; end if;
end
$assert$;
select set_config('app.account_id', '0', true);
do $assert$
begin
  if app.current_account_id() is not null then raise exception 'zero principal was accepted'; end if;
end
$assert$;
select set_config('app.account_id', '-1', true);
do $assert$
begin
  if app.current_account_id() is not null then raise exception 'negative principal was accepted'; end if;
end
$assert$;
select set_config('app.account_id', '2147483648', true);
do $assert$
begin
  if app.current_account_id() is not null then raise exception 'overflow principal was accepted'; end if;
end
$assert$;
select set_config('app.account_id', '999999999999999999999999999999', true);
do $assert$
begin
  if app.current_account_id() is not null then raise exception 'wide overflow principal was accepted'; end if;
end
$assert$;
rollback to savepoint malformed_context;
select set_config('app.account_id', current_setting('m1.account1_id'), true);

-- The savepoint rollback above restored the same connection; this second
-- tenant read verifies the context can be replaced safely after it.
select set_config('app.account_id', current_setting('m1.account2_id'), true);
do $assert$
declare v_count bigint;
begin
  if app.current_account_id() <> current_setting('m1.account2_id')::integer then
    raise exception 'second tenant context did not resolve';
  end if;
  select count(*) into v_count from app.library_games;
  if v_count <> 1 then raise exception 'second tenant could not read its own library'; end if;
  select count(*) into v_count from app.library_games
   where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'second tenant read the first tenant library'; end if;
end
$assert$;

reset role;

-- Worker access is limited to shared catalogue reads and the marker helper.
set role vault_worker;
do $assert$
declare
  v_count bigint;
  v_project text;
begin
  select count(*) into v_count from catalog.games
   where id in (current_setting('m1.game1_id')::integer, current_setting('m1.game2_id')::integer);
  if v_count <> 2 then raise exception 'worker fixture catalogue read failed'; end if;
  select project_name into v_project from app.read_project_marker();
  if v_project <> 'VaultShuffle2' then raise exception 'worker marker read failed'; end if;

  begin
    select count(*) into v_count from app.accounts;
    raise exception 'worker received blanket private access';
  exception when insufficient_privilege then null;
  end;
  begin
    select count(*) into v_count from app.sessions;
    raise exception 'worker received session access';
  exception when insufficient_privilege then null;
  end;
end
$assert$;
reset role;

-- Browser roles have no private schema/table/function access. The conditional
-- role checks keep this assertion runnable on plain PostgreSQL rebuilds.
do $assert$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      if has_schema_privilege(v_role, 'app', 'USAGE')
         or has_schema_privilege(v_role, 'catalog', 'USAGE')
         or has_schema_privilege(v_role, 'ops', 'USAGE') then
        raise exception 'browser role % can use a private schema', v_role;
      end if;
      if has_table_privilege(v_role, 'app.accounts', 'SELECT')
         or has_table_privilege(v_role, 'catalog.games', 'SELECT') then
        raise exception 'browser role % can read private tables', v_role;
      end if;
      if has_function_privilege(v_role, 'app.resolve_session(bytea,text)', 'EXECUTE')
         or has_function_privilege(v_role, 'app.read_project_marker()', 'EXECUTE') then
        raise exception 'browser role % can execute private functions', v_role;
      end if;
    end if;
  end loop;
end
$assert$;

create function app.m1_default_acl_probe()
returns integer
language sql
as 'select 1';

do $assert$
declare v_role text;
begin
  if exists (
    select 1
      from pg_catalog.pg_proc as p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as x
     where p.oid = 'app.m1_default_acl_probe()'::regprocedure
       and x.grantee = 0
       and x.privilege_type = 'EXECUTE'
  ) then
    raise exception 'new private functions retained PUBLIC EXECUTE';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role)
       and has_function_privilege(v_role, 'app.m1_default_acl_probe()', 'EXECUTE') then
      raise exception 'new private function is executable by %', v_role;
    end if;
  end loop;
end
$assert$;
drop function app.m1_default_acl_probe();

do $assert$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null
     and exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     and has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE') then
    raise exception 'existing rls_auto_enable helper remains browser-callable';
  end if;
end
$assert$;

-- Verify account deletion cascades all private children, including the
-- session-bound intent and merge/alias audit rows, without touching shared
-- catalogue rows or an unrelated tenant. The savepoint is rolled back.
savepoint deletion_check;
delete from app.accounts where id = current_setting('m1.account1_id')::integer;
do $assert$
declare v_count bigint;
begin
  select count(*) into v_count from app.accounts where id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'account row survived deletion'; end if;
  select count(*) into v_count from app.steam_profiles where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'steam profile survived account deletion'; end if;
  select count(*) into v_count from app.sessions where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'session survived account deletion'; end if;
  select count(*) into v_count from app.account_capabilities where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'capability row survived account deletion'; end if;
  select count(*) into v_count from app.account_preferences where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'preference row survived account deletion'; end if;
  select count(*) into v_count from app.library_games where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'library row survived account deletion'; end if;
  select count(*) into v_count from app.game_state where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'state row survived account deletion'; end if;
  select count(*) into v_count from app.game_activity where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'activity row survived account deletion'; end if;
  select count(*) into v_count from app.retired_library_games where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'retired library row survived account deletion'; end if;
  select count(*) into v_count from app.library_sync_state where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'sync row survived account deletion'; end if;
  select count(*) into v_count from app.playtime_daily where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'daily row survived account deletion'; end if;
  select count(*) into v_count from app.family_members where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'family member survived account deletion'; end if;
  select count(*) into v_count from app.family_game_access where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'family access survived account deletion'; end if;
  select count(*) into v_count from app.collections where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'collection survived account deletion'; end if;
  select count(*) into v_count from app.collection_games where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'collection game survived account deletion'; end if;
  select count(*) into v_count from app.pins where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'pin survived account deletion'; end if;
  select count(*) into v_count from app.snoozes where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'snooze survived account deletion'; end if;
  select count(*) into v_count from app.vault_state where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'vault state survived account deletion'; end if;
  select count(*) into v_count from app.completion_events where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'completion event survived account deletion'; end if;
  select count(*) into v_count from ops.auth_intents where account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'auth intent survived account deletion'; end if;
  select count(*) into v_count from ops.account_aliases
   where source_account_id = current_setting('m1.account1_id')::integer
      or target_account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'account alias survived account deletion'; end if;
  select count(*) into v_count from ops.account_merges
   where source_account_id = current_setting('m1.account1_id')::integer
      or target_account_id = current_setting('m1.account1_id')::integer;
  if v_count <> 0 then raise exception 'merge audit survived account deletion'; end if;
  select count(*) into v_count from app.accounts where id = current_setting('m1.account2_id')::integer;
  if v_count <> 1 then raise exception 'unrelated account was deleted'; end if;
  select count(*) into v_count from catalog.games
   where id in (current_setting('m1.game1_id')::integer, current_setting('m1.game2_id')::integer);
  if v_count <> 2 then raise exception 'shared fixture catalogue was deleted with an account'; end if;
end
$assert$;
rollback to savepoint deletion_check;

-- Roll back the complete fixture transaction. This also clears the local
-- account context on the same connection and leaves any pre-existing rows.
set role vault_app;
rollback;
do $assert$
begin
  if app.current_account_id() is not null then
    raise exception 'transaction rollback left a reusable account context';
  end if;
end
$assert$;
reset role;
select 'm1 SQL assertions passed' as result;
