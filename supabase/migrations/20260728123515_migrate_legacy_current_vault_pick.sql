-- Preserve the current Vault pick previously stored in app_settings.
insert into public.user_vault_state (user_id, current_game_id, updated_at)
select s.user_id, s.value::uuid, s.updated_at
from public.app_settings s
join public.games g
  on g.id = s.value::uuid
 and g.user_id = s.user_id
where s.key = 'vault_current_pick_id'
  and s.value ~ '^[0-9a-fA-F-]{36}$'
on conflict (user_id) do update
set current_game_id = excluded.current_game_id,
    updated_at = excluded.updated_at;
