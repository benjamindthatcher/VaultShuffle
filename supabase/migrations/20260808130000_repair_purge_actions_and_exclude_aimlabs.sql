-- Repair Purge mutations after the scoped pin RPCs were locked down without
-- restoring service-role access. Keep all browser roles denied; these RPCs are
-- called only by authenticated server routes after ownership checks.

revoke all on function public.pin_scoped_user_game(uuid, uuid, text, uuid)
from public, anon, authenticated;
revoke all on function public.unpin_scoped_user_game(uuid, uuid, text)
from public, anon, authenticated;

grant execute on function public.pin_scoped_user_game(uuid, uuid, text, uuid)
to service_role;
grant execute on function public.unpin_scoped_user_game(uuid, uuid, text)
to service_role;

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
  end if;

  return updated_game;
end;
$$;

create or replace function public.restore_user_game_active(
  p_user_id uuid,
  p_game_id uuid
)
returns public.games
language plpgsql
set search_path = ''
as $$
declare
  updated_game public.games;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  update public.games
  set status = coalesce(previous_active_status, 'Not Started'),
      completed_at = null,
      slept_at = null,
      previous_active_status = null,
      updated_at = now()
  where id = p_game_id
    and user_id = p_user_id
    and status in ('Slept', 'Completed')
  returning * into updated_game;

  if updated_game.id is null then
    raise exception 'GAME_NOT_ARCHIVED';
  end if;

  return updated_game;
end;
$$;

revoke all on function public.set_user_game_status(uuid, uuid, text)
from public, anon, authenticated;
revoke all on function public.restore_user_game_active(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.set_user_game_status(uuid, uuid, text)
to service_role;
grant execute on function public.restore_user_game_active(uuid, uuid)
to service_role;

-- Aimlabs is an aim-training utility rather than a playable library title.
-- Keep it in the reviewable quarantine rather than deleting shared metadata.
insert into public.catalog_game_quarantine (
  steam_appid,
  name,
  steam_type,
  matched_rule,
  reason,
  review_status,
  source,
  review_notes,
  reviewed_at,
  last_detected_at,
  updated_at
)
values (
  714010,
  'Aimlabs',
  'game',
  'manual_appid:714010',
  'FPS aim-training utility; excluded from game recommendation and review surfaces.',
  'excluded',
  'manual',
  'Manually confirmed as an aim trainer rather than a game.',
  now(),
  now(),
  now()
)
on conflict (steam_appid) do update
set name = excluded.name,
    steam_type = excluded.steam_type,
    matched_rule = excluded.matched_rule,
    reason = excluded.reason,
    review_status = 'excluded',
    source = 'manual',
    review_notes = excluded.review_notes,
    reviewed_at = now(),
    last_detected_at = now(),
    updated_at = now();
