-- Run in the Supabase SQL editor against production.
-- Rollback: replace_guest_catalogue_pool.rollback-2026-09-15.sql (byte-exact prior definition).
CREATE OR REPLACE FUNCTION public.replace_guest_catalogue_pool(p_appids bigint[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_count integer;
begin
  if p_appids is null or cardinality(p_appids) = 0 then
    raise exception 'EMPTY_GUEST_POOL';
  end if;

  -- `where true` because the authenticator role preloads safeupdate, which rejects
  -- a DELETE with no WHERE clause. Without it this line failed every nightly
  -- steam-tags run from 2026-09-04, and the pool stopped refreshing after
  -- 2026-08-25.
  delete from public.guest_catalogue_pool where true;

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
