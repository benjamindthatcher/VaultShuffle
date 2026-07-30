-- Preserve the exact IGDB identities for games without IGDB timing rows.
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
  (34440, 'igdb-title', 293, null, null, null, null, 'no_duration', 'high', now(), now() + interval '150 days', null, now()),
  (34460, 'igdb-title', 633, null, null, null, null, 'no_duration', 'high', now(), now() + interval '150 days', null, now()),
  (56437, 'igdb-title', 470, null, null, null, null, 'no_duration', 'high', now(), now() + interval '150 days', null, now())
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

-- Exact-title HowLongToBeat fallback matches for the IGDB identities above.
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
  (34440, 'hltb', 8505, 791, 2738, 8010, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (34460, 'hltb', 8506, 1852, 3824, 5185, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (56437, 'hltb', 11045, 543, 860, 2865, null, 'matched', 'high', now(), now() + interval '365 days', null, now())
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

-- The new Soul Land release has no IGDB record yet, but its Steam metadata
-- identifies it as an open-world MMORPG. It is intentionally endless.
update public.catalog_games
set duration_kind = 'endless',
    duration_status = 'ready',
    duration_source = 'classification',
    duration_source_game_id = null,
    duration_source_updated_at = now(),
    duration_confidence = 'high',
    updated_at = now()
where steam_appid = 4584110;

update public.game_duration_aliases
set review_status = 'approved',
    notes = 'No current IGDB record; Steam identifies this release as an open-world MMORPG, so it is classified as endless.',
    updated_at = now()
where steam_app_id = 4584110;

update public.game_duration_jobs
set status = 'completed',
    locked_at = null,
    locked_by = null,
    last_error_code = null,
    last_error_message = null,
    updated_at = now()
where steam_app_id in (34440, 34460, 56437, 4584110);
-- Version aligned with the production Supabase migration history.
