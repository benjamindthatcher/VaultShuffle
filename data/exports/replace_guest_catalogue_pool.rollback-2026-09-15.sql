-- Byte-exact live definition captured 2026-09-15 before adding `where true` to the delete.
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
$function$
