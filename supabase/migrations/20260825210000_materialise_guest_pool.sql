-- Precompute the guest catalogue instead of building it per request.
--
-- Choosing the pool means scanning and sorting every eligible game in the
-- catalogue, then fetching full rows for the thousand that survive. Behind an
-- hourly cache that is one very slow request an hour - measured at 32 seconds
-- against production - which is a terrible first impression for whichever guest
-- happens to arrive first.
--
-- The selection is deterministic and only changes as the catalogue does, so it
-- belongs in a table that the nightly worker refreshes. At request time this
-- becomes a single indexed read of exactly 1,000 rows.

create table if not exists public.guest_catalogue_pool (
  steam_appid bigint primary key references public.catalog_games (steam_appid) on delete cascade,
  position integer not null,
  refreshed_at timestamptz not null default now()
);

create index if not exists guest_catalogue_pool_position_idx
  on public.guest_catalogue_pool (position);

alter table public.guest_catalogue_pool enable row level security;

-- RLS with no policies, since everything reaches this through the service role.
-- Enabling RLS is not enough on its own: the service role still needs table
-- privileges, and its absence surfaces as a worker dying on "permission denied"
-- rather than anything obviously grant-shaped.
grant select, insert, update, delete, truncate on public.guest_catalogue_pool to service_role;

-- Replaces the pool atomically, so a reader never sees a half-written one.
create or replace function public.replace_guest_catalogue_pool(p_appids bigint[])
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_count integer;
begin
  if p_appids is null or cardinality(p_appids) = 0 then
    raise exception 'EMPTY_GUEST_POOL';
  end if;

  delete from public.guest_catalogue_pool;

  insert into public.guest_catalogue_pool (steam_appid, position)
  select appid, ordinality::integer
  from unnest(p_appids) with ordinality as t(appid, ordinality)
  -- Skip anything that has since left the catalogue rather than failing the
  -- whole refresh over one missing row.
  where exists (select 1 from public.catalog_games c where c.steam_appid = t.appid)
  on conflict (steam_appid) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.replace_guest_catalogue_pool(bigint[]) from public, anon, authenticated;
grant execute on function public.replace_guest_catalogue_pool(bigint[]) to service_role;
