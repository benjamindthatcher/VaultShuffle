-- Normalize user-specific state and establish the shared catalogue as the
-- canonical Steam AppID identity. This is intentionally additive so it can be
-- deployed without invalidating existing game UUIDs or their foreign keys.

alter table public.games
  add column if not exists catalog_steam_appid bigint;

update public.games
set catalog_steam_appid = steam_appid::bigint
where catalog_steam_appid is null
  and steam_appid ~ '^[1-9][0-9]*$';

insert into public.catalog_games (
  steam_appid,
  name,
  normalized_name,
  genres,
  first_seen_reason,
  first_seen_at,
  last_seen_at,
  metadata_fetched_at
)
select distinct on (g.catalog_steam_appid)
  g.catalog_steam_appid,
  g.title,
  lower(regexp_replace(trim(g.title), '[^a-z0-9]+', ' ', 'gi')),
  case when g.genre in ('', 'Unknown') then '{}'::text[] else array[g.genre] end,
  'user_import',
  coalesce(g.created_at, now()),
  now(),
  now()
from public.games g
where g.catalog_steam_appid is not null
order by g.catalog_steam_appid, g.updated_at desc
on conflict (steam_appid) do nothing;

alter table public.games
  drop constraint if exists games_catalog_steam_appid_fkey;
alter table public.games
  add constraint games_catalog_steam_appid_fkey
  foreign key (catalog_steam_appid)
  references public.catalog_games(steam_appid)
  on delete restrict
  not valid;
alter table public.games validate constraint games_catalog_steam_appid_fkey;

create index if not exists games_user_catalog_appid_idx
  on public.games(user_id, catalog_steam_appid)
  where catalog_steam_appid is not null;

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

drop trigger if exists games_catalog_identity on public.games;
create trigger games_catalog_identity
before insert or update of steam_appid on public.games
for each row execute function public.set_game_catalog_identity();

comment on column public.games.catalog_steam_appid is
  'Canonical shared catalogue identity. User-owned state remains on games; shared metadata belongs on catalog_games.';
comment on column public.games.title is
  'Compatibility snapshot only. New shared metadata reads should use catalog_games through catalog_steam_appid.';
comment on column public.games.genre is
  'Compatibility snapshot only. Canonical genres are stored once on catalog_games.';
comment on column public.games.rating is
  'Compatibility snapshot only. Canonical review data is stored once on catalog_games.';

-- Quarantine and duration are catalogue properties. Stop rewriting every
-- user_game row whenever one shared catalogue record changes.
drop trigger if exists propagate_catalog_duration_to_games on public.catalog_games;
drop trigger if exists propagate_catalog_duration on public.catalog_games;
drop trigger if exists catalog_duration_propagation on public.catalog_games;
drop trigger if exists games_duration_progress on public.games;

drop function if exists public.propagate_catalog_duration();
drop function if exists public.sync_catalog_duration_to_user_games(bigint);
drop function if exists public.calculate_game_duration_progress();

-- Pins use one normalized table for both Library and Wishlist scopes.
alter table public.user_game_pins
  add column if not exists scope text not null default 'library';

alter table public.user_game_pins
  drop constraint if exists user_game_pins_scope_check;
alter table public.user_game_pins
  add constraint user_game_pins_scope_check
  check (scope in ('library', 'wishlist'));

alter table public.user_game_pins
  drop constraint if exists user_game_pins_pkey;
alter table public.user_game_pins
  drop constraint if exists user_game_pins_user_id_slot_key;

alter table public.user_game_pins
  add constraint user_game_pins_pkey primary key (user_id, scope, game_id);
alter table public.user_game_pins
  add constraint user_game_pins_user_scope_slot_key unique (user_id, scope, slot);

drop index if exists public.user_game_pins_user_slot_idx;
create index if not exists user_game_pins_user_scope_slot_idx
  on public.user_game_pins(user_id, scope, slot);

insert into public.user_game_pins (user_id, game_id, scope, slot)
select
  s.user_id,
  value::uuid,
  'wishlist',
  ordinality::smallint
from public.app_settings s
cross join lateral jsonb_array_elements_text(
  case when s.value ~ '^\s*\[' then s.value::jsonb else '[]'::jsonb end
) with ordinality as pinned(value, ordinality)
join public.games g on g.id = value::uuid and g.user_id = s.user_id
where s.key = 'wishlist_pinned_ids'
  and ordinality <= 3
on conflict do nothing;

-- Snoozes and current pick are relational user state, not unbounded JSON blobs.
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
comment on table public.user_game_snoozes is
  'Normalized per-user Vault snooze state. Null snoozed_until means snoozed until explicitly restored.';

insert into public.user_game_snoozes (user_id, game_id)
select s.user_id, value::uuid
from public.app_settings s
cross join lateral jsonb_array_elements_text(
  case when s.value ~ '^\s*\[' then s.value::jsonb else '[]'::jsonb end
) as snoozed(value)
join public.games g on g.id = value::uuid and g.user_id = s.user_id
where s.key = 'vault_snoozed_ids'
on conflict do nothing;

create table if not exists public.user_vault_state (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  current_game_id uuid references public.games(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.user_vault_state enable row level security;
comment on table public.user_vault_state is
  'One bounded row per user for current mutable Vault state.';

insert into public.user_vault_state (user_id, current_game_id, updated_at)
select s.user_id, nullif(trim(s.value), '')::uuid, s.updated_at
from public.app_settings s
join public.games g
  on g.id = nullif(trim(s.value), '')::uuid
 and g.user_id = s.user_id
where s.key = 'vault_current_pick_id'
  and nullif(trim(s.value), '') is not null
on conflict (user_id) do update
set current_game_id = excluded.current_game_id,
    updated_at = excluded.updated_at;

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
    select coalesce(array_agg(game_id order by slot), array[]::uuid[]) into result
    from public.user_game_pins where user_id = p_user_id and scope = p_scope;
    return result;
  end if;
  select candidate::smallint into next_slot
  from generate_series(1, 3) candidate
  where not exists (
    select 1 from public.user_game_pins
    where user_id = p_user_id and scope = p_scope and slot = candidate
  )
  order by candidate limit 1;
  if next_slot is null then
    select slot into replace_slot
    from public.user_game_pins
    where user_id = p_user_id and scope = p_scope and game_id = p_replace_game_id;
    if replace_slot is null then raise exception 'PIN_LIMIT_REACHED'; end if;
    delete from public.user_game_pins
    where user_id = p_user_id and scope = p_scope and game_id = p_replace_game_id;
    next_slot := replace_slot;
  end if;
  insert into public.user_game_pins (user_id, game_id, scope, slot)
  values (p_user_id, p_game_id, p_scope, next_slot);
  select coalesce(array_agg(game_id order by slot), array[]::uuid[]) into result
  from public.user_game_pins where user_id = p_user_id and scope = p_scope;
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
  pinned_times timestamptz[];
begin
  if p_scope not in ('library', 'wishlist') then raise exception 'INVALID_PIN_SCOPE'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_scope, 0));
  delete from public.user_game_pins
  where user_id = p_user_id and scope = p_scope and game_id = p_game_id;
  select coalesce(array_agg(game_id order by slot), array[]::uuid[]),
         coalesce(array_agg(pinned_at order by slot), array[]::timestamptz[])
  into result, pinned_times
  from public.user_game_pins where user_id = p_user_id and scope = p_scope;
  delete from public.user_game_pins where user_id = p_user_id and scope = p_scope;
  insert into public.user_game_pins (user_id, game_id, scope, slot, pinned_at)
  select p_user_id, item.game_id, p_scope, item.ordinality::smallint, pinned_times[item.ordinality]
  from unnest(result) with ordinality as item(game_id, ordinality);
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

alter table public.vault_draws
  drop constraint if exists vault_draws_steam_appid_fkey;
alter table public.vault_draws
  add constraint vault_draws_steam_appid_fkey
  foreign key (steam_appid)
  references public.catalog_games(steam_appid)
  on delete restrict
  not valid;
alter table public.vault_draws validate constraint vault_draws_steam_appid_fkey;

-- These routines are internal and are called with the service role.
revoke all on function public.set_game_catalog_identity() from public, anon, authenticated;
revoke all on function public.pin_scoped_user_game(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.unpin_scoped_user_game(uuid, uuid, text) from public, anon, authenticated;
