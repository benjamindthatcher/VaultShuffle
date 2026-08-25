-- Keep the direct-IGDB product-token veto synchronized with later Steam name
-- corrections. This AFTER trigger does not acquire the IGDB advisory lock:
-- UPDATE already owns this catalogue row, and taking advisory after row would
-- invert the estimate trigger's advisory-then-catalogue order. Under the
-- current single-row, READ COMMITTED writers, whichever workflow reaches the
-- catalogue row last performs the final reconciliation with a refreshed view.
-- This intentionally does not address unrelated multi-row writer ordering.
create or replace function public.sync_duration_after_catalogue_name_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.reconcile_catalogue_duration(new.steam_appid, false);
  return new;
end;
$$;

drop trigger if exists sync_duration_after_catalogue_name_change_trigger
  on public.catalog_games;

create trigger sync_duration_after_catalogue_name_change_trigger
after update of name on public.catalog_games
for each row
when (old.name is distinct from new.name)
execute function public.sync_duration_after_catalogue_name_change();

revoke all on function public.sync_duration_after_catalogue_name_change()
  from public, anon, authenticated;

comment on function public.sync_duration_after_catalogue_name_change() is
  'Reconciles duration projection after a real catalogue-name change without inverting the IGDB advisory-lock order.';
