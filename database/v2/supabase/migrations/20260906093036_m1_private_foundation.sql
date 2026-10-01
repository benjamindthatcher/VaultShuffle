-- VaultShuffle v2 M1: private relational foundation.
--
-- This chain is intentionally independent of the legacy public-schema
-- migrations. It creates no login credentials and does not copy data.
-- Runtime membership/credentials are provisioned outside SQL migrations.

create schema app;
create schema catalog;
create schema reco;
create schema ops;
create schema migration;

-- These are non-login group roles. If a role already exists, fail closed when
-- its security attributes are unsafe instead of attempting ALTER ROLE flags
-- that a non-superuser migration owner cannot change.
do $$
declare
  role_name text;
  role_row record;
begin
  foreach role_name in array array['vault_app', 'vault_worker'] loop
    select
      r.rolsuper,
      r.rolinherit,
      r.rolcreaterole,
      r.rolcreatedb,
      r.rolcanlogin,
      r.rolreplication,
      r.rolbypassrls
    into role_row
    from pg_catalog.pg_roles as r
    where r.rolname = role_name;

    if not found then
      execute format(
        'create role %I noinherit nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
        role_name
      );
    elsif role_row.rolsuper
       or role_row.rolinherit
       or role_row.rolcreaterole
       or role_row.rolcreatedb
       or role_row.rolcanlogin
       or role_row.rolreplication
       or role_row.rolbypassrls then
      raise exception using
        errcode = 'invalid_parameter_value',
        message = format('existing role %I does not have the required non-owner runtime attributes', role_name);
    end if;
  end loop;
end
$$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC globally. Remove that
-- default for the migration owner before creating any security boundary.
alter default privileges revoke execute on functions from public;

-- Private schemas have no browser/Data API exposure. Per-schema defaults keep
-- future objects private as well as the objects created by this migration.
do $$
declare
  schema_name text;
  role_name text;
begin
  foreach schema_name in array array['app', 'catalog', 'reco', 'ops', 'migration'] loop
    execute format('revoke all on schema %I from public', schema_name);
    execute format('alter default privileges in schema %I revoke all on tables from public', schema_name);
    execute format('alter default privileges in schema %I revoke all on sequences from public', schema_name);
    execute format('alter default privileges in schema %I revoke execute on functions from public', schema_name);

    foreach role_name in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_catalog.pg_roles where rolname = role_name) then
        execute format('revoke all on schema %I from %I', schema_name, role_name);
        execute format('alter default privileges in schema %I revoke all on tables from %I', schema_name, role_name);
        execute format('alter default privileges in schema %I revoke all on sequences from %I', schema_name, role_name);
        execute format('alter default privileges in schema %I revoke execute on functions from %I', schema_name, role_name);
      end if;
    end loop;
  end loop;

  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = role_name) then
      execute format('alter default privileges revoke execute on functions from %I', role_name);
    end if;
  end loop;
end
$$;

create table app.accounts (
  id integer generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  account_kind text not null default 'manual'
    check (account_kind in ('manual', 'steam')),
  lifecycle_status text not null default 'active'
    check (lifecycle_status in ('active', 'merged', 'deleted')),
  display_name text
    check (display_name is null or length(btrim(display_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  library_revision bigint not null default 0 check (library_revision >= 0),
  state_revision bigint not null default 0 check (state_revision >= 0),
  locale text check (locale is null or length(locale) between 2 and 35),
  store_country text check (store_country is null or store_country ~ '^[A-Z]{2}$'),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$')
);

create table app.steam_profiles (
  account_id integer primary key references app.accounts(id) on delete cascade,
  steam_id bigint not null check (steam_id > 0),
  verified boolean not null default false,
  display_name text
    check (display_name is null or length(btrim(display_name)) between 1 and 80),
  steam_display_name text
    check (steam_display_name is null or length(btrim(steam_display_name)) between 1 and 80),
  avatar_url text check (avatar_url is null or length(avatar_url) <= 2048),
  profile_url text check (profile_url is null or length(profile_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, steam_id)
);

-- Manual public-profile workspaces may share a Steam ID. A verified identity
-- is the only unique Steam identity claim.
create unique index steam_profiles_verified_steam_id_uq
  on app.steam_profiles (steam_id)
  where verified;
create index steam_profiles_steam_id_idx on app.steam_profiles (steam_id);

create table app.sessions (
  id bigint generated always as identity primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  token_digest bytea not null unique check (octet_length(token_digest) = 32),
  session_kind text not null check (session_kind in ('manual', 'verified_steam')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at),
  unique (account_id, id)
);
create index sessions_account_id_idx on app.sessions (account_id);
create index sessions_expiry_idx on app.sessions (expires_at)
  where revoked_at is null;

create table app.account_capabilities (
  account_id integer primary key references app.accounts(id) on delete cascade,
  library_visibility text not null default 'unknown'
    check (library_visibility in ('unknown', 'visible', 'hidden')),
  playtime_visibility text not null default 'unknown'
    check (playtime_visibility in ('unknown', 'visible', 'hidden')),
  last_played_visibility text not null default 'unknown'
    check (last_played_visibility in ('unknown', 'visible', 'hidden')),
  checked_at timestamptz,
  status text not null default 'unknown'
    check (status in ('unknown', 'ok', 'private', 'error'))
);

create table app.account_preferences (
  account_id integer primary key references app.accounts(id) on delete cascade,
  version integer not null default 1 check (version > 0),
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(preferences) = 'object'),
  check (pg_column_size(preferences) <= 16384)
);

create table catalog.games (
  id integer generated always as identity primary key,
  steam_app_id bigint unique check (
    steam_app_id is null or steam_app_id between 1 and 4294967295
  ),
  title text not null check (length(btrim(title)) between 1 and 500),
  normalized_sort_title text not null check (length(normalized_sort_title) between 1 and 500),
  game_type text not null default 'game'
    check (game_type in ('game', 'dlc', 'demo', 'software', 'video', 'unknown')),
  lifecycle_status text not null default 'active'
    check (lifecycle_status in ('active', 'retired', 'rejected', 'unsupported')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index games_sort_title_idx on catalog.games (normalized_sort_title, id);

-- These two shared relations are deliberately bounded foundations for future
-- catalogue enrichment. Provider payloads and derived features remain distinct.
create table catalog.game_metadata (
  game_id integer primary key references catalog.games(id) on delete cascade,
  short_description text check (short_description is null or length(short_description) <= 10000),
  header_image_url text check (header_image_url is null or length(header_image_url) <= 2048),
  capsule_image_url text check (capsule_image_url is null or length(capsule_image_url) <= 2048),
  genres jsonb not null default '[]'::jsonb,
  categories jsonb not null default '[]'::jsonb,
  weighted_tags jsonb not null default '[]'::jsonb,
  provider_name text check (provider_name is null or length(provider_name) between 1 and 80),
  provider_revision text check (provider_revision is null or length(provider_revision) <= 200),
  fetched_at timestamptz,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(genres) = 'array' and pg_column_size(genres) <= 32768),
  check (jsonb_typeof(categories) = 'array' and pg_column_size(categories) <= 32768),
  check (jsonb_typeof(weighted_tags) = 'array' and pg_column_size(weighted_tags) <= 65536)
);

create table catalog.game_features (
  game_id integer primary key references catalog.games(id) on delete cascade,
  feature_revision integer not null default 1 check (feature_revision > 0),
  deck_compatibility text not null default 'unknown'
    check (deck_compatibility in ('unknown', 'supported', 'unsupported')),
  linux_compatibility text not null default 'unknown'
    check (linux_compatibility in ('unknown', 'supported', 'unsupported')),
  family_compatibility text not null default 'unknown'
    check (family_compatibility in ('unknown', 'supported', 'unsupported')),
  main_duration_minutes integer
    check (main_duration_minutes is null or main_duration_minutes >= 0),
  completion_duration_minutes integer
    check (completion_duration_minutes is null or completion_duration_minutes >= 0),
  duration_confidence numeric(5, 4)
    check (duration_confidence is null or duration_confidence between 0 and 1),
  review_score numeric(5, 2)
    check (review_score is null or review_score between 0 and 100),
  popularity_rank bigint check (popularity_rank is null or popularity_rank >= 0),
  updated_at timestamptz not null default now()
);

-- The active library intentionally has only its tenant/game key and exact
-- observed minutes. NULL is unknown; zero is an observed zero.
create table app.library_games (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  playtime_minutes integer check (playtime_minutes is null or playtime_minutes >= 0),
  primary key (account_id, game_id)
);

create table app.game_state (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  completed_at timestamptz,
  slept_at timestamptz,
  previous_active_status text
    check (previous_active_status is null or previous_active_status in ('Not Started', 'Sampled', 'In Progress')),
  restored_at timestamptz,
  restored_from_slept_at timestamptz,
  restored_from_previous_active_status text
    check (restored_from_previous_active_status is null or restored_from_previous_active_status in ('Not Started', 'Sampled', 'In Progress')),
  manual_progress numeric(5, 2)
    check (manual_progress is null or manual_progress between 0 and 100),
  notes text check (notes is null or length(btrim(notes)) between 1 and 10000),
  review_requested_at timestamptz,
  completion_dismissed_at timestamptz,
  completion_dismissed_playtime integer
    check (completion_dismissed_playtime is null or completion_dismissed_playtime >= 0),
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  primary key (account_id, game_id),
  check (
    completed_at is not null or slept_at is not null or previous_active_status is not null or
    restored_at is not null or restored_from_slept_at is not null or
    restored_from_previous_active_status is not null or manual_progress is not null or
    notes is not null or review_requested_at is not null or completion_dismissed_at is not null
  )
);

create table app.game_activity (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  last_observed_minutes integer
    check (last_observed_minutes is null or last_observed_minutes >= 0),
  last_played_at timestamptz,
  observed_at timestamptz not null default now(),
  evidence_source text not null
    check (evidence_source in ('steam_profile', 'steam_api', 'user', 'unknown')),
  interval_started_at timestamptz,
  interval_ended_at timestamptz,
  primary key (account_id, game_id),
  check (last_observed_minutes is not null or last_played_at is not null),
  check (interval_ended_at is null or interval_started_at is null or interval_ended_at >= interval_started_at)
);

create table app.retired_library_games (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  last_personal_minutes integer
    check (last_personal_minutes is null or last_personal_minutes >= 0),
  last_observed_at timestamptz,
  access_lost_at timestamptz not null default now(),
  loss_reason text not null
    check (loss_reason in ('complete_snapshot', 'manual', 'unknown')),
  primary key (account_id, game_id)
);

create table app.library_sync_state (
  account_id integer primary key references app.accounts(id) on delete cascade,
  generation bigint not null default 0 check (generation >= 0),
  in_flight_job_id uuid,
  authoritative_snapshot_at timestamptz,
  snapshot_hash bytea check (snapshot_hash is null or octet_length(snapshot_hash) = 32),
  applied_generation bigint not null default 0 check (applied_generation >= 0),
  observed_count integer check (observed_count is null or observed_count >= 0),
  last_result text check (last_result is null or last_result in ('complete', 'unavailable', 'invalid', 'error')),
  updated_at timestamptz not null default now(),
  check (applied_generation <= generation)
);

create table app.playtime_daily (
  account_id integer not null references app.accounts(id) on delete cascade,
  activity_day date not null,
  observed_minutes bigint not null check (observed_minutes >= 0),
  coverage text not null default 'unknown'
    check (coverage in ('unknown', 'partial', 'complete')),
  recorded_at timestamptz not null default now(),
  primary key (account_id, activity_day)
);
create index playtime_daily_account_day_idx
  on app.playtime_daily (account_id, activity_day desc);

create table app.family_members (
  id integer generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  account_id integer not null references app.accounts(id) on delete cascade,
  steam_id bigint not null check (steam_id > 0),
  candidate_app_ids jsonb not null default '[]'::jsonb,
  candidate_count integer not null default 0 check (candidate_count between 0 and 10000),
  checked_at timestamptz,
  error_status text check (error_status is null or error_status in ('private', 'error', 'ok', 'unknown')),
  unique (account_id, id),
  unique (account_id, steam_id),
  check (jsonb_typeof(candidate_app_ids) = 'array'),
  check (jsonb_array_length(candidate_app_ids) <= 10000),
  check (pg_column_size(candidate_app_ids) <= 262144)
);

create table app.family_game_access (
  account_id integer not null references app.accounts(id) on delete cascade,
  member_id integer not null,
  game_id integer not null references catalog.games(id),
  observed_at timestamptz not null default now(),
  provenance text not null default 'inferred'
    check (provenance in ('inferred', 'verified', 'unknown')),
  primary key (account_id, member_id, game_id),
  foreign key (account_id, member_id)
    references app.family_members(account_id, id) on delete cascade
);

create table app.collections (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid() unique,
  account_id integer not null references app.accounts(id) on delete cascade,
  collection_kind text not null check (collection_kind in ('custom', 'smart')),
  name text not null check (length(btrim(name)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  rules jsonb,
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, id),
  check (collection_kind = 'custom' or rules is not null),
  check (rules is null or jsonb_typeof(rules) = 'object'),
  check (rules is null or pg_column_size(rules) <= 16384)
);
create index collections_account_idx on app.collections (account_id, updated_at desc);

create table app.collection_games (
  account_id integer not null references app.accounts(id) on delete cascade,
  collection_id bigint not null,
  game_id integer not null references catalog.games(id),
  position integer not null check (position >= 0),
  note text check (note is null or length(note) <= 10000),
  primary key (account_id, collection_id, game_id),
  unique (account_id, collection_id, position),
  foreign key (account_id, collection_id)
    references app.collections(account_id, id) on delete cascade
);

create table app.pins (
  account_id integer not null references app.accounts(id) on delete cascade,
  scope text not null check (scope in ('library', 'wishlist', 'family', 'all')),
  slot smallint not null check (slot between 1 and 3),
  game_id integer not null references catalog.games(id),
  pinned_at timestamptz not null default now(),
  personal_minutes_baseline integer
    check (personal_minutes_baseline is null or personal_minutes_baseline >= 0),
  primary key (account_id, scope, slot),
  unique (account_id, scope, game_id)
);

create table app.snoozes (
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  snoozed_at timestamptz not null default now(),
  until_at timestamptz,
  reason text check (reason is null or length(reason) <= 2000),
  source text check (source is null or source in ('user', 'system', 'unknown')),
  primary key (account_id, game_id),
  check (until_at is null or until_at >= snoozed_at)
);
create index snoozes_account_expiry_idx on app.snoozes (account_id, until_at);

create table app.vault_state (
  account_id integer primary key references app.accounts(id) on delete cascade,
  current_game_id integer references catalog.games(id),
  current_draw_ref uuid,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

create table app.completion_events (
  id bigint generated always as identity primary key,
  account_id integer not null references app.accounts(id) on delete cascade,
  game_id integer not null references catalog.games(id),
  occurred_at timestamptz not null default now(),
  undone_at timestamptz,
  source text not null check (source in ('user', 'system', 'migration')),
  dedupe_key text check (dedupe_key is null or length(btrim(dedupe_key)) between 1 and 200),
  check (undone_at is null or undone_at >= occurred_at),
  unique (account_id, dedupe_key)
);
create index completion_events_account_time_idx
  on app.completion_events (account_id, occurred_at desc);

-- Promotion and callback state is private and is bound to the exact manual
-- session through the composite FK; it is not a browser-facing API.
create table ops.auth_intents (
  id uuid primary key default gen_random_uuid(),
  account_id integer,
  session_id bigint,
  intent_kind text not null check (intent_kind in ('promotion', 'openid_nonce')),
  nonce_digest bytea not null check (octet_length(nonce_digest) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  outcome text not null default 'pending'
    check (outcome in ('pending', 'completed', 'cancelled', 'expired', 'rejected')),
  unique (intent_kind, nonce_digest),
  foreign key (account_id, session_id)
    references app.sessions(account_id, id) on delete cascade,
  -- A promotion is bound to the exact current session. An OpenID login nonce
  -- can be anonymous because no session exists before the callback succeeds.
  check (
    (intent_kind = 'promotion' and account_id is not null and session_id is not null)
    or (intent_kind = 'openid_nonce' and account_id is null and session_id is null)
  ),
  check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  check (consumed_at is null or outcome <> 'pending')
);
create index auth_intents_expiry_idx on ops.auth_intents (expires_at);
create index auth_intents_session_idx on ops.auth_intents (account_id, session_id);

create table ops.account_aliases (
  source_account_id integer primary key references app.accounts(id) on delete cascade,
  target_account_id integer not null references app.accounts(id) on delete cascade,
  source_public_id uuid not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  check (source_account_id <> target_account_id),
  check (expires_at is null or expires_at >= created_at)
);

create table ops.account_merges (
  id bigint generated always as identity primary key,
  source_account_id integer not null references app.accounts(id) on delete cascade,
  target_account_id integer not null references app.accounts(id) on delete cascade,
  mode text not null check (mode in ('promote', 'merge')),
  verified_steam_id bigint check (verified_steam_id is null or verified_steam_id > 0),
  reason text not null check (length(btrim(reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  check (
    (mode = 'promote' and source_account_id = target_account_id)
    or (mode = 'merge' and source_account_id <> target_account_id)
  )
);
create index account_merges_source_idx on ops.account_merges (source_account_id);
create index account_merges_target_idx on ops.account_merges (target_account_id);

-- A stable marker lets deployment/rebuild checks prove they reached the v2
-- target. The marker remains private; read access is through a tiny function.
create table ops.project_marker (
  marker boolean primary key default true check (marker),
  project_name text not null,
  expected_project_ref text not null check (expected_project_ref = 'vbjtbwelnhbbdfrqczyf'),
  schema_version text not null check (schema_version = 'm1'),
  created_at timestamptz not null default now()
);
insert into ops.project_marker (project_name, expected_project_ref, schema_version)
values ('VaultShuffle2', 'vbjtbwelnhbbdfrqczyf', 'm1');

-- Serialize family-cap checks by versioning the parent account row. A
-- transaction advisory lock alone does not make concurrent MVCC count checks
-- safe; the same-value update also forces REPEATABLE READ writers to retry.
create or replace function app.enforce_family_member_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  member_count integer;
begin
  if tg_op = 'UPDATE' and old.account_id is distinct from new.account_id then
    if old.account_id < new.account_id then
      -- The no-op UPDATE both locks the parent and creates a row version.
      -- The row version is necessary for concurrent REPEATABLE READ writers
      -- to receive a serialization failure instead of counting stale rows.
      update app.accounts set state_revision = state_revision where id = old.account_id;
      if not found then
        raise exception using errcode = 'foreign_key_violation', message = 'family member source account is unavailable';
      end if;
      update app.accounts set state_revision = state_revision where id = new.account_id;
      if not found then
        raise exception using errcode = 'foreign_key_violation', message = 'family member target account is unavailable';
      end if;
    else
      update app.accounts set state_revision = state_revision where id = new.account_id;
      if not found then
        raise exception using errcode = 'foreign_key_violation', message = 'family member target account is unavailable';
      end if;
      update app.accounts set state_revision = state_revision where id = old.account_id;
      if not found then
        raise exception using errcode = 'foreign_key_violation', message = 'family member source account is unavailable';
      end if;
    end if;
  else
    update app.accounts set state_revision = state_revision where id = new.account_id;
    if not found then
      raise exception using errcode = 'foreign_key_violation', message = 'family member account is unavailable';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    select count(*) into member_count
      from app.family_members
     where account_id = new.account_id
       and id <> old.id;
  else
    select count(*) into member_count
      from app.family_members
     where account_id = new.account_id;
  end if;

  if member_count >= 5 then
    raise exception using
      errcode = 'check_violation',
      message = 'at most five family members are allowed per account';
  end if;
  return new;
end;
$$;
create trigger family_member_limit
before insert or update on app.family_members
for each row execute function app.enforce_family_member_limit();

create or replace function app.current_account_id()
returns integer
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select case
    when v.value ~ '^[1-9][0-9]*$'
     and pg_input_is_valid(v.value, 'integer')
    then v.value::integer
    else null
  end
  from (select current_setting('app.account_id', true) as value) as v
$$;

-- Only the digest and expected cookie branch cross the SQL boundary. The
-- database clock is authoritative; callers cannot extend a session by passing
-- a fabricated timestamp. The result is the minimum tenant principal.
create or replace function app.resolve_session(
  p_token_digest bytea,
  p_expected_session_kind text
)
returns table (
  session_id bigint,
  account_id integer,
  account_public_id uuid,
  account_kind text,
  session_kind text,
  identity_verified boolean,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select
    s.id,
    s.account_id,
    a.public_id,
    a.account_kind,
    s.session_kind,
    (s.session_kind = 'verified_steam'),
    s.expires_at
  from app.sessions as s
  join app.accounts as a on a.id = s.account_id
  where p_token_digest is not null
    and octet_length(p_token_digest) = 32
    and p_expected_session_kind in ('manual', 'verified_steam')
    and s.token_digest = p_token_digest
    and s.session_kind = p_expected_session_kind
    and s.revoked_at is null
    and s.expires_at > statement_timestamp()
    and a.lifecycle_status = 'active'
    and (
      (s.session_kind = 'manual' and a.account_kind = 'manual')
      or (
        s.session_kind = 'verified_steam'
        and a.account_kind = 'steam'
        and exists (
          select 1
            from app.steam_profiles as sp
           where sp.account_id = s.account_id
             and sp.verified
        )
      )
    )
$$;

create or replace function app.read_project_marker()
returns table (
  project_name text,
  expected_project_ref text,
  schema_version text
)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pm.project_name, pm.expected_project_ref, pm.schema_version
    from ops.project_marker as pm
   where pm.marker
$$;

-- Tenant tables fail closed when app.account_id is missing, malformed, or
-- belongs to another account. Explicit account predicates remain required in
-- repository SQL as a second guard.
alter table app.accounts enable row level security;
alter table app.accounts force row level security;
create policy tenant_isolation on app.accounts for all to vault_app
  using (id = app.current_account_id()) with check (id = app.current_account_id());

alter table app.steam_profiles enable row level security;
alter table app.steam_profiles force row level security;
create policy tenant_isolation on app.steam_profiles for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.sessions enable row level security;
alter table app.sessions force row level security;
create policy tenant_isolation on app.sessions for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.account_capabilities enable row level security;
alter table app.account_capabilities force row level security;
create policy tenant_isolation on app.account_capabilities for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.account_preferences enable row level security;
alter table app.account_preferences force row level security;
create policy tenant_isolation on app.account_preferences for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.library_games enable row level security;
alter table app.library_games force row level security;
create policy tenant_isolation on app.library_games for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.game_state enable row level security;
alter table app.game_state force row level security;
create policy tenant_isolation on app.game_state for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.game_activity enable row level security;
alter table app.game_activity force row level security;
create policy tenant_isolation on app.game_activity for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.retired_library_games enable row level security;
alter table app.retired_library_games force row level security;
create policy tenant_isolation on app.retired_library_games for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.library_sync_state enable row level security;
alter table app.library_sync_state force row level security;
create policy tenant_isolation on app.library_sync_state for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.playtime_daily enable row level security;
alter table app.playtime_daily force row level security;
create policy tenant_isolation on app.playtime_daily for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.family_members enable row level security;
alter table app.family_members force row level security;
create policy tenant_isolation on app.family_members for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.family_game_access enable row level security;
alter table app.family_game_access force row level security;
create policy tenant_isolation on app.family_game_access for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.collections enable row level security;
alter table app.collections force row level security;
create policy tenant_isolation on app.collections for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.collection_games enable row level security;
alter table app.collection_games force row level security;
create policy tenant_isolation on app.collection_games for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.pins enable row level security;
alter table app.pins force row level security;
create policy tenant_isolation on app.pins for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.snoozes enable row level security;
alter table app.snoozes force row level security;
create policy tenant_isolation on app.snoozes for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.vault_state enable row level security;
alter table app.vault_state force row level security;
create policy tenant_isolation on app.vault_state for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table app.completion_events enable row level security;
alter table app.completion_events force row level security;
create policy tenant_isolation on app.completion_events for all to vault_app
  using (account_id = app.current_account_id()) with check (account_id = app.current_account_id());

alter table ops.auth_intents enable row level security;
alter table ops.auth_intents force row level security;
alter table ops.account_aliases enable row level security;
alter table ops.account_aliases force row level security;
alter table ops.account_merges enable row level security;
alter table ops.account_merges force row level security;
alter table ops.project_marker enable row level security;
alter table ops.project_marker force row level security;

-- Shared catalogue reads are private to the two server-side runtime groups.
alter table catalog.games enable row level security;
alter table catalog.games force row level security;
create policy catalogue_runtime_read on catalog.games
  for select to vault_app, vault_worker using (true);

alter table catalog.game_metadata enable row level security;
alter table catalog.game_metadata force row level security;
create policy catalogue_runtime_read on catalog.game_metadata
  for select to vault_app, vault_worker using (true);

alter table catalog.game_features enable row level security;
alter table catalog.game_features force row level security;
create policy catalogue_runtime_read on catalog.game_features
  for select to vault_app, vault_worker using (true);

-- Remove any implicit/public grants on existing objects in these private
-- schemas. The conditional role loop keeps a plain PostgreSQL rebuild portable
-- when Supabase's anon/authenticated roles are not present.
revoke all on all tables in schema app, catalog, reco, ops, migration from public;
revoke all on all sequences in schema app, catalog, reco, ops, migration from public;
revoke all on all functions in schema app, catalog, reco, ops, migration from public;
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = role_name) then
      execute format('revoke all on all tables in schema app, catalog, reco, ops, migration from %I', role_name);
      execute format('revoke all on all sequences in schema app, catalog, reco, ops, migration from %I', role_name);
      execute format('revoke all on all functions in schema app, catalog, reco, ops, migration from %I', role_name);
    end if;
  end loop;
end
$$;

-- Read access is enough for the app to build tenant DTOs; identity/profile,
-- session and import-owned rows have no direct runtime write grant.
grant usage on schema app, catalog to vault_app;
grant usage on schema app, catalog to vault_worker;
grant execute on function app.current_account_id() to vault_app;
grant execute on function app.resolve_session(bytea, text) to vault_app;
grant execute on function app.read_project_marker() to vault_app, vault_worker;

grant select on app.accounts, app.steam_profiles, app.account_capabilities,
  app.account_preferences, app.library_games, app.game_state, app.game_activity,
  app.retired_library_games, app.library_sync_state, app.playtime_daily,
  app.family_members, app.family_game_access, app.collections, app.collection_games,
  app.pins, app.snoozes, app.vault_state, app.completion_events to vault_app;
grant select on catalog.games, catalog.game_metadata, catalog.game_features
  to vault_app, vault_worker;

grant update (display_name, last_seen_at, locale, store_country, currency)
  on app.accounts to vault_app;
grant insert (account_id, version, preferences)
  on app.account_preferences to vault_app;
grant update (version, preferences, updated_at)
  on app.account_preferences to vault_app;
grant insert (
  account_id, game_id, completed_at, slept_at, previous_active_status,
  restored_at, restored_from_slept_at, restored_from_previous_active_status,
  manual_progress, notes, review_requested_at, completion_dismissed_at,
  completion_dismissed_playtime, revision, updated_at
)
  on app.game_state to vault_app;
grant update (
  completed_at, slept_at, previous_active_status, restored_at,
  restored_from_slept_at, restored_from_previous_active_status, manual_progress,
  notes, review_requested_at, completion_dismissed_at,
  completion_dismissed_playtime, revision, updated_at
)
  on app.game_state to vault_app;
grant insert (account_id, game_id, until_at, reason, source)
  on app.snoozes to vault_app;
grant update (snoozed_at, until_at, reason, source)
  on app.snoozes to vault_app;
grant delete on app.snoozes to vault_app;
grant insert (account_id, scope, slot, game_id, pinned_at, personal_minutes_baseline)
  on app.pins to vault_app;
grant update (pinned_at, personal_minutes_baseline)
  on app.pins to vault_app;
grant delete on app.pins to vault_app;
grant insert (account_id, current_game_id, current_draw_ref, revision, updated_at)
  on app.vault_state to vault_app;
grant update (current_game_id, current_draw_ref, revision, updated_at)
  on app.vault_state to vault_app;
grant delete on app.vault_state to vault_app;
grant insert (account_id, game_id, occurred_at, undone_at, source, dedupe_key)
  on app.completion_events to vault_app;
grant update (undone_at) on app.completion_events to vault_app;
grant insert (
  account_id, public_id, collection_kind, name, description, rules,
  revision, created_at, updated_at
)
  on app.collections to vault_app;
grant update (name, description, rules, revision, updated_at)
  on app.collections to vault_app;
grant delete on app.collections to vault_app;
grant insert (account_id, collection_id, game_id, position, note)
  on app.collection_games to vault_app;
grant update (position, note) on app.collection_games to vault_app;
grant delete on app.collection_games to vault_app;

grant usage, select on sequence app.collections_id_seq to vault_app;

-- A runtime should never rely on a broad ops grant to check its environment.
-- This exact helper exists only on some Supabase targets; if present and owned
-- by the migration role, remove its stale browser execute ACL. The event
-- trigger can still invoke an owned function without exposing it as an RPC.
do $$
declare
  helper_owner text;
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    select pg_get_userbyid(p.proowner)
      into helper_owner
      from pg_catalog.pg_proc as p
     where p.oid = to_regprocedure('public.rls_auto_enable()');
    if helper_owner = current_user then
      revoke all on function public.rls_auto_enable() from public;
      if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
        execute 'revoke all on function public.rls_auto_enable() from anon';
      end if;
      if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
        execute 'revoke all on function public.rls_auto_enable() from authenticated';
      end if;
    end if;
  end if;
end
$$;
