create or replace function public.sync_game_quarantine_visibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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

revoke all on function public.sync_game_quarantine_visibility()
  from public, anon, authenticated;
