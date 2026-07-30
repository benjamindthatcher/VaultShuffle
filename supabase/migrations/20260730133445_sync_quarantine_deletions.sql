-- Keep the per-user visibility flag aligned when an automatic quarantine row
-- is removed. The original trigger only handled inserts and updates, which
-- left previously over-broad exclusions hidden after their review row was
-- deleted.
create or replace function public.sync_game_quarantine_visibility()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if tg_op = 'DELETE' then
    update public.games
    set is_quarantined = false,
        quarantine_reason = null,
        updated_at = now()
    where steam_appid = old.steam_appid::text
      and not exists (
        select 1
        from public.catalog_game_quarantine remaining
        where remaining.steam_appid = old.steam_appid
          and remaining.review_status = 'excluded'
      );

    return old;
  end if;

  update public.games
  set is_quarantined = (new.review_status = 'excluded'),
      quarantine_reason = case
        when new.review_status = 'excluded' then new.reason
        else null
      end,
      updated_at = now()
  where steam_appid = new.steam_appid::text;

  return new;
end;
$$;

drop trigger if exists sync_game_quarantine_visibility_on_delete
  on public.catalog_game_quarantine;
create trigger sync_game_quarantine_visibility_on_delete
after delete
on public.catalog_game_quarantine
for each row execute function public.sync_game_quarantine_visibility();

-- Repair flags left behind by quarantine rows deleted before the delete
-- trigger existed.
update public.games games
set is_quarantined = false,
    quarantine_reason = null,
    updated_at = now()
where games.is_quarantined
  and not exists (
    select 1
    from public.catalog_game_quarantine quarantine
    where quarantine.steam_appid::text = games.steam_appid
      and quarantine.review_status = 'excluded'
  );
-- Version aligned with the production Supabase migration history.
