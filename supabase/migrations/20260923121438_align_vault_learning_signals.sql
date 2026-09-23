-- A mobile Play now opens a Steam store page. That is a stronger intention than
-- Save for later, but it does not prove a Steam client launch.
alter table public.vault_draw_events drop constraint vault_draw_events_event_type_check;
alter table public.vault_draw_events add constraint vault_draw_events_event_type_check
  check (event_type = any (array[
    'opened_on_steam', 'play_now_intent', 'pinned', 'unpinned', 'drew_again',
    'hidden_for_session', 'snoozed_7_days', 'snoozed_30_days', 'slept',
    'marked_completed', 'restored', 'liked', 'disliked', 'reroll_too_long',
    'reroll_wrong_mood', 'reroll_played_enough', 'reroll_not_interested',
    'reroll_not_tonight'
  ]));

insert into public.algorithm_weights (key, positive, total, note)
values ('event:play_now_intent', 2.5, 2.5, 'Play now on a device without Steam launching; intent, not confirmed play')
on conflict (key) do nothing;

-- There is no current keep decision source. Playing Next pins are now read from
-- user_game_pins, so decision:pin remains active.
delete from public.algorithm_weights where key = 'decision:keep';
