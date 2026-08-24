-- Purge now has one review queue with three outcome views: needs review,
-- reviewed, and no review needed. The old candidate taxonomy was presentation
-- metadata, not durable user state, so it does not belong in the audit log.
alter table public.purge_reviews
  drop constraint if exists purge_reviews_category_check;

alter table public.purge_reviews
  drop column category;

-- Keep the fourth argument temporarily as an ignored optional parameter so the
-- currently deployed API can continue calling this function during rollout.
-- New callers omit it; a later migration can remove it after every deployment
-- uses the category-free contract.
create or replace function public.apply_user_purge_decision(
  p_user_id uuid,
  p_game_id uuid,
  p_action text,
  p_category text default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  target_game public.user_games;
  saved_review public.purge_reviews;
  ignored_state jsonb;
begin
  if p_action not in ('keep', 'pin', 'sleep') then
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
$$;
