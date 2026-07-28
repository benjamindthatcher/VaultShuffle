alter table public.games
  drop constraint if exists games_duration_values_check;

alter table public.games
  add constraint games_duration_values_check
  check (
    coalesce(main_story_minutes, 0) >= 0
    and coalesce(main_extras_minutes, 0) >= 0
    and coalesce(completionist_minutes, 0) >= 0
  );

alter table public.games
  drop column if exists user_estimate_minutes;
