-- Purge can mark a game completed.
--
-- Everything around this action already existed: purge_reviews accepts
-- 'complete' in its check constraint, undo_user_purge_decision reverses it
-- through restore_user_game_active, and the dedup query below recognises a
-- completed game as already answered. The apply branch was the only missing
-- piece, so the action was rejected as INVALID_PURGE_ACTION before reaching it.
--
-- Replacing the function rather than altering it: this is the definition
-- currently live, with the guard widened and one branch added.

CREATE OR REPLACE FUNCTION public.apply_user_purge_decision(p_user_id uuid, p_game_id uuid, p_action text, p_category text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  target_game public.user_games;
  saved_review public.purge_reviews;
  ignored_state jsonb;
begin
  if p_action not in ('keep', 'pin', 'sleep', 'complete') then
    raise exception 'INVALID_PURGE_ACTION';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select *
  into target_game
  from public.user_games
  where id = p_game_id
    and user_id = p_user_id
    and ownership = 'Owned'
  for update;

  if target_game.id is null then
    raise exception 'GAME_NOT_REVIEWABLE';
  end if;

  select *
  into saved_review
  from public.purge_reviews
  where user_id = p_user_id
    and game_id = p_game_id
    and (
      reviewed_at >= now() - interval '30 seconds'
      or (
        action = 'keep'
        and target_game.status in ('Not Started', 'Sampled', 'In Progress')
        and reviewed_at >= now() - interval '180 days'
      )
      or (
        action = 'sleep'
        and target_game.status = 'Slept'
      )
      or (
        action = 'complete'
        and target_game.status = 'Completed'
      )
      or (
        action = 'pin'
        and exists (
          select 1
          from public.user_game_pins
          where user_id = p_user_id
            and game_id = p_game_id
        )
      )
    )
  order by reviewed_at desc
  limit 1;

  if saved_review.id is not null then
    return jsonb_build_object(
      'review', jsonb_build_object(
        'id', saved_review.id,
        'gameId', saved_review.game_id,
        'action', saved_review.action,
        'reviewedAt', saved_review.reviewed_at
      ),
      'deduplicated', true,
      'reconciled', true
    );
  end if;

  if target_game.status not in ('Not Started', 'Sampled', 'In Progress') then
    raise exception 'GAME_NOT_REVIEWABLE';
  end if;

  if p_action = 'pin' then
    ignored_state := public.apply_user_vault_action(
      p_user_id,
      'pinned',
      p_game_id,
      '{}'::jsonb
    );
  elsif p_action = 'sleep' then
    target_game := public.set_user_game_status(p_user_id, p_game_id, 'Slept');
  elsif p_action = 'complete' then
    -- set_user_game_status stamps completed_at, keeps previous_active_status so
    -- undo can put it back, and drops any library pin. undo_user_purge_decision
    -- already reverses 'complete' through restore_user_game_active; this branch
    -- was the only part missing.
    target_game := public.set_user_game_status(p_user_id, p_game_id, 'Completed');
  end if;

  insert into public.purge_reviews (
    user_id,
    game_id,
    action,
    playtime_minutes_at_review,
    progress_at_review,
    last_played_at_review
  )
  values (
    p_user_id,
    p_game_id,
    p_action,
    greatest(0, round(target_game.hours_played * 60)::integer),
    target_game.completion_percentage,
    target_game.last_played_at
  )
  returning * into saved_review;

  return jsonb_build_object(
    'review', jsonb_build_object(
      'id', saved_review.id,
      'gameId', saved_review.game_id,
      'action', saved_review.action,
      'reviewedAt', saved_review.reviewed_at
    ),
    'deduplicated', false,
    'reconciled', false
  );
end;
$function$
;
