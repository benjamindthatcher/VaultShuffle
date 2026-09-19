-- A public-profile URL is now a reusable, unverified VaultShuffle sign-in.
-- Keep the Vault name and product data on the newest manual identity created for
-- a SteamID, and issue another device session instead of creating a new account.
--
-- Existing duplicates are intentionally deleted at the account root. The
-- app_accounts foreign keys apply their declared CASCADE/SET NULL behaviour, so
-- sessions and product data owned by each older duplicate are removed with it.
-- This is destructive by design: the newest profile is the canonical one.

lock table public.manual_steam_profiles in share row exclusive mode;

do $deduplicate_manual_profiles$
declare
  removed_count integer;
begin
  with ranked_profiles as (
    select
      profiles.id,
      row_number() over (
        partition by profiles.steam_id
        order by profiles.created_at desc, profiles.id desc
      ) as newest_rank
    from public.manual_steam_profiles as profiles
  ),
  removed_accounts as (
    delete from public.app_accounts as accounts
    using ranked_profiles as duplicates
    where accounts.id = duplicates.id
      and duplicates.newest_rank > 1
    returning accounts.id
  )
  select count(*) into removed_count from removed_accounts;

  raise notice 'Removed % older duplicate manual profile account(s)', removed_count;
end;
$deduplicate_manual_profiles$;

-- The RPC lock closes application races; this constraint also prevents any
-- future service process or manual database write from reintroducing a duplicate.
drop index if exists public.manual_steam_profiles_steam_id_idx;
alter table public.manual_steam_profiles
  add constraint manual_steam_profiles_steam_id_key unique (steam_id);

comment on table public.manual_steam_profiles is
  'Unverified VaultShuffle identities reached through reusable public Steam profile URLs. One newest canonical identity is retained per SteamID.';
comment on column public.manual_steam_profiles.steam_id is
  'Public URL identity used for unverified sign-in; possession or knowledge of the URL is not proof of Steam account ownership.';

create or replace function public.create_or_resume_manual_profile_session(
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
  steam_display_name text,
  avatar_url text,
  resumed boolean
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  selected_profile public.manual_steam_profiles%rowtype;
  created_id uuid;
  profile_existed boolean := false;
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

  -- Shared with verified Steam sign-in/profile promotion so account-type changes
  -- and public-URL sign-ins cannot race for the same Steam identity.
  perform pg_advisory_xact_lock(hashtextextended('steam:' || p_steam_id, 0));

  select profiles.*
  into selected_profile
  from public.manual_steam_profiles as profiles
  where profiles.steam_id = p_steam_id
  order by profiles.created_at desc, profiles.id desc
  limit 1
  for update;

  if found then
    profile_existed := true;
    update public.manual_steam_profiles as profiles
    set
      steam_display_name = trim(p_steam_display_name),
      avatar_url = coalesce(nullif(trim(p_avatar_url), ''), profiles.avatar_url),
      updated_at = now()
    where profiles.id = selected_profile.id
    returning profiles.* into selected_profile;
  else
    created_id := gen_random_uuid();
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
    )
    returning * into selected_profile;
  end if;

  insert into public.manual_profile_sessions (profile_id, token_hash, expires_at)
  values (selected_profile.id, p_token_hash, p_expires_at);

  return query
  select
    selected_profile.id,
    selected_profile.steam_id,
    selected_profile.display_name,
    selected_profile.steam_display_name,
    selected_profile.avatar_url,
    profile_existed;
end;
$function$;

revoke all on function public.create_or_resume_manual_profile_session(
  text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.create_or_resume_manual_profile_session(
  text, text, text, text, text, text, timestamptz
) to service_role;

-- Keep the previous service-role RPC safe during a rolling deployment. Older
-- application instances receive their original result shape while reusing the
-- same atomic implementation.
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
language sql
security definer
set search_path to ''
as $function$
  select result.id, result.steam_id, result.display_name, result.avatar_url
  from public.create_or_resume_manual_profile_session(
    p_steam_id,
    p_profile_url,
    p_display_name,
    p_steam_display_name,
    p_avatar_url,
    p_token_hash,
    p_expires_at
  ) as result;
$function$;

revoke all on function public.create_manual_profile_session(
  text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.create_manual_profile_session(
  text, text, text, text, text, text, timestamptz
) to service_role;
