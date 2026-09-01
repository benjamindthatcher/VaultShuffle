-- Steam Families: games you can play but do not own.
--
-- user_games has always been the ownership table. This generalises it to an
-- ACCESS table, because "what can I play tonight" is the question the product
-- answers and for a lot of accounts the honest answer includes a partner's
-- shelf. Every existing row is 'owned' by default, so nothing about the live
-- library changes until a family member is actually added.
--
-- Two columns, and they earn their place for different reasons:
--
--   access_source           - 'owned' or 'family'. The load-bearing one, and not
--                             for labelling: lib/steam-import-jobs.ts retires
--                             anything missing from Steam's owned-games
--                             response, and family games are never in it, so
--                             without this every refresh would wipe them.
--   family_owner_steam_id   - whose library it came from, so a card can say
--                             "Shared from Sam's library" rather than showing an
--                             unexplained icon.
--
-- Playtime deliberately has no column. A family game's hours belong to whoever
-- owns it and are never copied across, so hours_played stays 0 and access_source
-- is what tells the application that the 0 means "never told" rather than "never
-- played". One fact, stored once - see lib/family-sharing.ts.
--
-- Deliberately NOT done here: rewriting upsert_user_steam_games. Production has
-- drifted from this folder, so promoting a family row to owned when someone
-- actually buys the game is handled in lib/family-games.ts instead of by
-- replacing a live function this file cannot be sure it matches.

alter table public.user_games
  add column if not exists access_source text not null default 'owned',
  add column if not exists family_owner_steam_id text,
  add column if not exists family_verified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_games_access_source_check'
  ) then
    alter table public.user_games
      add constraint user_games_access_source_check
      check (access_source in ('owned', 'family'));
  end if;
end
$$;

-- Family rows are a small slice of any library, and every query that wants them
-- wants them per account. Partial, so the index stays tiny.
create index if not exists user_games_family_access_idx
  on public.user_games (user_id, access_source)
  where access_source <> 'owned';


-- The people whose shelves this account is allowed to read.
--
-- candidate_appids stores each member's whole public library so a re-check costs
-- no Steam call. That matters because the interesting case is exactly the one
-- that needs re-checking: a game the catalogue had not fetched categories for
-- yet, which cannot be judged shareable until it has.
create table if not exists public.user_family_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_accounts (id) on delete cascade,
  steam_id text not null,
  display_name text not null default 'Steam player',
  avatar_url text,
  profile_url text,
  candidate_appids bigint[] not null default '{}',
  library_seen integer not null default 0,
  games_imported integer not null default 0,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_family_members_steam_id_check check (steam_id ~ '^[0-9]{17}$'),
  constraint user_family_members_unique unique (user_id, steam_id)
);

create index if not exists user_family_members_user_idx
  on public.user_family_members (user_id);

-- Steam Families holds six accounts and one of them is the player. Enforced in
-- the database as well as the API so this can never become a way to merge
-- arbitrary strangers' libraries into one shelf.
create or replace function public.enforce_family_member_limit()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if (select count(*) from public.user_family_members where user_id = new.user_id) >= 5 then
    raise exception 'FAMILY_MEMBER_LIMIT_REACHED';
  end if;
  return new;
end;
$function$;

drop trigger if exists user_family_members_limit on public.user_family_members;
create trigger user_family_members_limit
  before insert on public.user_family_members
  for each row execute function public.enforce_family_member_limit();

alter table public.user_family_members enable row level security;
revoke all on public.user_family_members from anon, authenticated;
grant select, insert, update, delete on public.user_family_members to service_role;


-- Write family access without ever touching what the player owns.
--
-- Two rules, in order of how badly breaking them would hurt:
--   1. An 'owned' row is never modified. Owning beats sharing, always.
--   2. Player state (status, notes, priority, progress) survives every re-sync.
--      Access is what this function owns; the player owns everything else. A
--      game that has been on the family shelf for a month may have been slept,
--      noted, pinned or filed in a collection, and re-checking availability is
--      not a reason to lose any of it.
create or replace function public.upsert_user_family_games(
  p_user_id uuid,
  p_games jsonb
)
returns setof public.user_games
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_user_id is null or not exists (
    select 1 from public.app_accounts where id = p_user_id
  ) then
    raise exception 'INVALID_IMPORT_USER';
  end if;

  if p_games is null or jsonb_typeof(p_games) <> 'array' then
    raise exception 'INVALID_IMPORT_PAYLOAD';
  end if;

  if jsonb_array_length(p_games) > 500 then
    raise exception 'IMPORT_BATCH_TOO_LARGE';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_games) as input(steam_appid text)
    where input.steam_appid is null
       or input.steam_appid !~ '^[1-9][0-9]*$'
  ) then
    raise exception 'INVALID_IMPORT_GAME';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_games) as input(steam_appid text)
    left join public.catalog_games catalog
      on catalog.steam_appid = input.steam_appid::bigint
    where catalog.steam_appid is null
  ) then
    raise exception 'MISSING_CATALOG_GAME';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  return query
  insert into public.user_games (
    user_id,
    catalog_steam_appid,
    ownership,
    status,
    rating,
    hours_played,
    completion_percentage,
    priority,
    date_added,
    notes,
    access_source,
    family_owner_steam_id,
    family_verified_at
  )
  select
    p_user_id,
    catalog.steam_appid,
    -- 'Owned' here means "on the shelf", which is what every read model filters
    -- on. What the player actually paid for is access_source, and that is what
    -- the money and value figures read.
    'Owned',
    'Not Started',
    0,
    -- Never the owner's hours. Zero plus access_source = 'family' is how the
    -- application knows it has not been told rather than being told zero.
    0,
    0,
    'Medium',
    to_char(now(), 'DD/MM/YYYY'),
    '',
    'family',
    input.family_owner_steam_id,
    now()
  from jsonb_to_recordset(p_games) as input(
    steam_appid text,
    family_owner_steam_id text
  )
  join public.catalog_games catalog
    on catalog.steam_appid = input.steam_appid::bigint
  on conflict (user_id, catalog_steam_appid) do update set
    access_source = case
      when public.user_games.access_source = 'owned' then 'owned'
      else 'family'
    end,
    family_owner_steam_id = case
      when public.user_games.access_source = 'owned' then public.user_games.family_owner_steam_id
      else coalesce(excluded.family_owner_steam_id, public.user_games.family_owner_steam_id)
    end,
    family_verified_at = case
      when public.user_games.access_source = 'owned' then public.user_games.family_verified_at
      else now()
    end,
    ownership = case
      when public.user_games.access_source = 'owned' then public.user_games.ownership
      else 'Owned'
    end,
    updated_at = now()
  returning public.user_games.*;
end;
$function$;

revoke all on function public.upsert_user_family_games(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_user_family_games(uuid, jsonb) to service_role;


-- Losing access is not the same as deleting history.
--
-- When a member is removed, their shared games go - the player never owned them
-- and there is nothing to keep them for. Rows another remaining member also
-- provides are kept, which is why this deletes by owner rather than wholesale.
-- Anything the player actually engaged with (a note, a Completed or Slept
-- status) is retired instead of deleted, so their own record of having played
-- something survives losing the ability to play it.
create or replace function public.remove_user_family_member_games(
  p_user_id uuid,
  p_steam_id text,
  p_retained_appids bigint[] default '{}'
)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  removed integer;
begin
  if p_user_id is null then
    raise exception 'INVALID_IMPORT_USER';
  end if;

  update public.user_games
  set ownership = 'Wishlist',
      family_verified_at = null,
      updated_at = now()
  where user_id = p_user_id
    and access_source = 'family'
    and family_owner_steam_id = p_steam_id
    and not (catalog_steam_appid = any(coalesce(p_retained_appids, '{}')))
    and (
      coalesce(notes, '') <> ''
      or status in ('Completed', 'Slept')
    );

  with deleted as (
    delete from public.user_games
    where user_id = p_user_id
      and access_source = 'family'
      and family_owner_steam_id = p_steam_id
      and not (catalog_steam_appid = any(coalesce(p_retained_appids, '{}')))
      and ownership = 'Owned'
    returning 1
  )
  select count(*) into removed from deleted;

  return coalesce(removed, 0);
end;
$function$;

revoke all on function public.remove_user_family_member_games(uuid, text, bigint[]) from public, anon, authenticated;
grant execute on function public.remove_user_family_member_games(uuid, text, bigint[]) to service_role;


-- Appended at the end because CREATE OR REPLACE VIEW may only add columns after
-- the existing ones, never reorder them. Everything above the family columns is
-- unchanged from 20260901165500_expose_steam_categories.sql.
create or replace view public.user_games_with_catalog as
 SELECT g.id,
    g.user_id,
    c.name AS title,
        CASE
            WHEN cardinality(c.genres) > 0 THEN array_to_string(c.genres, ' / '::text)
            ELSE 'Unknown'::text
        END AS genre,
    'Steam'::text AS store,
    g.ownership,
    g.status,
        CASE
            WHEN COALESCE(c.review_total, 0) > 0 THEN round(c.review_positive::numeric * 10.0 / c.review_total::numeric)::integer
            ELSE g.rating
        END AS rating,
    g.hours_played,
    g.completion_percentage,
    g.priority,
    g.date_added,
    g.notes,
    c.steam_appid::text AS steam_appid,
    g.created_at,
    g.updated_at,
    g.last_played_at,
    g.completed_at,
    g.slept_at,
    g.completion_suggestion_dismissed_at,
    g.completion_suggestion_dismissed_playtime,
    c.main_story_minutes,
    c.main_extras_minutes,
    c.completionist_minutes,
    c.duration_source,
    c.duration_source_updated_at,
    c.duration_confidence,
    g.previous_active_status,
    q.steam_appid IS NOT NULL AS is_quarantined,
    q.reason AS quarantine_reason,
    c.steam_appid AS catalog_steam_appid,
    c.capsule_url,
    c.header_url,
    c.price_currency,
    c.price_initial,
    c.price_final,
    c.discount_percent,
    c.is_free,
    c.duration_kind,
    c.tags AS steam_tags,
    c.platform_windows,
    c.platform_mac,
    c.platform_linux,
    c.deck_compatibility,
    c.review_positive,
    c.review_negative,
    c.review_total,
    c.release_date,
    c.duration_status,
    c.tags_status,
    c.short_description,
    g.last_observed_played_at,
    g.recency_source,
    g.recency_evidence_at,
    g.observed_playtime_minutes,
    g.review_requested_at,
    c.categories AS steam_categories,
    g.access_source,
    g.family_owner_steam_id,
    g.family_verified_at
   FROM user_games g
     JOIN catalog_games c ON c.steam_appid = g.catalog_steam_appid
     LEFT JOIN catalog_game_quarantine q ON q.steam_appid = c.steam_appid AND q.review_status = 'excluded'::text;
