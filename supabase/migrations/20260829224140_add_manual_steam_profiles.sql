-- A Steam OpenID identity and a browser-held public-profile identity are not
-- the same claim. Keep them in separate tables, while giving the product data a
-- neutral account parent so both receive the same VaultShuffle experience.

create table public.app_accounts (
  id uuid primary key default gen_random_uuid(),
  account_type text not null check (account_type in ('steam', 'manual')),
  steam_library_visible boolean,
  steam_playtime_visible boolean,
  steam_last_played_visible boolean,
  steam_visibility_checked_at timestamptz,
  steam_games_seen integer check (steam_games_seen is null or steam_games_seen >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.app_accounts is
  'Neutral owner for VaultShuffle product data. Identity details remain in app_users or manual_steam_profiles.';
comment on column public.app_accounts.account_type is
  'steam means verified by Steam OpenID; manual means created from a public profile without ownership verification.';

create index app_accounts_type_created_idx
  on public.app_accounts (account_type, created_at desc);

alter table public.app_accounts enable row level security;
revoke all on table public.app_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.app_accounts to service_role;

-- Existing IDs remain unchanged, so every current session, game, collection and
-- analytics identity continues to point at the same UUID after the re-parenting.
-- Lock the verified identity table before the backfill so a concurrent Steam
-- callback cannot insert a row between the copy and the trigger installation.
-- No shared product tables are locked in this transaction, which keeps the
-- lock order independent from normal game and event writes.
lock table public.app_users in share row exclusive mode;

insert into public.app_accounts (
  id,
  account_type,
  steam_library_visible,
  steam_playtime_visible,
  steam_last_played_visible,
  steam_visibility_checked_at,
  steam_games_seen,
  created_at,
  updated_at
)
select
  id,
  'steam',
  steam_library_visible,
  steam_playtime_visible,
  steam_last_played_visible,
  steam_visibility_checked_at,
  steam_games_seen,
  created_at,
  updated_at
from public.app_users
on conflict (id) do nothing;

-- Deferred so the AFTER INSERT trigger can create the neutral account in the
-- same transaction. Unlike a BEFORE trigger, this does not leave an orphaned
-- account behind when app_users uses INSERT .. ON CONFLICT during sign-in.
alter table public.app_users
  add constraint app_users_account_id_fkey
  foreign key (id) references public.app_accounts(id)
  on delete cascade
  deferrable initially deferred
  not valid;
alter table public.app_users validate constraint app_users_account_id_fkey;

create or replace function public.sync_steam_identity_account()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.app_accounts (
    id,
    account_type,
    steam_library_visible,
    steam_playtime_visible,
    steam_last_played_visible,
    steam_visibility_checked_at,
    steam_games_seen,
    created_at,
    updated_at
  ) values (
    new.id,
    'steam',
    new.steam_library_visible,
    new.steam_playtime_visible,
    new.steam_last_played_visible,
    new.steam_visibility_checked_at,
    new.steam_games_seen,
    new.created_at,
    new.updated_at
  )
  on conflict (id) do update set
    steam_library_visible = excluded.steam_library_visible,
    steam_playtime_visible = excluded.steam_playtime_visible,
    steam_last_played_visible = excluded.steam_last_played_visible,
    steam_visibility_checked_at = excluded.steam_visibility_checked_at,
    steam_games_seen = excluded.steam_games_seen,
    updated_at = excluded.updated_at;
  return new;
end;
$function$;

revoke all on function public.sync_steam_identity_account() from public, anon, authenticated;

create trigger app_users_create_account
after insert on public.app_users
for each row execute function public.sync_steam_identity_account();

create trigger app_users_sync_account_visibility
after update of
  steam_library_visible,
  steam_playtime_visible,
  steam_last_played_visible,
  steam_visibility_checked_at,
  steam_games_seen
on public.app_users
for each row execute function public.sync_steam_identity_account();

create table public.manual_steam_profiles (
  id uuid primary key references public.app_accounts(id) on delete cascade,
  steam_id text not null check (steam_id ~ '^[0-9]{17}$'),
  steam_profile_url text not null check (
    steam_profile_url = 'https://steamcommunity.com/profiles/' || steam_id
  ),
  display_name text not null check (char_length(display_name) between 1 and 80),
  steam_display_name text not null check (char_length(steam_display_name) between 1 and 80),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.manual_steam_profiles is
  'Unverified VaultShuffle identities created from public Steam profile URLs. Steam IDs are deliberately not unique.';
comment on column public.manual_steam_profiles.steam_id is
  'Identifies which public library to read; it is not proof that the browser owns that Steam account.';

create index manual_steam_profiles_steam_id_idx
  on public.manual_steam_profiles (steam_id);
create index manual_steam_profiles_created_idx
  on public.manual_steam_profiles (created_at desc);

alter table public.manual_steam_profiles enable row level security;
revoke all on table public.manual_steam_profiles from public, anon, authenticated;
grant select, insert, update, delete on table public.manual_steam_profiles to service_role;

create table public.manual_profile_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.manual_steam_profiles(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at > created_at)
);

create index manual_profile_sessions_profile_id_idx
  on public.manual_profile_sessions (profile_id);
create index manual_profile_sessions_expires_at_idx
  on public.manual_profile_sessions (expires_at);

alter table public.manual_profile_sessions enable row level security;
revoke all on table public.manual_profile_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.manual_profile_sessions to service_role;

-- One service-role RPC keeps account, identity and session creation atomic.
create or replace function public.create_manual_profile_session(
  p_steam_id text,
  p_profile_url text,
  p_display_name text,
  p_steam_display_name text,
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
  created_id uuid := gen_random_uuid();
begin
  if p_steam_id is null or p_steam_id !~ '^[0-9]{17}$' then
    raise exception 'INVALID_MANUAL_STEAM_ID';
  end if;
  if p_profile_url is distinct from 'https://steamcommunity.com/profiles/' || p_steam_id then
    raise exception 'INVALID_MANUAL_PROFILE_URL';
  end if;
  if p_display_name is null or char_length(trim(p_display_name)) not between 1 and 80 then
    raise exception 'INVALID_MANUAL_DISPLAY_NAME';
  end if;
  if p_steam_display_name is null or char_length(trim(p_steam_display_name)) not between 1 and 80 then
    raise exception 'INVALID_STEAM_DISPLAY_NAME';
  end if;
  if p_avatar_url is not null and char_length(p_avatar_url) > 2048 then
    raise exception 'INVALID_MANUAL_AVATAR_URL';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_MANUAL_SESSION_TOKEN';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '370 days' then
    raise exception 'INVALID_MANUAL_SESSION_EXPIRY';
  end if;

  insert into public.app_accounts (id, account_type)
  values (created_id, 'manual');

  insert into public.manual_steam_profiles (
    id,
    steam_id,
    steam_profile_url,
    display_name,
    steam_display_name,
    avatar_url
  ) values (
    created_id,
    p_steam_id,
    p_profile_url,
    trim(p_display_name),
    trim(p_steam_display_name),
    nullif(trim(p_avatar_url), '')
  );

  insert into public.manual_profile_sessions (profile_id, token_hash, expires_at)
  values (created_id, p_token_hash, p_expires_at);

  return query
  select profile.id, profile.steam_id, profile.display_name, profile.avatar_url
  from public.manual_steam_profiles as profile
  where profile.id = created_id;
end;
$function$;

revoke all on function public.create_manual_profile_session(text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_manual_profile_session(text, text, text, text, text, text, timestamptz)
  to service_role;
