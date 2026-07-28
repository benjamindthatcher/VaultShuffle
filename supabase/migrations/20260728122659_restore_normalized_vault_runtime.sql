-- Additive runtime recovery for the normalized Vault state rollout.
-- This migration deliberately avoids replacing existing pin constraints; the
-- constraint conversion is completed by the subsequent normalization migration.

alter table public.games
  add column if not exists catalog_steam_appid bigint;

update public.games
set catalog_steam_appid = steam_appid::bigint
where catalog_steam_appid is null
  and steam_appid ~ '^[1-9][0-9]*$';

create index if not exists games_user_catalog_appid_idx
  on public.games(user_id, catalog_steam_appid)
  where catalog_steam_appid is not null;

alter table public.user_game_pins
  add column if not exists scope text not null default 'library';

create index if not exists user_game_pins_user_scope_idx
  on public.user_game_pins(user_id, scope, slot);

create table if not exists public.user_game_snoozes (
  user_id uuid not null references public.app_users(id) on delete cascade,
  game_id uuid not null references public.games(id) on delete cascade,
  snoozed_at timestamptz not null default now(),
  snoozed_until timestamptz,
  primary key (user_id, game_id)
);

create index if not exists user_game_snoozes_expiry_idx
  on public.user_game_snoozes(snoozed_until)
  where snoozed_until is not null;

alter table public.user_game_snoozes enable row level security;

create table if not exists public.user_vault_state (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  current_game_id uuid references public.games(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.user_vault_state enable row level security;

create or replace function public.set_game_catalog_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.catalog_steam_appid := case
    when new.steam_appid ~ '^[1-9][0-9]*$' then new.steam_appid::bigint
    else null
  end;
  return new;
end;
$$;

create or replace function public.pin_scoped_user_game(
  p_user_id uuid,
  p_game_id uuid,
  p_scope text default 'library',
  p_replace_game_id uuid default null
)
returns uuid[]
language plpgsql
set search_path = ''
as $$
declare
  next_slot smallint;
  replace_slot smallint;
  result uuid[];
begin
  if p_scope not in ('library', 'wishlist') then
    raise exception 'INVALID_PIN_SCOPE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_scope, 0));
  if not exists (
    select 1
    from public.games
    where id = p_game_id
      and user_id = p_user_id
      and (
        (p_scope = 'library' and ownership = 'Owned' and status in ('Not Started', 'Sampled', 'In Progress'))
        or (p_scope = 'wishlist' and ownership = 'Wishlist')
      )
  ) then
    raise exception 'GAME_NOT_PINNABLE';
  end if;
  if exists (
    select 1 from public.user_game_pins
    where user_id = p_user_id and scope = p_scope and game_id = p_game_id
  ) then
    select coalesce(array_agg(game_id order by slot), array[]::uuid[])
    into result
    from public.user_game_pins
    where user_id = p_user_id and scope = p_scope;
    return result;
  end if;
  select candidate::smallint
  into next_slot
  from generate_series(1, 3) candidate
  where not exists (
    select 1 from public.user_game_pins
    where user_id = p_user_id and scope = p_scope and slot = candidate
  )
  order by candidate
  limit 1;
  if next_slot is null then
    select slot
    into replace_slot
    from public.user_game_pins
    where user_id = p_user_id and scope = p_scope and game_id = p_replace_game_id;
    if replace_slot is null then
      raise exception 'PIN_LIMIT_REACHED';
    end if;
    delete from public.user_game_pins
    where user_id = p_user_id and scope = p_scope and game_id = p_replace_game_id;
    next_slot := replace_slot;
  end if;
  insert into public.user_game_pins (user_id, game_id, scope, slot)
  values (p_user_id, p_game_id, p_scope, next_slot);
  select coalesce(array_agg(game_id order by slot), array[]::uuid[])
  into result
  from public.user_game_pins
  where user_id = p_user_id and scope = p_scope;
  return result;
end;
$$;

create or replace function public.unpin_scoped_user_game(
  p_user_id uuid,
  p_game_id uuid,
  p_scope text default 'library'
)
returns uuid[]
language plpgsql
set search_path = ''
as $$
declare
  result uuid[];
begin
  if p_scope not in ('library', 'wishlist') then
    raise exception 'INVALID_PIN_SCOPE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_scope, 0));
  delete from public.user_game_pins
  where user_id = p_user_id and scope = p_scope and game_id = p_game_id;
  select coalesce(array_agg(game_id order by slot), array[]::uuid[])
  into result
  from public.user_game_pins
  where user_id = p_user_id and scope = p_scope;
  return result;
end;
$$;

create or replace function public.pin_user_game(
  p_user_id uuid,
  p_game_id uuid,
  p_replace_game_id uuid default null
)
returns uuid[]
language sql
set search_path = ''
as $$
  select public.pin_scoped_user_game(p_user_id, p_game_id, 'library', p_replace_game_id);
$$;

create or replace function public.unpin_user_game(
  p_user_id uuid,
  p_game_id uuid
)
returns uuid[]
language sql
set search_path = ''
as $$
  select public.unpin_scoped_user_game(p_user_id, p_game_id, 'library');
$$;

revoke all on function public.set_game_catalog_identity() from public, anon, authenticated;
revoke all on function public.pin_scoped_user_game(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.unpin_scoped_user_game(uuid, uuid, text) from public, anon, authenticated;
