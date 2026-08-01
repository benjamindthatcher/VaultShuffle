-- Generated from exact-title HowLongToBeat matches. Ambiguous candidates are
-- deliberately excluded and remain in the explicit duration review queue.
insert into public.game_duration_estimates (
  steam_app_id,
  provider,
  provider_game_id,
  main_story_minutes,
  main_extra_minutes,
  completionist_minutes,
  submission_count,
  match_status,
  match_confidence,
  checked_at,
  next_refresh_at,
  last_error_code,
  updated_at
)
values
  (47400, 'hltb', 9280, 420, null, 512, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (116100, 'hltb', 17601, 157, 275, 377, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (233250, 'hltb', 7100, 326, 1114, 2632, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (246680, 'hltb', 27619, 167, 209, 313, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (253130, 'hltb', 15865, 221, null, null, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (259280, 'hltb', 12296, 765, null, 1215, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (307090, 'hltb', 21432, 68, null, null, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (714010, 'hltb', 125667, 316, 880, 1445, null, 'matched', 'high', now(), now() + interval '365 days', null, now())
on conflict (steam_app_id, provider) do update
set provider_game_id = excluded.provider_game_id,
    main_story_minutes = excluded.main_story_minutes,
    main_extra_minutes = excluded.main_extra_minutes,
    completionist_minutes = excluded.completionist_minutes,
    submission_count = excluded.submission_count,
    match_status = excluded.match_status,
    match_confidence = excluded.match_confidence,
    checked_at = excluded.checked_at,
    next_refresh_at = excluded.next_refresh_at,
    last_error_code = excluded.last_error_code,
    updated_at = excluded.updated_at;

update public.game_duration_jobs
set status = 'completed',
    locked_at = null,
    locked_by = null,
    last_error_code = null,
    last_error_message = null,
    updated_at = now()
where steam_app_id in (47400, 116100, 233250, 246680, 253130, 259280, 307090, 714010);
