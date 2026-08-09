-- Keep the shared vault state consistent when a game is archived through any
-- server path. The UI mirrors this immediately, while this transaction makes
-- the database authoritative for subsequent loads and other devices.

create or replace function public.set_user_game_status(
  p_user_id uuid,
  p_game_id uuid,
  p_status text
)
returns public.games
language plpgsql
set search_path = ''
as $$
declare
  updated_game public.games;
begin
  if p_status not in ('Not Started', 'Sampled', 'In Progress', 'Slept', 'Completed') then
    raise exception 'INVALID_GAME_STATUS';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  update public.games
  set previous_active_status = case
        when p_status in ('Slept', 'Completed')
          and status not in ('Slept', 'Completed') then status
        when p_status in ('Slept', 'Completed') then
          coalesce(previous_active_status, 'Not Started')
        else previous_active_status
      end,
      status = p_status,
      completed_at = case when p_status = 'Completed' then now() else null end,
      slept_at = case when p_status = 'Slept' then now() else null end,
      updated_at = now()
  where id = p_game_id
    and user_id = p_user_id
  returning * into updated_game;

  if updated_game.id is null then
    raise exception 'GAME_NOT_FOUND';
  end if;

  if p_status in ('Slept', 'Completed') then
    delete from public.user_game_pins
    where user_id = p_user_id
      and game_id = p_game_id
      and scope = 'library';

    update public.user_vault_state
    set current_game_id = null,
        updated_at = now()
    where user_id = p_user_id
      and current_game_id = p_game_id;
  end if;

  return updated_game;
end;
$$;

revoke all on function public.set_user_game_status(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.set_user_game_status(uuid, uuid, text)
to service_role;
