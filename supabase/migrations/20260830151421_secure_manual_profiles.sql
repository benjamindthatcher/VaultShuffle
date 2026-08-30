-- A public-profile account is useful immediately, but its browser cookie is
-- the only proof the visitor has. These short-lived intents let that exact
-- browser prove ownership through Steam OpenID and promote (or consolidate)
-- the account without ever exposing a raw token to the database.

create table public.manual_profile_security_intents (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null,
  source_manual_session_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null check (
    expires_at > created_at and expires_at <= created_at + interval '15 minutes'
  ),
  consumed_at timestamptz,
  target_account_id uuid,
  verified_steam_id text check (
    verified_steam_id is null or verified_steam_id ~ '^[0-9]{17}$'
  ),
  openid_response_nonce text,
  outcome text check (outcome is null or outcome in ('promoted', 'merged_existing', 'expired'))
);

comment on table public.manual_profile_security_intents is
  'Server-only, single-use intents linking one authenticated manual-profile browser to Steam OpenID.';
comment on column public.manual_profile_security_intents.source_account_id is
  'Immutable audit value rather than a foreign key because a merged source account is deleted.';

create index manual_profile_security_intents_source_idx
  on public.manual_profile_security_intents (source_account_id, created_at desc);
create index manual_profile_security_intents_expiry_idx
  on public.manual_profile_security_intents (expires_at)
  where consumed_at is null;
create unique index manual_profile_security_intents_openid_nonce_key
  on public.manual_profile_security_intents (openid_response_nonce)
  where openid_response_nonce is not null;

alter table public.manual_profile_security_intents enable row level security;
revoke all on table public.manual_profile_security_intents from public, anon, authenticated;
grant select, insert, update, delete on table public.manual_profile_security_intents to service_role;

create table public.account_merges (
  id uuid primary key default gen_random_uuid(),
  source_account_id uuid not null unique,
  target_account_id uuid not null references public.app_accounts(id) on delete restrict,
  verified_steam_id text not null check (verified_steam_id ~ '^[0-9]{17}$'),
  merge_mode text not null check (merge_mode in ('promoted', 'merged_existing')),
  created_at timestamptz not null default now(),
  analytics_delivered_at timestamptz
);

comment on table public.account_merges is
  'Immutable audit ledger for browser-only profiles secured through a matching Steam identity.';

create index account_merges_target_idx
  on public.account_merges (target_account_id, created_at desc);

alter table public.account_merges enable row level security;
revoke all on table public.account_merges from public, anon, authenticated;
grant select, insert, update on table public.account_merges to service_role;

create or replace function public.create_manual_profile_security_intent(
  p_source_account_id uuid,
  p_source_manual_session_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  created_intent_id uuid;
begin
  if p_source_account_id is null or p_source_manual_session_id is null then
    raise exception 'LINK_SESSION_MISSING';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'LINK_INTENT_INVALID';
  end if;
  if p_expires_at is null
     or p_expires_at <= now()
     or p_expires_at > now() + interval '15 minutes' then
    raise exception 'LINK_INTENT_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('manual-link:' || p_source_account_id::text, 0));

  if not exists (
    select 1
    from public.manual_profile_sessions as sessions
    join public.manual_steam_profiles as profiles
      on profiles.id = sessions.profile_id
    where sessions.id = p_source_manual_session_id
      and sessions.profile_id = p_source_account_id
      and sessions.expires_at > now()
  ) then
    raise exception 'LINK_SESSION_MISMATCH';
  end if;

  update public.manual_profile_security_intents
  set consumed_at = now(), outcome = 'expired'
  where source_account_id = p_source_account_id
    and consumed_at is null
    and expires_at <= now();

  insert into public.manual_profile_security_intents (
    source_account_id,
    source_manual_session_id,
    token_hash,
    expires_at
  ) values (
    p_source_account_id,
    p_source_manual_session_id,
    p_token_hash,
    p_expires_at
  )
  returning id into created_intent_id;

  return created_intent_id;
end;
$function$;

revoke all on function public.create_manual_profile_security_intent(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_manual_profile_security_intent(uuid, uuid, text, timestamptz)
  to service_role;

-- Ordinary Steam sign-in uses the same SteamID advisory lock as account
-- promotion. That closes the race where a normal callback could create the
-- verified identity halfway through a manual-profile merge.
create or replace function public.create_verified_steam_session(
  p_steam_id text,
  p_display_name text,
  p_avatar_url text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns table (
  id uuid,
  steam_id text,
  display_name text,
  avatar_url text
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  verified_user public.app_users%rowtype;
begin
  if p_steam_id is null or p_steam_id !~ '^[0-9]{17}$' then
    raise exception 'INVALID_STEAM_ID';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_SESSION_TOKEN';
  end if;
  if p_expires_at is null
     or p_expires_at <= now()
     or p_expires_at > now() + interval '35 days' then
    raise exception 'INVALID_SESSION_EXPIRY';
  end if;
  if p_display_name is not null and char_length(p_display_name) > 80 then
    raise exception 'INVALID_DISPLAY_NAME';
  end if;
  if p_avatar_url is not null and char_length(p_avatar_url) > 2048 then
    raise exception 'INVALID_AVATAR_URL';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('steam:' || p_steam_id, 0));

  insert into public.app_users as users (
    steam_id,
    display_name,
    avatar_url,
    last_login_at,
    updated_at
  ) values (
    p_steam_id,
    nullif(trim(p_display_name), ''),
    nullif(trim(p_avatar_url), ''),
    now(),
    now()
  )
  on conflict (steam_id) do update set
    display_name = coalesce(excluded.display_name, users.display_name),
    avatar_url = coalesce(excluded.avatar_url, users.avatar_url),
    last_login_at = now(),
    updated_at = now()
  returning users.* into verified_user;

  insert into public.sessions (user_id, token_hash, expires_at)
  values (verified_user.id, p_token_hash, p_expires_at);

  return query
  select verified_user.id, verified_user.steam_id, verified_user.display_name, verified_user.avatar_url;
end;
$function$;

revoke all on function public.create_verified_steam_session(text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_verified_steam_session(text, text, text, text, timestamptz)
  to service_role;

create or replace function public.complete_manual_profile_security(
  p_intent_token_hash text,
  p_manual_session_id uuid,
  p_verified_steam_id text,
  p_steam_display_name text,
  p_avatar_url text,
  p_new_session_token_hash text,
  p_new_session_expires_at timestamptz,
  p_openid_response_nonce text
)
returns table (
  account_id uuid,
  merge_mode text,
  merged_from_account_id uuid
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  intent_row public.manual_profile_security_intents%rowtype;
  manual_session_row public.manual_profile_sessions%rowtype;
  manual_profile_row public.manual_steam_profiles%rowtype;
  target_user_row public.app_users%rowtype;
  source_id uuid;
  target_id uuid;
  result_mode text;
begin
  if p_intent_token_hash is null or p_intent_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'LINK_INTENT_INVALID';
  end if;
  if p_manual_session_id is null then
    raise exception 'LINK_SESSION_MISSING';
  end if;
  if p_verified_steam_id is null or p_verified_steam_id !~ '^[0-9]{17}$' then
    raise exception 'STEAM_IDENTITY_UNVERIFIED';
  end if;
  if p_new_session_token_hash is null or p_new_session_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'LINK_MERGE_FAILED';
  end if;
  if p_new_session_expires_at is null
     or p_new_session_expires_at <= now()
     or p_new_session_expires_at > now() + interval '35 days' then
    raise exception 'LINK_MERGE_FAILED';
  end if;
  if p_openid_response_nonce is null
     or char_length(p_openid_response_nonce) < 8
     or char_length(p_openid_response_nonce) > 255 then
    raise exception 'STEAM_IDENTITY_UNVERIFIED';
  end if;
  if p_steam_display_name is not null and char_length(p_steam_display_name) > 80 then
    raise exception 'LINK_MERGE_FAILED';
  end if;
  if p_avatar_url is not null and char_length(p_avatar_url) > 2048 then
    raise exception 'LINK_MERGE_FAILED';
  end if;

  select intents.*
  into intent_row
  from public.manual_profile_security_intents as intents
  where intents.token_hash = p_intent_token_hash
  for update;

  if not found then
    raise exception 'LINK_INTENT_INVALID';
  end if;
  if intent_row.consumed_at is not null then
    raise exception 'LINK_INTENT_CONSUMED';
  end if;
  if intent_row.expires_at <= now() then
    raise exception 'LINK_INTENT_EXPIRED';
  end if;
  if intent_row.source_manual_session_id <> p_manual_session_id then
    raise exception 'LINK_SESSION_MISMATCH';
  end if;

  select sessions.*
  into manual_session_row
  from public.manual_profile_sessions as sessions
  where sessions.id = p_manual_session_id
  for update;

  if not found or manual_session_row.expires_at <= now() then
    raise exception 'LINK_SESSION_MISSING';
  end if;
  if manual_session_row.profile_id <> intent_row.source_account_id then
    raise exception 'LINK_SESSION_MISMATCH';
  end if;

  select profiles.*
  into manual_profile_row
  from public.manual_steam_profiles as profiles
  where profiles.id = intent_row.source_account_id
  for update;

  if not found then
    raise exception 'LINK_SESSION_MISSING';
  end if;
  if manual_profile_row.steam_id <> p_verified_steam_id then
    raise exception 'STEAM_ACCOUNT_MISMATCH';
  end if;
  if exists (
    select 1
    from public.manual_profile_security_intents as replay
    where replay.openid_response_nonce = p_openid_response_nonce
      and replay.id <> intent_row.id
  ) then
    raise exception 'STEAM_IDENTITY_UNVERIFIED';
  end if;

  source_id := manual_profile_row.id;
  perform pg_advisory_xact_lock(hashtextextended('steam:' || p_verified_steam_id, 0));
  perform 1 from public.app_accounts where id = source_id for update;

  select users.*
  into target_user_row
  from public.app_users as users
  where users.steam_id = p_verified_steam_id
  for update;

  if not found then
    -- The common path: the existing account UUID survives, so every product and
    -- analytics identity remains exactly where it already is.
    insert into public.app_users (
      id,
      steam_id,
      display_name,
      avatar_url,
      last_login_at,
      updated_at
    ) values (
      source_id,
      p_verified_steam_id,
      coalesce(nullif(trim(p_steam_display_name), ''), manual_profile_row.steam_display_name),
      coalesce(nullif(trim(p_avatar_url), ''), manual_profile_row.avatar_url),
      now(),
      now()
    );

    update public.app_accounts
    set account_type = 'steam', updated_at = now()
    where id = source_id;

    insert into public.sessions (user_id, token_hash, expires_at)
    values (source_id, p_new_session_token_hash, p_new_session_expires_at);

    insert into public.account_merges (
      source_account_id,
      target_account_id,
      verified_steam_id,
      merge_mode
    ) values (
      source_id,
      source_id,
      p_verified_steam_id,
      'promoted'
    );

    update public.manual_profile_security_intents
    set
      consumed_at = now(),
      target_account_id = source_id,
      verified_steam_id = p_verified_steam_id,
      openid_response_nonce = p_openid_response_nonce,
      outcome = 'promoted'
    where id = intent_row.id;

    delete from public.manual_steam_profiles where id = source_id;

    return query select source_id, 'promoted'::text, source_id;
    return;
  end if;

  target_id := target_user_row.id;
  if target_id = source_id then
    raise exception 'LINK_MERGE_CONFLICT';
  end if;
  perform 1 from public.app_accounts where id = target_id for update;

  create temporary table if not exists pg_temp.manual_game_merge_map (
    source_game_id uuid primary key,
    target_game_id uuid not null unique
  ) on commit drop;
  truncate table pg_temp.manual_game_merge_map;

  insert into pg_temp.manual_game_merge_map (source_game_id, target_game_id)
  select source_games.id, target_games.id
  from public.user_games as source_games
  join public.user_games as target_games
    on target_games.user_id = target_id
   and target_games.catalog_steam_appid = source_games.catalog_steam_appid
  where source_games.user_id = source_id;

  create temporary table if not exists pg_temp.manual_merge_catalog_appids (
    steam_appid bigint primary key
  ) on commit drop;
  truncate table pg_temp.manual_merge_catalog_appids;
  insert into pg_temp.manual_merge_catalog_appids (steam_appid)
  select steam_appid
  from public.catalog_user_imports
  where user_id = source_id;

  -- Merge overlapping game state into the verified account's stable game UUID.
  update public.user_games as target_games
  set
    ownership = case
      when target_games.ownership = 'Owned' or source_games.ownership = 'Owned' then 'Owned'
      else 'Wishlist'
    end,
    status = case
      when target_games.status = 'Completed' or source_games.status = 'Completed' then 'Completed'
      when source_games.status <> 'Not Started' then source_games.status
      else target_games.status
    end,
    rating = case when source_games.rating > 0 then source_games.rating else target_games.rating end,
    hours_played = greatest(target_games.hours_played, source_games.hours_played),
    completion_percentage = greatest(target_games.completion_percentage, source_games.completion_percentage),
    priority = case when source_games.priority <> 'Medium' then source_games.priority else target_games.priority end,
    date_added = coalesce(source_games.date_added, target_games.date_added),
    notes = case
      when char_length(trim(source_games.notes)) > 0 then source_games.notes
      else target_games.notes
    end,
    last_played_at = greatest(target_games.last_played_at, source_games.last_played_at),
    completed_at = greatest(target_games.completed_at, source_games.completed_at),
    slept_at = greatest(target_games.slept_at, source_games.slept_at),
    completion_suggestion_dismissed_at = greatest(
      target_games.completion_suggestion_dismissed_at,
      source_games.completion_suggestion_dismissed_at
    ),
    completion_suggestion_dismissed_playtime = greatest(
      target_games.completion_suggestion_dismissed_playtime,
      source_games.completion_suggestion_dismissed_playtime
    ),
    previous_active_status = coalesce(source_games.previous_active_status, target_games.previous_active_status),
    last_observed_played_at = greatest(
      target_games.last_observed_played_at,
      source_games.last_observed_played_at
    ),
    recency_source = case
      when source_games.recency_evidence_at is not null
       and (
         target_games.recency_evidence_at is null
         or source_games.recency_evidence_at >= target_games.recency_evidence_at
       ) then source_games.recency_source
      else target_games.recency_source
    end,
    recency_evidence_at = greatest(target_games.recency_evidence_at, source_games.recency_evidence_at),
    observed_playtime_minutes = greatest(
      target_games.observed_playtime_minutes,
      source_games.observed_playtime_minutes
    ),
    review_requested_at = greatest(target_games.review_requested_at, source_games.review_requested_at),
    updated_at = now()
  from public.user_games as source_games
  join pg_temp.manual_game_merge_map as game_map
    on game_map.source_game_id = source_games.id
  where target_games.id = game_map.target_game_id;

  insert into public.collection_games (collection_id, game_id, notes, position, created_at)
  select memberships.collection_id, game_map.target_game_id, memberships.notes, memberships.position, memberships.created_at
  from public.collection_games as memberships
  join pg_temp.manual_game_merge_map as game_map
    on game_map.source_game_id = memberships.game_id
  on conflict (collection_id, game_id) do update set
    notes = coalesce(excluded.notes, public.collection_games.notes),
    position = least(excluded.position, public.collection_games.position),
    created_at = least(excluded.created_at, public.collection_games.created_at);
  delete from public.collection_games as memberships
  using pg_temp.manual_game_merge_map as game_map
  where memberships.game_id = game_map.source_game_id;

  update public.purge_reviews as reviews
  set game_id = game_map.target_game_id
  from pg_temp.manual_game_merge_map as game_map
  where reviews.game_id = game_map.source_game_id;
  update public.vault_events as events
  set game_id = game_map.target_game_id
  from pg_temp.manual_game_merge_map as game_map
  where events.game_id = game_map.source_game_id;
  update public.completion_events as events
  set game_id = game_map.target_game_id
  from pg_temp.manual_game_merge_map as game_map
  where events.game_id = game_map.source_game_id;
  update public.user_vault_state as state
  set current_game_id = game_map.target_game_id
  from pg_temp.manual_game_merge_map as game_map
  where state.user_id = source_id
    and state.current_game_id = game_map.source_game_id;

  -- The active browser's pin layout wins only for scopes it currently uses.
  delete from public.user_game_pins as target_pins
  where target_pins.user_id = target_id
    and target_pins.scope in (
      select distinct source_pins.scope
      from public.user_game_pins as source_pins
      where source_pins.user_id = source_id
    );
  update public.user_game_pins as source_pins
  set
    user_id = target_id,
    game_id = coalesce(
      (
        select game_map.target_game_id
        from pg_temp.manual_game_merge_map as game_map
        where game_map.source_game_id = source_pins.game_id
      ),
      source_pins.game_id
    )
  where source_pins.user_id = source_id;

  insert into public.user_game_snoozes (user_id, game_id, snoozed_at, snoozed_until)
  select
    target_id,
    coalesce(game_map.target_game_id, source_snoozes.game_id),
    source_snoozes.snoozed_at,
    source_snoozes.snoozed_until
  from public.user_game_snoozes as source_snoozes
  left join pg_temp.manual_game_merge_map as game_map
    on game_map.source_game_id = source_snoozes.game_id
  where source_snoozes.user_id = source_id
  on conflict (user_id, game_id) do update set
    snoozed_at = greatest(public.user_game_snoozes.snoozed_at, excluded.snoozed_at),
    snoozed_until = case
      when public.user_game_snoozes.snoozed_until is null or excluded.snoozed_until is null then null
      else greatest(public.user_game_snoozes.snoozed_until, excluded.snoozed_until)
    end;
  delete from public.user_game_snoozes where user_id = source_id;

  delete from public.user_games as source_games
  using pg_temp.manual_game_merge_map as game_map
  where source_games.id = game_map.source_game_id;

  update public.user_games
  set user_id = target_id, updated_at = now()
  where user_id = source_id;

  insert into public.app_settings (id, user_id, key, value, created_at, updated_at)
  select gen_random_uuid(), target_id, settings.key, settings.value, settings.created_at, settings.updated_at
  from public.app_settings as settings
  where settings.user_id = source_id
  on conflict (user_id, key) do update set
    value = case
      when excluded.updated_at >= public.app_settings.updated_at then excluded.value
      else public.app_settings.value
    end,
    updated_at = greatest(excluded.updated_at, public.app_settings.updated_at),
    created_at = least(excluded.created_at, public.app_settings.created_at);
  delete from public.app_settings where user_id = source_id;

  insert into public.catalog_user_imports (
    user_id,
    steam_appid,
    first_imported_at,
    last_imported_at,
    import_sync_count
  )
  select target_id, imports.steam_appid, imports.first_imported_at, imports.last_imported_at, imports.import_sync_count
  from public.catalog_user_imports as imports
  where imports.user_id = source_id
  on conflict (user_id, steam_appid) do update set
    first_imported_at = least(
      public.catalog_user_imports.first_imported_at,
      excluded.first_imported_at
    ),
    last_imported_at = greatest(
      public.catalog_user_imports.last_imported_at,
      excluded.last_imported_at
    ),
    import_sync_count = public.catalog_user_imports.import_sync_count + excluded.import_sync_count;
  delete from public.catalog_user_imports where user_id = source_id;

  insert into public.user_genre_preferences (
    user_id,
    genre,
    context_mood,
    positive,
    total,
    updated_at
  )
  select target_id, preferences.genre, preferences.context_mood, preferences.positive, preferences.total, preferences.updated_at
  from public.user_genre_preferences as preferences
  where preferences.user_id = source_id
  on conflict (user_id, genre, context_mood) do update set
    positive = public.user_genre_preferences.positive + excluded.positive,
    total = public.user_genre_preferences.total + excluded.total,
    updated_at = greatest(public.user_genre_preferences.updated_at, excluded.updated_at);
  delete from public.user_genre_preferences where user_id = source_id;

  insert into public.user_playtime_snapshots (
    user_id,
    captured_on,
    total_minutes,
    games_with_playtime,
    created_at
  )
  select target_id, snapshots.captured_on, snapshots.total_minutes, snapshots.games_with_playtime, snapshots.created_at
  from public.user_playtime_snapshots as snapshots
  where snapshots.user_id = source_id
  on conflict (user_id, captured_on) do update set
    total_minutes = greatest(public.user_playtime_snapshots.total_minutes, excluded.total_minutes),
    games_with_playtime = greatest(
      public.user_playtime_snapshots.games_with_playtime,
      excluded.games_with_playtime
    ),
    created_at = least(public.user_playtime_snapshots.created_at, excluded.created_at);
  delete from public.user_playtime_snapshots where user_id = source_id;

  insert into public.user_vault_state (user_id, current_game_id, updated_at)
  select target_id, state.current_game_id, state.updated_at
  from public.user_vault_state as state
  where state.user_id = source_id
  on conflict (user_id) do update set
    current_game_id = case
      when excluded.updated_at >= public.user_vault_state.updated_at then excluded.current_game_id
      else public.user_vault_state.current_game_id
    end,
    updated_at = greatest(public.user_vault_state.updated_at, excluded.updated_at);
  delete from public.user_vault_state where user_id = source_id;

  update public.collections set user_id = target_id where user_id = source_id;
  update public.completion_events set user_id = target_id where user_id = source_id;
  update public.contact_messages set user_id = target_id where user_id = source_id;
  update public.feedback_submissions set user_id = target_id where user_id = source_id;
  update public.purge_reviews set user_id = target_id where user_id = source_id;
  update public.vault_draws set user_id = target_id where user_id = source_id;
  update public.vault_draw_events set user_id = target_id where user_id = source_id;
  update public.vault_events set user_id = target_id where user_id = source_id;

  -- A new authoritative Steam import begins after the callback. Preserve any
  -- verified job already in flight and discard the source staging payload.
  delete from public.steam_import_jobs where user_id = source_id;

  update public.catalog_game_sightings as sightings
  set
    import_count = counts.import_count,
    first_seen_at = counts.first_seen_at,
    last_seen_at = counts.last_seen_at
  from (
    select
      imports.steam_appid,
      count(*)::integer as import_count,
      min(imports.first_imported_at) as first_seen_at,
      max(imports.last_imported_at) as last_seen_at
    from public.catalog_user_imports as imports
    join pg_temp.manual_merge_catalog_appids as affected
      on affected.steam_appid = imports.steam_appid
    group by imports.steam_appid
  ) as counts
  where sightings.steam_appid = counts.steam_appid;

  update public.catalog_games as games
  set
    users_that_imported = counts.import_count,
    import_sighting_count = counts.import_count,
    last_seen_at = greatest(games.last_seen_at, counts.last_seen_at),
    updated_at = now()
  from (
    select
      imports.steam_appid,
      count(*)::integer as import_count,
      max(imports.last_imported_at) as last_seen_at
    from public.catalog_user_imports as imports
    join pg_temp.manual_merge_catalog_appids as affected
      on affected.steam_appid = imports.steam_appid
    group by imports.steam_appid
  ) as counts
  where games.steam_appid = counts.steam_appid;

  update public.app_users
  set
    display_name = coalesce(nullif(trim(p_steam_display_name), ''), display_name),
    avatar_url = coalesce(nullif(trim(p_avatar_url), ''), avatar_url),
    last_login_at = now(),
    updated_at = now()
  where id = target_id;

  insert into public.sessions (user_id, token_hash, expires_at)
  values (target_id, p_new_session_token_hash, p_new_session_expires_at);

  insert into public.account_merges (
    source_account_id,
    target_account_id,
    verified_steam_id,
    merge_mode
  ) values (
    source_id,
    target_id,
    p_verified_steam_id,
    'merged_existing'
  );

  update public.manual_profile_security_intents
  set
    consumed_at = now(),
    target_account_id = target_id,
    verified_steam_id = p_verified_steam_id,
    openid_response_nonce = p_openid_response_nonce,
    outcome = 'merged_existing'
  where id = intent_row.id;

  delete from public.manual_steam_profiles where id = source_id;
  delete from public.app_accounts where id = source_id;

  result_mode := 'merged_existing';
  return query select target_id, result_mode, source_id;
end;
$function$;

revoke all on function public.complete_manual_profile_security(
  text, uuid, text, text, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.complete_manual_profile_security(
  text, uuid, text, text, text, text, timestamptz, text
) to service_role;
