-- Human-reviewed title variants from the HLTB fallback report. Similar-looking
-- but distinct games (for example bit Dungeon II vs III) remain unaccepted.
insert into public.game_duration_aliases (
  steam_app_id,
  search_title,
  review_status,
  notes,
  updated_at
)
values
  (32800, 'The Lord of the Rings: War in the North', 'approved', 'Canonical HLTB article-prefix variant.', now()),
  (33930, 'ARMA II: Operation Arrowhead', 'approved', 'Canonical HLTB Roman-numeral variant.', now()),
  (253900, 'Knights and Merchants: Historical Version', 'approved', 'Canonical HLTB release title.', now()),
  (261110, 'Killer Is Dead', 'approved', 'Nightmare Edition uses the base game duration.', now()),
  (344910, 'Sun Blast', 'approved', 'Steam subtitle variant of the HLTB release.', now()),
  (397500, 'Labyronia 2', 'approved', 'Canonical HLTB title variant.', now()),
  (495420, 'State of Decay 2', 'approved', 'Juggernaut Edition uses the base game duration.', now()),
  (518790, 'The Hunter: Call of the Wild', 'approved', 'Canonical HLTB spacing variant.', now()),
  (629730, 'Blade & Sorcery', 'approved', 'Canonical HLTB ampersand variant.', now()),
  (2420510, 'HoloCure', 'approved', 'Steam subtitle variant of the HLTB release.', now())
on conflict (steam_app_id) do update
set search_title = excluded.search_title,
    review_status = excluded.review_status,
    notes = excluded.notes,
    updated_at = excluded.updated_at;

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
  (32800, 'hltb', null, 727, 940, 1759, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (33930, 'hltb', null, 487, 502, 1394, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (253900, 'hltb', null, 2400, null, 3363, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (261110, 'hltb', null, 430, 636, 1536, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (344910, 'hltb', null, 75, null, null, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (397500, 'hltb', null, null, 852, 1080, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (495420, 'hltb', null, 968, 1957, 8291, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (518790, 'hltb', null, 1475, 4995, 13692, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (629730, 'hltb', null, 578, 1265, 3332, null, 'matched', 'high', now(), now() + interval '365 days', null, now()),
  (2420510, 'hltb', null, 414, 1582, 7821, null, 'matched', 'high', now(), now() + interval '365 days', null, now())
on conflict (steam_app_id, provider) do update
set provider_game_id = coalesce(excluded.provider_game_id, public.game_duration_estimates.provider_game_id),
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
where steam_app_id in (32800, 33930, 253900, 261110, 344910, 397500, 495420, 518790, 629730, 2420510);
-- Version aligned with the production Supabase migration history.
